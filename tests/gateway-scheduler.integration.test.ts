import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLease, releaseLease, renewLease, readInflightCounts, cooldownAccount, accountLeaseKey, type Lease } from '../server/lib/gateway/scheduler'

const redisUrl = process.env.TEST_REDIS_URL
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// These tests exercise real Lua and Redis expiry. Unique key prefixes prevent
// modification of application data even when several test suites share Redis.
describe.skipIf(!redisUrl)('Redis concurrency leases (integration)', () => {
  let raw: Redis
  let redis: Redis
  let prefix: string
  beforeEach(async () => {
    prefix = 'ccm-test:' + randomUUID() + ':'
    raw = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    redis = new Redis(redisUrl!, { lazyConnect: true, keyPrefix: prefix, maxRetriesPerRequest: 1 })
    await Promise.all([raw.connect(), redis.connect()])
  })
  afterEach(async () => {
    if (raw) {
      let cursor = '0'
      do {
        const result = await raw.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100)
        cursor = result[0]
        if (result[1].length) await raw.unlink(...result[1])
      } while (cursor !== '0')
    }
    raw?.disconnect()
    redis?.disconnect()
  })
  const options = (candidates = [{ id: 'a', limit: 2 }, { id: 'b', limit: 2 }, { id: 'c', limit: 2 }]) =>
    ({ candidates, globalLimit: 5, affinityHash: null, affinityTtlSeconds: 60 })

  it('atomically enforces both capacities under simultaneous acquisitions', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => acquireLease(redis, options())))
    const leases = results.filter(result => result.ok).map(result => (result as { ok: true; lease: Lease }).lease)
    expect(leases).toHaveLength(5)
    const counts = await readInflightCounts(redis, ['a', 'b', 'c'])
    expect(counts.total).toBe(5)
    expect(Object.values(counts.accounts).every(value => value <= 2)).toBe(true)
    expect(Object.values(counts.accounts).reduce((sum, value) => sum + value, 0)).toBe(5)
    await Promise.all(leases.flatMap(lease => [releaseLease(redis, lease), releaseLease(redis, lease)]))
    expect((await readInflightCounts(redis, ['a', 'b', 'c'])).total).toBe(0)
  })
  it('renews long-running work beyond its initial expiry', async () => {
    const input = { ...options([{ id: 'a', limit: 1 }]), leaseMs: 600 }
    const first = await acquireLease(redis, input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await delay(300)
    expect(await renewLease(redis, first.lease, 600)).toBe(true)
    await delay(400)
    expect((await acquireLease(redis, input)).ok).toBe(false)
    await releaseLease(redis, first.lease)
    expect((await acquireLease(redis, input)).ok).toBe(true)
  })
  it('reclaims an expired crashed request, without stale release deleting its replacement', async () => {
    const input = { ...options([{ id: 'a', limit: 1 }]), leaseMs: 80 }
    const first = await acquireLease(redis, input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await delay(140)
    const second = await acquireLease(redis, { ...input, leaseMs: 2000 })
    expect(second.ok).toBe(true)
    expect(await renewLease(redis, first.lease, 2000)).toBe(false)
    await releaseLease(redis, first.lease)
    expect((await readInflightCounts(redis, ['a'])).accounts.a).toBe(1)
  })
  it('migrates a busy session while retaining the original request and binding the new account', async () => {
    const input = { ...options([{ id: 'a', limit: 1 }, { id: 'b', limit: 1 }]), affinityHash: 'same-session' }
    const first = await acquireLease(redis, input)
    const second = await acquireLease(redis, input)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.lease.accountId).not.toBe(first.lease.accountId)
    expect((await readInflightCounts(redis, ['a', 'b'])).total).toBe(2)
    await releaseLease(redis, second.lease)
    const third = await acquireLease(redis, input)
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.lease.accountId).toBe(second.lease.accountId)
    expect(await renewLease(redis, first.lease)).toBe(true)
    expect((await readInflightCounts(redis, ['a', 'b'])).total).toBe(2)
  })
  it('fails closed when either half of a lease disappears', async () => {
    const result = await acquireLease(redis, options([{ id: 'a', limit: 1 }]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await redis.del(accountLeaseKey('a'))
    expect(await renewLease(redis, result.lease)).toBe(false)
    expect((await readInflightCounts(redis, ['a'])).total).toBe(0)
  })
  it('temporarily excludes an account without marking its model denied', async () => {
    await cooldownAccount(redis, 'a', 1)
    const input = options([{ id: 'a', limit: 1 }, { id: 'b', limit: 1 }])
    const result = await acquireLease(redis, input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.lease.accountId).toBe('b')
    expect((await acquireLease(redis, options([{ id: 'a', limit: 1 }]))).ok).toBe(false)
  })
})