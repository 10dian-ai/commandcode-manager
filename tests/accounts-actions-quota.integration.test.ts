import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined, enqueue: vi.fn(async () => {}), publish: vi.fn(async () => {}) }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/queues', () => ({ enqueueAccountRefresh: fixture.enqueue }))
vi.mock('../server/lib/events', () => ({ publishUpdate: fixture.publish }))
import accountActions from '../server/api/accounts/actions.post'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'ccm_actions_quota_test_' + randomUUID().replaceAll('-', '')

// These HTTP integration tests only use an explicitly supplied test database and a fresh isolated schema.
describe.skipIf(!databaseUrl)('bulk account quota actions over HTTP with PostgreSQL', () => {
  let admin: Sql | undefined
  let sql: Sql
  let server: Server | undefined
  let baseUrl = ''
  let created = false

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    created = true
    sql = postgres(databaseUrl!, {
      max: 1, connect_timeout: 5, onnotice: () => {},
      connection: { search_path: schema, application_name: 'ccm-isolated-actions-quota-test' },
    })
    fixture.sql = sql
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await migrate(sql)
    const app = createApp().use(createRouter().post('/api/accounts/actions', accountActions))
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  }, 30_000)

  beforeEach(() => { fixture.enqueue.mockClear(); fixture.publish.mockClear() })

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    if (sql) await sql.end({ timeout: 5 })
    if (admin) {
      try {
        if (created && /^ccm_actions_quota_test_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      } finally { await admin.end({ timeout: 5 }) }
    }
  }, 30_000)

  async function account(options: { enabled?: boolean; reasons?: string[]; resumeAt?: Date | null } = {}) {
    const id = randomUUID(), reasons = options.reasons ?? []
    const snapshot = { identity: { id, name: 'Bulk quota test', email: null }, credits: { monthlyCredits: 4 }, fetchedAt: new Date().toISOString() }
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,api_key_ciphertext,label,status,snapshot,
      enabled,quota_paused,quota_pause_reasons,quota_resume_at)
      VALUES(${id},${randomUUID()},'encrypted-test-cookie','encrypted-test-key','Preserved account','ready',${sql.json(snapshot)},
      ${options.enabled ?? reasons.length === 0},${reasons.length > 0},${sql.array(reasons)}::text[],${options.resumeAt ?? null})`
    return id
  }
  const state = async (id: string) => (await sql`SELECT enabled,quota_paused,quota_pause_reasons,quota_resume_at FROM managed_accounts WHERE id=${id}`)[0]!
  const contents = async (ids: string[]) => [...await sql`SELECT id,credential_fingerprint,cookie_ciphertext,api_key_ciphertext,label,status,snapshot
    FROM managed_accounts WHERE id IN ${sql(ids)} ORDER BY id`]
  const totalAccounts = async () => (await sql`SELECT count(*)::int AS total FROM managed_accounts`)[0]!.total
  const post = (action: 'enable' | 'disable', ids: string[]) => fetch(baseUrl + '/api/accounts/actions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ids }),
    signal: AbortSignal.timeout(5_000),
  })

  it('bulk disable cancels automatic recovery and preserves accounts, credentials, and snapshots', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000)
    const fiveHour = await account({ reasons: ['fiveHour'], resumeAt: future })
    const multiple = await account({ reasons: ['weekly', 'monthly'], resumeAt: future })
    const healthy = await account()
    const untouched = await account({ reasons: ['monthly'], resumeAt: future })
    const selected = [fiveHour, multiple, healthy]
    const before = await contents([...selected, untouched]), count = await totalAccounts()
    const untouchedState = await state(untouched)

    const response = await post('disable', [...selected, fiveHour, randomUUID()])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, affected: 3 })
    for (const id of selected) expect(await state(id)).toEqual({ enabled: false, quota_paused: false, quota_pause_reasons: [], quota_resume_at: null })
    expect(await state(untouched)).toEqual(untouchedState)
    expect(await contents([...selected, untouched])).toEqual(before)
    expect(await totalAccounts()).toBe(count)
    expect(fixture.enqueue).not.toHaveBeenCalled()
    expect(fixture.publish).toHaveBeenCalledExactlyOnceWith({ type: 'accounts' })
  })

  it('bulk enable keeps automatically paused accounts disabled until a forced refresh confirms recovery', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000)
    const weekly = await account({ reasons: ['weekly'], resumeAt: future })
    const unknownReset = await account({ reasons: ['fiveHour', 'monthly'] })
    const ids = [weekly, unknownReset], before = await contents(ids), count = await totalAccounts()
    const startedAt = Date.now()

    const response = await post('enable', [...ids, weekly, randomUUID()])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, affected: 2 })
    for (const [id, reasons] of [[weekly, ['weekly']], [unknownReset, ['fiveHour', 'monthly']]] as const) {
      const result = await state(id)
      expect(result).toMatchObject({ enabled: false, quota_paused: true, quota_pause_reasons: reasons })
      const resumeAt = new Date(result.quota_resume_at).getTime()
      expect(resumeAt).toBeGreaterThanOrEqual(startedAt - 1_000)
      expect(resumeAt).toBeLessThanOrEqual(Date.now() + 1_000)
      expect(fixture.enqueue).toHaveBeenCalledWith(id, { reason: 'manual', force: true })
    }
    expect(fixture.enqueue).toHaveBeenCalledTimes(2)
    expect(await contents(ids)).toEqual(before)
    expect(await totalAccounts()).toBe(count)
    expect(fixture.publish).toHaveBeenCalledExactlyOnceWith({ type: 'accounts' })
  })

  it('enables manually disabled normal accounts and refreshes each account once in a mixed batch', async () => {
    const first = await account({ enabled: false }), second = await account({ enabled: false })
    const paused = await account({ reasons: ['monthly'], resumeAt: new Date(Date.now() + 86_400_000) })
    const untouched = await account({ enabled: false })
    const ids = [first, second, paused], before = await contents([...ids, untouched]), count = await totalAccounts()

    const response = await post('enable', [...ids, first])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, affected: 3 })
    for (const id of [first, second]) expect(await state(id)).toEqual({ enabled: true, quota_paused: false, quota_pause_reasons: [], quota_resume_at: null })
    expect(await state(paused)).toMatchObject({ enabled: false, quota_paused: true, quota_pause_reasons: ['monthly'] })
    expect((await state(untouched)).enabled).toBe(false)
    for (const id of ids) expect(fixture.enqueue).toHaveBeenCalledWith(id, { reason: 'manual', force: true })
    expect(fixture.enqueue).toHaveBeenCalledTimes(3)
    expect(await contents([...ids, untouched])).toEqual(before)
    expect(await totalAccounts()).toBe(count)
    expect(fixture.publish).toHaveBeenCalledExactlyOnceWith({ type: 'accounts' })
  })
})
