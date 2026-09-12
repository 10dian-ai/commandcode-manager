import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, getHeader, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface StoredKey {
  id: string; name: string; prefix: string; secret_hash: string; enabled: boolean
  created_at: Date; last_used_at: Date | null
}
const fixture = vi.hoisted(() => ({
  serviceKeys: new Map<string, StoredKey>(),
  gatewayKeys: new Map<string, StoredKey>(),
  sessions: new Map<string, string>(),
  queries: [] as { sql: string; values: unknown[] }[],
  publish: vi.fn(async () => 1),
}))
vi.mock('../server/lib/db', () => ({
  getDb: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim()
    fixture.queries.push({ sql, values })
    const table = sql.includes('service_keys') ? fixture.serviceKeys : sql.includes('gateway_keys') ? fixture.gatewayKeys : null
    if (!table) throw new Error(`Unexpected SQL in service key fixture: ${sql}`)
    if (sql.startsWith('INSERT INTO')) {
      const row: StoredKey = {
        id: String(values[0]), name: String(values[1]), prefix: String(values[2]), secret_hash: String(values[3]),
        enabled: true, created_at: new Date('2026-09-12T00:00:00.000Z'), last_used_at: null,
      }
      table.set(row.id, row)
      return [{ created_at: row.created_at }]
    }
    if (sql.startsWith('SELECT') && sql.includes('secret_hash=')) {
      const row = [...table.values()].find(item => item.secret_hash === values[0] && item.enabled)
      return row ? [{ id: row.id, name: row.name }] : []
    }
    if (sql.startsWith('SELECT')) {
      return [...table.values()].map(({ secret_hash: _secretHash, ...row }) => ({ ...row }))
    }
    if (sql.startsWith('UPDATE') && sql.includes('last_used_at=now()')) {
      const row = table.get(String(values[0]))
      if (row) row.last_used_at = new Date('2026-09-12T01:00:00.000Z')
      return []
    }
    if (sql.startsWith('UPDATE') && sql.includes('name=coalesce')) {
      const row = table.get(String(values[2]))
      if (!row) return []
      if (values[0] !== null) row.name = String(values[0])
      if (values[1] !== null) row.enabled = Boolean(values[1])
      return [{ id: row.id }]
    }
    if (sql.startsWith('DELETE FROM')) { table.delete(String(values[0])); return [] }
    throw new Error(`Unhandled SQL in service key fixture: ${sql}`)
  },
}))
vi.mock('../server/lib/redis', () => ({
  getRedis: () => ({ get: async (key: string) => fixture.sessions.get(key) ?? null, publish: fixture.publish }),
}))

import { authenticateGatewayKey, authenticateServiceKey } from '../server/lib/auth'
import { hashGatewayKey } from '../server/lib/crypto'
import adminMiddleware from '../server/middleware/admin'
import listKeys from '../server/api/service-keys/index.get'
import createKey from '../server/api/service-keys/index.post'
import updateKey from '../server/api/service-keys/[id].patch'
import deleteKey from '../server/api/service-keys/[id].delete'

const SERVICE_KEY = 'ccm_service_' + 'a'.repeat(43)
const GATEWAY_KEY = 'ccm_' + 'b'.repeat(43)
const SERVICE_ID = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const MISSING_ID = '33333333-3333-4333-8333-333333333333'
const ADMIN_COOKIE = 'ccm_session=test-admin-session'
const bearer = (key = SERVICE_KEY) => ({ authorization: `Bearer ${key}` })

function seedKey(table: Map<string, StoredKey>, id: string, secret: string, name: string) {
  const row: StoredKey = {
    id, name, prefix: secret.slice(0, 20), secret_hash: hashGatewayKey(secret), enabled: true,
    created_at: new Date('2026-09-12T00:00:00.000Z'), last_used_at: null,
  }
  table.set(id, row)
  return row
}

