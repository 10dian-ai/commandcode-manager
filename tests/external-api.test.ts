import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  queueImport: vi.fn(),
  getJob: vi.fn(),
  db: vi.fn(),
  redisGet: vi.fn(),
  zcount: vi.fn(),
  kernel: vi.fn(),
  serviceEnabled: true,
  accounts: { total: 19, enabled: 14, ready: 8, attention: 3, pending: 6, last_sync_at: '2026-09-12T01:02:03Z' } as Record<string, any>,
  requests: { total: 39, success: 20, failed: 7 },
}))
vi.mock('../server/lib/queues', () => ({
  queueImport: fixture.queueImport,
  getImportQueue: () => ({ getJob: fixture.getJob }),
}))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.db }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ get: fixture.redisGet, zcount: fixture.zcount }) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ kernelUrl: 'http://kernel.example.invalid' }) }))

import adminMiddleware from '../server/middleware/admin'
import externalAccountsHandler from '../server/api/external/accounts.post'
import externalJobHandler from '../server/api/external/jobs/[id].get'
import externalPoolHandler from '../server/api/external/pool.get'
import adminImportHandler from '../server/api/accounts/import.post'
import adminDashboardHandler from '../server/api/dashboard.get'
import { hashGatewayKey } from '../server/lib/crypto'
import { SESSION_COOKIE } from '../server/lib/account-import'

const serviceSecret = 'ccm_service_' + 'a'.repeat(43)
const jobId = '70927070-3573-4d4f-a687-9f82d04c1ca2'
const token = 'test%2Fsession%3D.1234567890'
const receipt = { jobId, accepted: 2, rejected: 1, duplicates: 3 }
const result = { imported: 1, updated: 1, failed: 1, skipped: 3, errors: [{ line: 4, message: 'Token 格式无效' }] }

