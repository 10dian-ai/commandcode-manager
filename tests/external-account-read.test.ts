import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  db: vi.fn(),
  redisGet: vi.fn(),
  pipeline: vi.fn(),
  zcount: vi.fn(),
  exec: vi.fn(),
  serviceEnabled: true,
  rows: [] as Record<string, unknown>[],
}))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.db }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ get: fixture.redisGet, pipeline: fixture.pipeline }) }))
vi.mock('../server/lib/settings', () => ({ getSettings: vi.fn() }))
vi.mock('../server/lib/events', () => ({ publishUpdate: vi.fn() }))
vi.mock('../server/lib/queues', () => ({ enqueueAccountRefresh: vi.fn() }))

import adminMiddleware from '../server/middleware/admin'
import listAccountsHandler from '../server/api/external/accounts.get'
import getAccountHandler from '../server/api/external/accounts/[id].get'
import { hashGatewayKey } from '../server/lib/crypto'

const accountId = '70927070-3573-4d4f-a687-9f82d04c1ca2'
const serviceSecret = 'ccm_service_' + 'a'.repeat(43)
const authorization = { authorization: 'Bearer ' + serviceSecret }

describe('external account reads over HTTP', () => {
  let server: Server | undefined
  let baseUrl = ''

  beforeEach(async () => {
    vi.resetAllMocks()
    fixture.serviceEnabled = true
    fixture.rows = [{
      id: accountId, label: 'Payment account', email: 'billing@example.invalid', group_name: 'paid', note: '',
      enabled: true, quota_paused: false, quota_resume_at: null, status: 'ready', max_concurrency: 2,
      api_key_ciphertext: 'private-api-key-ciphertext', cookie_ciphertext: 'private-cookie-ciphertext',
      credential_fingerprint: 'private-credential-fingerprint', snapshot: null, sync_error: null,
      last_sync_at: '2026-09-12T01:02:03Z', last_used_at: null, created_at: '2026-09-10T01:02:03Z',
    }]
    fixture.db.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?')
      if (query.includes('FROM service_keys')) return fixture.serviceEnabled && values[0] === hashGatewayKey(serviceSecret) ? [{ id: 'service-key-id', name: 'Account reader' }] : []
      if (query.includes('UPDATE service_keys')) return []
      if (query.startsWith('WHERE ')) return { query, values }
      if (query.includes('SELECT count(*)')) return [{ total: fixture.rows.length }]
      if (query.includes('SELECT DISTINCT group_name')) return [{ group_name: 'paid' }]
      if (query.includes('FROM managed_accounts')) return fixture.rows
      if (query.includes('FROM account_models')) return [{ model_id: 'test/model', status: 'allowed', reason: null, cooldown_until: null, last_checked_at: '2026-09-12T01:02:03Z' }]
      throw new Error('Unexpected database query')
    })
    fixture.redisGet.mockResolvedValue('admin')
    const pipeline = { zcount: fixture.zcount, exec: fixture.exec }
    fixture.pipeline.mockReturnValue(pipeline)
    fixture.zcount.mockReturnValue(pipeline)
    fixture.exec.mockImplementation(async () => fixture.rows.map(() => [null, 1]))
    const router = createRouter()
      .get('/api/external/accounts', listAccountsHandler)
      .get('/api/external/accounts/:id', getAccountHandler)
    const app = createApp().use(adminMiddleware).use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.restoreAllMocks()
  })

  const get = (path = '/api/external/accounts', headers: Record<string, string> = authorization) => fetch(baseUrl + path, { headers })
  const accountQueries = () => fixture.db.mock.calls.filter(([strings]) => strings.join('').includes('FROM managed_accounts'))

  it('returns account emails with the default pagination and live concurrency', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      items: [{ id: accountId, email: 'billing@example.invalid', groupName: 'paid', inFlight: 1, hasApiKey: true }],
      total: 1, page: 1, pageSize: 50, groups: ['paid'],
    })
    expect(fixture.zcount).toHaveBeenCalledExactlyOnceWith('ccm:gateway:leases:account:' + accountId, expect.any(Number), '+inf')
  })

  it('forwards pagination, status, group and escaped email search to the existing account query', async () => {
    const query = new URLSearchParams({ q: 'billing_100%@example.invalid', status: 'ready', group: 'paid', page: '3', pageSize: '7' })
    const response = await get('/api/external/accounts?' + query)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ page: 3, pageSize: 7 })
    const filterCall = fixture.db.mock.calls.find(([strings]) => strings.join('').startsWith('WHERE '))
    expect(filterCall?.slice(1)).toEqual(expect.arrayContaining([
      'billing_100%@example.invalid', '%billing\\_100\\%@example.invalid%', 'ready', 'paid',
    ]))
    const listCall = fixture.db.mock.calls.find(([strings]) => strings.join('').includes('ORDER BY created_at DESC,id LIMIT'))
    expect(listCall?.slice(-2)).toEqual([7, 14])
  })

  it.each([
    'page=0', 'page=1.5', 'page=100001', 'pageSize=0', 'pageSize=201', 'pageSize=NaN',
    'status=unknown', 'q=' + 'q'.repeat(201), 'group=' + 'g'.repeat(101),
  ])('rejects invalid list query %s before accessing accounts', async query => {
    const response = await get('/api/external/accounts?' + query)
    expect(response.status).toBe(400)
    expect(accountQueries()).toHaveLength(0)
    expect(fixture.pipeline).not.toHaveBeenCalled()
  })

  it('returns account details and observed models using the alternate service key header', async () => {
    const response = await get('/api/external/accounts/' + accountId, { 'x-api-key': serviceSecret })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      id: accountId, email: 'billing@example.invalid', lastSyncAt: '2026-09-12T01:02:03.000Z',
      observedModels: [{ modelId: 'test/model', status: 'allowed', lastCheckedAt: '2026-09-12T01:02:03.000Z' }],
    })
    expect(accountQueries()[0]?.slice(1)).toEqual([accountId])
  })

  it.each(['/api/external/accounts', '/api/external/accounts/' + accountId])('excludes stored credentials through the real account mapping at %s', async path => {
    const response = await get(path)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain('private-')
    expect(body).not.toContain('ciphertext')
    expect(body).not.toContain('credential_fingerprint')
    expect(body).toContain('billing@example.invalid')
  })

  it('rejects a malformed account ID before storage and returns 404 for a missing account', async () => {
    expect((await get('/api/external/accounts/not-a-uuid')).status).toBe(400)
    expect(accountQueries()).toHaveLength(0)
    fixture.rows = []
    expect((await get('/api/external/accounts/' + accountId)).status).toBe(404)
    expect(accountQueries()).toHaveLength(1)
    expect(fixture.pipeline).not.toHaveBeenCalled()
  })

  it.each([
    {}, { cookie: 'ccm_session=test-admin-session' }, { authorization: 'Bearer ccm_' + 'b'.repeat(43) },
  ])('rejects missing service credentials, admin sessions and model keys on both read routes %#', async headers => {
    for (const path of ['/api/external/accounts', '/api/external/accounts/' + accountId]) {
      expect((await get(path, headers)).status).toBe(401)
    }
    expect(accountQueries()).toHaveLength(0)
    expect(fixture.redisGet).not.toHaveBeenCalled()
    expect(fixture.pipeline).not.toHaveBeenCalled()
  })

  it('rejects a disabled service key on both read routes before reading accounts', async () => {
    fixture.serviceEnabled = false
    for (const path of ['/api/external/accounts', '/api/external/accounts/' + accountId]) {
      expect((await get(path)).status).toBe(401)
    }
    expect(accountQueries()).toHaveLength(0)
    expect(fixture.pipeline).not.toHaveBeenCalled()
  })
})
