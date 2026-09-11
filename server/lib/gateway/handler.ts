import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { authenticateGatewayKey } from '../auth'
import { getConfig } from '../config'
import { decryptSecret } from '../crypto'
import { getRedis } from '../redis'
import { getSettings } from '../settings'
import { enqueueAccountRefresh } from '../queues'
import { insertRequestLog } from '../logs'
import { publishUpdate } from '../events'
import { extractAffinity } from './affinity'
import { gatewayCors } from './cors'
import { listCandidates, listGatewayModels, touchAccount, recordFailure, recordModelAllowed } from './accounts'
import { acquireLease, releaseLease, renewLease, RENEW_INTERVAL_MS, type Lease } from './scheduler'
import { classifyFailure, type UpstreamFailure } from './errors'
import { ResponseCapture, ResponseInspection, MAX_RESPONSE_LOG_BYTES } from './response'
import { makeKernelHeaders, readJsonBodyLimited, writeWithBackpressure } from './transport'

type Protocol = 'chat/completions' | 'messages' | 'responses'
const PROTOCOLS: Protocol[] = ['chat/completions', 'messages', 'responses']
const MAX_ATTEMPTS = 2
const UPSTREAM_IDLE_MS = 120_000

function gatewayError(event: H3Event, protocol: string, status: number, code: string, message: string, retryAfter?: number) {
  const res = event.node.res
  if (res.destroyed || res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (retryAfter !== undefined) res.setHeader('retry-after', String(retryAfter))
  const error = protocol === 'messages'
    ? { type: 'error', error: { type: code, message } }
    : { error: { type: code, code, message } }
  res.end(JSON.stringify(error))
}
function copyResponseHeaders(event: H3Event, upstream: Response) {
  const res = event.node.res
  res.statusCode = upstream.status
  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-accel-buffering', 'no')
  const retryAfter = upstream.headers.get('retry-after')
  if (retryAfter) res.setHeader('retry-after', retryAfter)
}
function startRenewal(lease: Lease, controller: AbortController, onLost: () => void) {
  let busy = false
  let stopped = false
  const timer = setInterval(async () => {
    if (busy || stopped || controller.signal.aborted) return
    busy = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const renewed = await Promise.race([
        renewLease(getRedis(), lease),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Lease renewal timed out')), 5000) }),
      ])
      if (!renewed) throw new Error('Concurrency lease expired')
    } catch {
      if (!stopped) { onLost(); controller.abort(new Error('Concurrency lease could not be renewed')) }
    } finally {
      if (timeout) clearTimeout(timeout)
      busy = false
    }
  }, RENEW_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}

export async function handleGateway(event: H3Event) {
  const pathname = getRequestURL(event).pathname
  const method = event.node.req.method || 'GET'
  const cors = gatewayCors(pathname, method, event.node.req.headers['access-control-request-headers'])
  if (cors) {
    for (const [name, value] of Object.entries(cors.headers)) event.node.res.setHeader(name, value)
    if (cors.preflight) {
      event.node.res.statusCode = 204
      event.node.res.end()
      return
    }
  }
  const path = pathname.replace(/^\/v1\//, '').replace(/\/$/, '')
  if (!(path === 'models' && method === 'GET') && !(PROTOCOLS.includes(path as Protocol) && method === 'POST')) {
    gatewayError(event, path, 404, 'not_found', 'Supported routes: GET /v1/models and POST /v1/chat/completions, /v1/messages, /v1/responses')
    return
  }
  const auth = event.node.req.headers.authorization
  const bearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : null
  const xKey = event.node.req.headers['x-api-key']
  const secret = bearer || (typeof xKey === 'string' ? xKey : null)
  const key = secret ? await authenticateGatewayKey(secret) : null
  if (!key) {
    gatewayError(event, path, 401, 'authentication_error', 'A valid manager API key is required')
    return
  }
  if (path === 'models') return listGatewayModels()

  const protocol = path as Protocol
  const settings = await getSettings()
  let body: Record<string, unknown>
  try { body = await readJsonBodyLimited(event, settings.maxRequestBodyMb * 1024 * 1024) }
  catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode) || 400
    gatewayError(event, protocol, status, 'invalid_request_error', status === 413 ? 'Request body exceeds the configured limit' : 'Request body must be a JSON object')
    return
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model || model.length > 256) {
    gatewayError(event, protocol, 400, 'invalid_request_error', 'model must be a non-empty string of at most 256 characters')
    return
  }
  body.model = model
  const streaming = body.stream === true
  const affinity = extractAffinity({ headers: event.node.req.headers, body, keyId: key.id })
  const requestId = randomUUID()
  event.node.res.setHeader('x-request-id', requestId)
  const controller = new AbortController()
  let disconnected = false
  let leaseLost = false
  const onClose = () => {
    if (!event.node.res.writableEnded) {
      disconnected = true
      controller.abort(new Error('Client disconnected'))
    }
  }
  event.node.res.once('close', onClose)
  const startedAt = Date.now()
  const attempted = new Set<string>()
  let accountId: string | null = null
  let capture = new ResponseCapture()
  let inspection = new ResponseInspection()
  let httpStatus: number | null = null
  let status: 'success' | 'error' | 'cancelled' | 'incomplete' = 'error'
  let errorMessage: string | null = null
  let upstreamFailure: UpstreamFailure | null = null

  try {
    const allCandidates = await listCandidates(model)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (controller.signal.aborted) throw controller.signal.reason
      const candidates = allCandidates.filter(candidate => !attempted.has(candidate.id))
      const result = await acquireLease(getRedis(), {
        candidates, globalLimit: settings.globalConcurrency,
        affinityHash: affinity.affinityHash, affinityTtlSeconds: settings.affinityTtlSeconds,
      })
      if (!result.ok) {
        httpStatus = result.reason === 'no_accounts' ? 503 : 429
        errorMessage = result.reason === 'no_accounts'
          ? 'No enabled account with usable credentials, quota and model access is currently available'
          : result.reason === 'global_capacity' ? 'Gateway global concurrency is full' : 'All eligible accounts are busy or temporarily cooling down'
        gatewayError(event, protocol, httpStatus, result.reason === 'no_accounts' ? 'no_available_accounts' : 'gateway_capacity', errorMessage, 5)
        return
      }
      const lease = result.lease
      accountId = lease.accountId
      attempted.add(accountId)
      const account = candidates.find(candidate => candidate.id === accountId)!
      const stopRenewal = startRenewal(lease, controller, () => { leaseLost = true })
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(new Error('Upstream idle timeout')), UPSTREAM_IDLE_MS)
        idleTimer.unref()
      }
      try {
        capture = new ResponseCapture()
        inspection = new ResponseInspection()
        upstreamFailure = null
        await touchAccount(accountId)
        const upstreamKey = decryptSecret(account.apiKeyCiphertext)
        resetIdle()
        const upstream = await fetch(getConfig().kernelUrl.replace(/\/$/, '') + '/v1/' + protocol, {
          method: 'POST', headers: makeKernelHeaders(event.node.req.headers, upstreamKey),
          body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
        })
        resetIdle()
        httpStatus = upstream.status
        if (!upstream.body) throw new Error('Upstream response has no body')
        reader = upstream.body.getReader()
        const pendingError: Uint8Array[] = []
        let pendingErrorBytes = 0
        let responseStarted = false
        while (true) {
          const next = await reader.read()
          if (controller.signal.aborted) throw controller.signal.reason
          if (next.done) break
          resetIdle()
          capture.push(next.value)
          if (upstream.ok && streaming) inspection.push(next.value)
          if (!upstream.ok && !responseStarted && pendingErrorBytes + next.value.byteLength <= MAX_RESPONSE_LOG_BYTES) {
            pendingError.push(next.value)
            pendingErrorBytes += next.value.byteLength
            continue
          }
          if (!responseStarted) {
            copyResponseHeaders(event, upstream)
            responseStarted = true
            for (const chunk of pendingError) await writeWithBackpressure(event.node.res, chunk, controller.signal)
            pendingError.length = 0
          }
          await writeWithBackpressure(event.node.res, next.value, controller.signal)
        }
        if (!upstream.ok) {
          upstreamFailure = classifyFailure(upstream.status, capture.truncated ? capture.text() : capture.value(false))
          // A stream is never replayed, and an ambiguous error is never retried.
          // A retry requires an explicit rejection and zero bytes sent downstream.
          await recordFailure(accountId, model, upstreamFailure).catch(error => console.error('[gateway] Model/error observation could not be saved', error instanceof Error ? error.message : 'Storage unavailable'))
          if (!streaming && !responseStarted && !capture.truncated && upstreamFailure.safeToRetry &&
              attempt + 1 < MAX_ATTEMPTS && candidates.some(candidate => candidate.id !== accountId)) continue
          if (!responseStarted) {
            copyResponseHeaders(event, upstream)
            for (const chunk of pendingError) await writeWithBackpressure(event.node.res, chunk, controller.signal)
          }
          errorMessage = upstreamFailure.message.replaceAll(upstreamKey, '[redacted]')
          status = 'error'
        } else {
          if (streaming) inspection.end()
          else if (!capture.truncated) inspection.observe(capture.value(false), upstream.status)
          if (inspection.failure) {
            upstreamFailure = inspection.failure
            await recordFailure(accountId, model, upstreamFailure).catch(error => console.error('[gateway] Model/error observation could not be saved', error instanceof Error ? error.message : 'Storage unavailable'))
            errorMessage = upstreamFailure.message.replaceAll(upstreamKey, '[redacted]')
            status = 'error'
          } else if (inspection.incomplete || !inspection.hasOutput || (streaming && !inspection.completed)) {
            status = 'incomplete'
            errorMessage = inspection.incomplete ? 'Upstream reported an incomplete response'
              : capture.truncated && !streaming ? 'Response exceeded log limit; completion details could not be inspected'
              : !inspection.hasOutput ? 'No model output was observed' : 'Upstream stream ended without a completion event'
          } else {
            status = 'success'
          }
          if (inspection.hasOutput && !inspection.failure) await recordModelAllowed(accountId, model).catch(error => console.error('[gateway] Model access observation could not be saved', error instanceof Error ? error.message : 'Storage unavailable'))
          if (!responseStarted) copyResponseHeaders(event, upstream)
        }
        if (!event.node.res.writableEnded) event.node.res.end()
        break
      } finally {
        stopRenewal()
        if (idleTimer) clearTimeout(idleTimer)
        if (reader) {
          try { await reader.cancel() } catch { /* Request may have already ended. */ }
        }
        try { await releaseLease(getRedis(), lease) }
        catch (error) { console.error('[gateway] Lease release failed; its TTL will reclaim it', error instanceof Error ? error.message : 'Redis unavailable') }
        try { await enqueueAccountRefresh(account.id, { reason: 'request', force: false }) }
        catch (error) { console.error('[gateway] Account refresh could not be queued', error instanceof Error ? error.message : 'Queue unavailable') }
      }
    }
  } catch (error) {
    status = disconnected && !leaseLost ? 'cancelled' : 'error'
    errorMessage = error instanceof Error ? error.message : 'Gateway request failed'
    if (leaseLost) errorMessage = 'Concurrency lease renewal failed; upstream request was cancelled'
    if (!controller.signal.aborted) controller.abort(error)
    if (!event.node.res.headersSent && !disconnected) {
      httpStatus = /timeout/i.test(errorMessage) ? 504 : 502
      gatewayError(event, protocol, httpStatus, 'gateway_upstream_error', errorMessage)
    } else if (!event.node.res.writableEnded && !event.node.res.destroyed) {
      event.node.res.destroy()
    }
  } finally {
    event.node.res.off('close', onClose)
    try {
      await insertRequestLog({
        id: requestId, keyId: key.id, accountId, model, protocol, sessionId: affinity.sessionId,
        status, httpStatus, durationMs: Date.now() - startedAt, streaming,
        usage: inspection.usage, errorMessage, requestBody: body,
        responseBody: capture.value(streaming), responseTruncated: capture.truncated,
      })
      await publishUpdate({ type: 'request', ...(accountId ? { accountId } : {}) })
    } catch (error) {
      console.error('[gateway] Request log could not be persisted', error instanceof Error ? error.message : 'Storage unavailable')
    }
  }
}