describe('external account and pool API over HTTP', () => {
  let server: Server | undefined
  let baseUrl = ''
  const authorization = { authorization: 'Bearer ' + serviceSecret }

  beforeEach(async () => {
    vi.resetAllMocks()
    fixture.serviceEnabled = true
    fixture.accounts = { total: 19, enabled: 14, ready: 8, attention: 3, pending: 6, last_sync_at: '2026-09-12T01:02:03Z' }
    fixture.queueImport.mockResolvedValue(receipt)
    fixture.getJob.mockResolvedValue(undefined)
    fixture.db.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?')
      if (query.includes('FROM service_keys')) return fixture.serviceEnabled && values[0] === hashGatewayKey(serviceSecret) ? [{ id: 'service-key-id', name: 'External importer' }] : []
      if (query.includes('UPDATE service_keys')) return []
      if (query.includes('FROM managed_accounts')) return [fixture.accounts]
      if (query.includes('FROM request_logs')) return [fixture.requests]
      throw new Error('Unexpected database query')
    })
    fixture.redisGet.mockImplementation(async (key: string) => key.startsWith('ccm:admin:session:') ? 'admin' : '2026-09-12T01:02:00Z')
    fixture.zcount.mockResolvedValue(5)
    fixture.kernel.mockResolvedValue(new Response('ok'))
    const nativeFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input) === 'http://kernel.example.invalid/health' ? fixture.kernel() : nativeFetch(input, init))
    const router = createRouter()
      .post('/api/external/accounts', externalAccountsHandler)
      .get('/api/external/jobs/:id', externalJobHandler)
      .get('/api/external/pool', externalPoolHandler)
      .post('/api/accounts/import', adminImportHandler)
      .get('/api/dashboard', adminDashboardHandler)
    const app = createApp()
    app.use(adminMiddleware)
    app.use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.restoreAllMocks()
  })

  const post = (body: unknown, path = '/api/external/accounts', headers: Record<string, string> = authorization) => fetch(baseUrl + path, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it.each([
    { body: { token, groupName: '  imported  ' }, text: token, group: 'imported' },
    { body: { cookie: 'Cookie: other=value; ' + SESSION_COOKIE + '=' + token }, text: 'Cookie: other=value; ' + SESSION_COOKIE + '=' + token, group: undefined },
    { body: { text: token + '\n' + token }, text: token + '\n' + token, group: undefined },
  ])('queues $body unchanged and returns an asynchronous receipt', async ({ body, text, group }) => {
    const response = await post(body)
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(receipt)
    expect(fixture.queueImport).toHaveBeenCalledExactlyOnceWith(text, group)
  })

  it.each([
    {}, { token, cookie: token }, { token, text: token }, { token, unsupported: true },
    { token: token + '\n' + token }, { cookie: token + '\r' + token },
    { token: '' }, { token: 'x'.repeat(8193) }, { text: 'x'.repeat(2_000_001) },
    { token, groupName: 'g'.repeat(101) }, { text: Array(2001).fill(token).join('\n') },
  ])('rejects an invalid import request before enqueueing %#', async body => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(fixture.queueImport).not.toHaveBeenCalled()
  })

  it('preserves the admin import text contract and HTTP 200 response', async () => {
    const response = await post({ text: token, groupName: '  existing  ' }, '/api/accounts/import', { cookie: 'ccm_session=test-admin-session' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(receipt)
    expect(fixture.queueImport).toHaveBeenCalledExactlyOnceWith(token, 'existing')
    expect((await post({ token }, '/api/accounts/import', { cookie: 'ccm_session=test-admin-session' })).status).toBe(400)
  })

  it.each([
    {},
    { cookie: 'ccm_session=test-admin-session' },
    { authorization: 'Bearer ccm_' + 'b'.repeat(43) },
  ])('requires the separate service key on every external route %#', async headers => {
    expect((await post({ token }, '/api/external/accounts', headers)).status).toBe(401)
    expect((await fetch(baseUrl + '/api/external/jobs/' + jobId, { headers })).status).toBe(401)
    expect((await fetch(baseUrl + '/api/external/pool', { headers })).status).toBe(401)
    expect(fixture.queueImport).not.toHaveBeenCalled()
    expect(fixture.getJob).not.toHaveBeenCalled()
    expect(fixture.kernel).not.toHaveBeenCalled()
  })

  it('rejects a disabled service key before reading pool state', async () => {
    fixture.serviceEnabled = false
    expect((await fetch(baseUrl + '/api/external/pool', { headers: authorization })).status).toBe(401)
    expect(fixture.kernel).not.toHaveBeenCalled()
  })

  it.each(['waiting', 'active', 'completed', 'failed'])('reports the %s import state without credentials or internal failure details', async state => {
    fixture.getJob.mockResolvedValue({
      getState: async () => state,
      progress: state === 'waiting' ? 0 : { processed: 2, total: 2 },
      data: { entries: [{ ciphertext: 'encrypted-private-credential', fingerprint: 'private-fingerprint' }, {}] },
      returnvalue: result,
      failedReason: 'private internal failure details',
    })
    const response = await fetch(baseUrl + '/api/external/jobs/' + jobId, { headers: { 'x-api-key': serviceSecret } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      id: jobId, status: state,
      progress: state === 'waiting' ? { processed: 0, total: 2 } : { processed: 2, total: 2 },
      result: state === 'completed' ? result : null,
      error: state === 'failed' ? '导入任务中断，请重试；已完成的账号已保留' : null,
    })
    expect(JSON.stringify(body)).not.toContain('private')
  })

  it('rejects malformed job identifiers and returns 404 for removed or expired jobs', async () => {
    expect((await fetch(baseUrl + '/api/external/jobs/not-a-uuid', { headers: authorization })).status).toBe(400)
    expect(fixture.getJob).not.toHaveBeenCalled()
    const response = await fetch(baseUrl + '/api/external/jobs/' + jobId, { headers: authorization })
    expect(response.status).toBe(404)
    expect(fixture.getJob).toHaveBeenCalledExactlyOnceWith(jobId)
  })

  it('returns the same real counts as the dashboard without refreshing individual accounts', async () => {
    const response = await fetch(baseUrl + '/api/external/pool', { headers: authorization })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      counts: { total: 19, enabled: 14, ready: 8, needsAttention: 3, notSynced: 6 },
      requests: { total: 39, success: 20, failed: 7, inFlight: 5 },
      services: { database: true, redis: true, workerLastSeen: '2026-09-12T01:02:00Z', kernel: true },
      lastSyncAt: '2026-09-12T01:02:03.000Z',
    })
    expect(fixture.db.mock.calls.filter(([strings]) => strings.join('').includes('count(*)'))).toHaveLength(2)
    expect(fixture.kernel).toHaveBeenCalledTimes(1)
    expect(fixture.zcount).toHaveBeenCalledWith('ccm:gateway:leases:global', expect.any(Number), '+inf')
    expect(fixture.queueImport).not.toHaveBeenCalled()
    const admin = await fetch(baseUrl + '/api/dashboard', { headers: { cookie: 'ccm_session=test-admin-session' } })
    expect(await admin.json()).toEqual(body)
  })

  it('preserves missing sync and heartbeat values and reports an unavailable kernel', async () => {
    fixture.accounts.last_sync_at = null
    fixture.redisGet.mockResolvedValue(null)
    fixture.kernel.mockRejectedValue(new Error('Kernel offline'))
    const response = await fetch(baseUrl + '/api/external/pool', { headers: authorization })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.lastSyncAt).toBeNull()
    expect(body.services.workerLastSeen).toBeNull()
    expect(body.services.kernel).toBe(false)
    expect(body.counts.total).toBe(19)
  })

  it('does not fabricate successful pool data when the live concurrency store fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fixture.zcount.mockRejectedValue(new Error('Redis offline'))
    const response = await fetch(baseUrl + '/api/external/pool', { headers: authorization })
    expect(response.status).toBe(500)
    expect(await response.json()).not.toHaveProperty('counts')
  })
})