describe('independent service keys over real H3 HTTP connections', () => {
  let server: Server | undefined
  let baseUrl: string
  const request = (path: string, options: RequestInit = {}) => fetch(baseUrl + path, {
    ...options, signal: AbortSignal.timeout(3000),
  })
  const adminRequest = (path: string, method = 'GET', body?: unknown) => request(path, {
    method, headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  beforeEach(async () => {
    fixture.serviceKeys.clear(); fixture.gatewayKeys.clear(); fixture.sessions.clear(); fixture.queries.length = 0
    fixture.publish.mockClear()
    seedKey(fixture.serviceKeys, SERVICE_ID, SERVICE_KEY, 'External worker')
    seedKey(fixture.gatewayKeys, GATEWAY_ID, GATEWAY_KEY, 'Model client')
    fixture.sessions.set('ccm:admin:session:' + hashGatewayKey('test-admin-session'), 'admin')
    const app = createApp()
    app.use(adminMiddleware)
    const router = createRouter()
    router.get('/api/external/probe', defineEventHandler(() => ({ ok: true })))
    router.post('/api/external/probe', defineEventHandler(() => ({ ok: true })))
    router.get('/api/private-probe', defineEventHandler(() => ({ ok: true })))
    router.get('/api/externality/probe', defineEventHandler(() => ({ ok: true })))
    router.get('/api/service-keys', listKeys)
    router.post('/api/service-keys', createKey)
    router.patch('/api/service-keys/:id', updateKey)
    router.delete('/api/service-keys/:id', deleteKey)
    router.get('/v1/models-probe', defineEventHandler(async event => ({
      key: await authenticateGatewayKey((getHeader(event, 'authorization') ?? '').replace(/^Bearer\s+/i, '')),
    })))
    app.use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
  })

  it('accepts a dedicated key through either header and records usage without an admin session', async () => {
    for (const headers of [bearer(), { authorization: `bEaReR ${SERVICE_KEY}` }, { 'x-api-key': SERVICE_KEY }]) {
      const response = await request('/api/external/probe', { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ ok: true })
    }
    expect(fixture.serviceKeys.get(SERVICE_ID)?.last_used_at).not.toBeNull()
    expect(fixture.gatewayKeys.get(GATEWAY_ID)?.last_used_at).toBeNull()
    expect(await authenticateServiceKey(SERVICE_KEY)).toEqual({ id: SERVICE_ID, name: 'External worker' })
  })

  it('rejects missing, invalid, ordinary gateway keys and session-only callers', async () => {
    const headersToReject: HeadersInit[] = [
      {}, bearer('ccm_service_' + 'z'.repeat(43)), bearer(GATEWAY_KEY),
      { cookie: ADMIN_COOKIE }, { cookie: ADMIN_COOKIE, ...bearer('invalid') },
    ]
    for (const headers of headersToReject) {
      const response = await request('/api/external/probe', { headers })
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await response.arrayBuffer()
    }
    expect(fixture.serviceKeys.get(SERVICE_ID)?.last_used_at).toBeNull()
  })

  it('gives Bearer precedence over x-api-key, including when the Bearer value is invalid', async () => {
    const accepted = await request('/api/external/probe', {
      headers: { ...bearer(), 'x-api-key': 'invalid' },
    })
    expect(accepted.status).toBe(200)
    await accepted.arrayBuffer()
    const rejected = await request('/api/external/probe', {
      headers: { ...bearer('invalid'), 'x-api-key': SERVICE_KEY, cookie: ADMIN_COOKIE },
    })
    expect(rejected.status).toBe(401)
    await rejected.arrayBuffer()
  })

  it('retains admin session protection for ordinary API paths and key management', async () => {
    for (const path of ['/api/private-probe', '/api/externality/probe', '/api/service-keys']) {
      const denied = await request(path, { headers: bearer() })
      expect(denied.status).toBe(401)
      await denied.arrayBuffer()
      const accepted = await adminRequest(path)
      expect(accepted.status).toBe(200)
      expect(accepted.headers.get('cache-control')).toBe('no-store')
      await accepted.arrayBuffer()
    }
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const path = method === 'POST' ? '/api/service-keys' : `/api/service-keys/${SERVICE_ID}`
      const response = await request(path, {
        method, headers: { ...bearer(), 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ name: 'Unauthorized change' }),
      })
      expect(response.status).toBe(401)
      await response.arrayBuffer()
    }
    expect(fixture.serviceKeys.size).toBe(1)
    expect(fixture.serviceKeys.get(SERVICE_ID)?.name).toBe('External worker')
  })

  it('separates service and gateway credentials even if an identical hash exists in the other table', async () => {
    seedKey(fixture.gatewayKeys, MISSING_ID, SERVICE_KEY, 'Collision in model table')
    seedKey(fixture.serviceKeys, GATEWAY_ID, GATEWAY_KEY, 'Collision in service table')
    expect(await authenticateGatewayKey(SERVICE_KEY)).toBeNull()
    expect(await authenticateServiceKey(GATEWAY_KEY)).toBeNull()
    const rejected = await request('/v1/models-probe', { headers: bearer() })
    expect(await rejected.json()).toEqual({ key: null })
    const accepted = await request('/v1/models-probe', { headers: bearer(GATEWAY_KEY) })
    expect(await accepted.json()).toEqual({ key: { id: GATEWAY_ID, name: 'Model client' } })
    const serviceQueries = fixture.queries.filter(query => query.sql.startsWith('SELECT') && query.sql.includes('service_keys'))
    expect(serviceQueries).toHaveLength(0)
  })

  it('rejects malformed dedicated keys before any database lookup', async () => {
    for (const secret of ['', 'ccm_service_', SERVICE_KEY + 'x', SERVICE_KEY.slice(0, -1),
      'ccm_service_' + '+'.repeat(43), 'ccm_service_' + 'a'.repeat(201)]) {
      expect(await authenticateServiceKey(secret)).toBeNull()
    }
    expect(fixture.queries).toHaveLength(0)
  })

  it('returns plaintext only on creation, stores its hash, and lists only safe metadata', async () => {
    const createdResponse = await adminRequest('/api/service-keys', 'POST', { name: '  Account importer  ' })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json()
    expect(created.key).toMatch(/^ccm_service_[A-Za-z0-9_-]{43}$/)
    expect(created.item).toEqual({
      id: expect.any(String), name: 'Account importer', prefix: created.key.slice(0, 20), enabled: true,
      createdAt: '2026-09-12T00:00:00.000Z', lastUsedAt: null,
    })
    expect(fixture.serviceKeys.get(created.item.id)?.secret_hash).toBe(hashGatewayKey(created.key))
    const insert = fixture.queries.find(query => query.sql.startsWith('INSERT INTO service_keys'))!
    expect(insert.values).not.toContain(created.key)
    expect(JSON.stringify([...fixture.serviceKeys.values()])).not.toContain(created.key)
    const listResponse = await adminRequest('/api/service-keys')
    const listed = await listResponse.json()
    expect(listed.items).toHaveLength(2)
    expect(listed.items.find((item: { id: string }) => item.id === created.item.id)).toEqual(created.item)
    expect(JSON.stringify(listed)).not.toContain(created.key)
    expect(JSON.stringify(listed)).not.toContain(hashGatewayKey(created.key))
    expect(listed.items.every((item: object) => Object.keys(item).sort().join(',') ===
      ['id', 'name', 'prefix', 'enabled', 'createdAt', 'lastUsedAt'].sort().join(','))).toBe(true)
    const usable = await request('/api/external/probe', { headers: bearer(created.key) })
    expect(usable.status).toBe(200)
    await usable.arrayBuffer()
    expect(fixture.publish).toHaveBeenCalled()
  })

  it('applies renames, disable, re-enable and revocation immediately', async () => {
    const renamed = await adminRequest(`/api/service-keys/${SERVICE_ID}`, 'PATCH', { name: '  New importer  ' })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ ok: true })
    expect(await authenticateServiceKey(SERVICE_KEY)).toEqual({ id: SERVICE_ID, name: 'New importer' })
    const disabled = await adminRequest(`/api/service-keys/${SERVICE_ID}`, 'PATCH', { enabled: false })
    expect(await disabled.json()).toEqual({ ok: true })
    const denied = await request('/api/external/probe', { headers: bearer() })
    expect(denied.status).toBe(401)
    await denied.arrayBuffer()
    const enabled = await adminRequest(`/api/service-keys/${SERVICE_ID}`, 'PATCH', { enabled: true })
    expect(await enabled.json()).toEqual({ ok: true })
    const accepted = await request('/api/external/probe', { headers: bearer() })
    expect(accepted.status).toBe(200)
    await accepted.arrayBuffer()
    const deleted = await adminRequest(`/api/service-keys/${SERVICE_ID}`, 'DELETE')
    expect(await deleted.json()).toEqual({ ok: true })
    expect(fixture.serviceKeys.has(SERVICE_ID)).toBe(false)
    const revoked = await request('/api/external/probe', { headers: bearer() })
    expect(revoked.status).toBe(401)
    await revoked.arrayBuffer()
    expect(fixture.gatewayKeys.has(GATEWAY_ID)).toBe(true)
  })

  it('validates create and update payloads, IDs and missing update targets', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'a'.repeat(81) }, { name: 5 }]) {
      const response = await adminRequest('/api/service-keys', 'POST', body)
      expect(response.status).toBe(400)
      await response.arrayBuffer()
    }
    for (const body of [{}, { unrelated: true }, { name: '' }, { name: 'a'.repeat(81) }, { enabled: 'false' }]) {
      const response = await adminRequest(`/api/service-keys/${SERVICE_ID}`, 'PATCH', body)
      expect(response.status).toBe(400)
      await response.arrayBuffer()
    }
    const missing = await adminRequest(`/api/service-keys/${MISSING_ID}`, 'PATCH', { enabled: false })
    expect(missing.status).toBe(404)
    await missing.arrayBuffer()
    for (const method of ['PATCH', 'DELETE']) {
      const response = await adminRequest('/api/service-keys/invalid-id', method, method === 'PATCH' ? { enabled: false } : undefined)
      expect(response.status).toBe(400)
      await response.arrayBuffer()
    }
    expect(fixture.serviceKeys.size).toBe(1)
    expect(fixture.serviceKeys.get(SERVICE_ID)?.enabled).toBe(true)
    expect(fixture.publish).not.toHaveBeenCalled()
  })
})
