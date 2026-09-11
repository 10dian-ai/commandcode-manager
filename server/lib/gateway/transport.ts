import type { ServerResponse } from 'node:http'
import type { H3Event } from 'h3'
import { createError } from 'h3'

const PASSTHROUGH_HEADERS = ['anthropic-version', 'anthropic-beta', 'x-session-id', 'x-claude-code-session-id',
  'x-codex-session-id', 'x-agent-id', 'x-subagent-id']
export function makeKernelHeaders(headers: Record<string, string | string[] | undefined>, upstreamKey: string): Headers {
  const output = new Headers({ 'content-type': 'application/json', authorization: 'Bearer ' + upstreamKey })
  for (const name of PASSTHROUGH_HEADERS) {
    const value = headers[name]
    if (typeof value === 'string' && value.length <= 4096) output.set(name, value)
  }
  // Client cookies, gateway keys, x-api-key, forwarded host and arbitrary headers
  // are deliberately not forwarded to the core.
  return output
}
export async function readJsonBodyLimited(event: H3Event, maximum: number): Promise<Record<string, unknown>> {
  const length = Number(event.node.req.headers['content-length'])
  if (Number.isFinite(length) && length > maximum) throw createError({ statusCode: 413, statusMessage: 'Request body is too large' })
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of event.node.req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maximum) throw createError({ statusCode: 413, statusMessage: 'Request body is too large' })
    chunks.push(buffer)
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected JSON object')
    return result as Record<string, unknown>
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Request body must be a JSON object' })
  }
}
export async function writeWithBackpressure(response: ServerResponse, chunk: Uint8Array, signal: AbortSignal) {
  if (signal.aborted || response.destroyed) throw new Error('Client disconnected')
  if (response.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained)
      response.off('close', closed)
      response.off('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('Client disconnected')) }
    const failed = (error: Error) => { cleanup(); reject(error) }
    const aborted = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted')) }
    response.once('drain', drained)
    response.once('close', closed)
    response.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (response.destroyed) closed()
  })
}