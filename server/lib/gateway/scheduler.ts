import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'

export const GATEWAY_REDIS_PREFIX = 'ccm:gateway:'
export const GLOBAL_LEASE_KEY = GATEWAY_REDIS_PREFIX + 'leases:global'
export const ACCOUNT_COOLDOWN_KEY = GATEWAY_REDIS_PREFIX + 'account-cooldowns'
export const accountLeaseKey = (accountId: string) => GATEWAY_REDIS_PREFIX + 'leases:account:' + accountId
const ROUND_ROBIN_KEY = GATEWAY_REDIS_PREFIX + 'round-robin'
export const LEASE_MS = 60_000
export const RENEW_INTERVAL_MS = 15_000

// Redis TIME makes every web process use the same clock. Cleanup, both capacity
// checks, selection, affinity migration, and reservation happen in one operation.
const ACQUIRE = `
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local ttl=tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
redis.call('ZREMRANGEBYSCORE',KEYS[4],'-inf',now)
if redis.call('ZCARD',KEYS[1]) >= tonumber(ARGV[3]) then return {'global_capacity'} end
local candidates=cjson.decode(ARGV[5])
local n=#candidates
if n==0 then return {'no_accounts'} end
local preferred=nil
if ARGV[6]=='1' then preferred=redis.call('GET',KEYS[2]) end
local offset=redis.call('INCR',KEYS[3]) % n
redis.call('PEXPIRE',KEYS[3],604800000)
local best=nil
local bestScore=math.huge
for step=0,n-1 do
  local i=(offset+step)%n+1
  local account=candidates[i]
  local accountKey=KEYS[i+4]
  redis.call('ZREMRANGEBYSCORE',accountKey,'-inf',now)
  local count=redis.call('ZCARD',accountKey)
  local cooldown=redis.call('ZSCORE',KEYS[4],account.id)
  if (not cooldown or tonumber(cooldown)<=now) and count<account.limit then
    if account.id==preferred then best=i;break end
    local score=count/account.limit
    if score<bestScore then best=i;bestScore=score end
  end
end
if not best then return {'account_capacity'} end
local id=candidates[best].id
local accountKey=KEYS[best+4]
local expires=now+ttl
redis.call('ZADD',KEYS[1],expires,ARGV[1])
redis.call('ZADD',accountKey,expires,ARGV[1])
redis.call('PEXPIRE',KEYS[1],ttl*2)
redis.call('PEXPIRE',accountKey,ttl*2)
if ARGV[6]=='1' then redis.call('SET',KEYS[2],id,'PX',ARGV[4]) end
return {'acquired',id,ARGV[1],tostring(expires)}
`

const RENEW = `
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local a=redis.call('ZSCORE',KEYS[1],ARGV[1])
local b=redis.call('ZSCORE',KEYS[2],ARGV[1])
if not a or not b or tonumber(a)<=now or tonumber(b)<=now then
  redis.call('ZREM',KEYS[1],ARGV[1])
  redis.call('ZREM',KEYS[2],ARGV[1])
  return 0
end
local ttl=tonumber(ARGV[2])
redis.call('ZADD',KEYS[1],now+ttl,ARGV[1])
redis.call('ZADD',KEYS[2],now+ttl,ARGV[1])
redis.call('PEXPIRE',KEYS[1],ttl*2)
redis.call('PEXPIRE',KEYS[2],ttl*2)
return 1
`

const RELEASE = `
local global=redis.call('ZREM',KEYS[1],ARGV[1])
redis.call('ZREM',KEYS[2],ARGV[1])
return global
`

const COOLDOWN = `
local tm=redis.call('TIME')
local untilTime=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)+tonumber(ARGV[2])
local previous=redis.call('ZSCORE',KEYS[1],ARGV[1])
if not previous or tonumber(previous)<untilTime then
  redis.call('ZADD',KEYS[1],untilTime,ARGV[1])
end
return 1
`

export interface Candidate { id: string; limit: number }
export interface Lease { accountId: string; token: string; expiresAt: number }
export type AcquireResult = { ok: true; lease: Lease } |
  { ok: false; reason: 'global_capacity' | 'account_capacity' | 'no_accounts' }

export async function acquireLease(redis: Redis, input: {
  candidates: Candidate[]; globalLimit: number; affinityHash: string | null
  affinityTtlSeconds: number; leaseMs?: number
}): Promise<AcquireResult> {
  const candidates = input.candidates.filter(a => Number.isInteger(a.limit) && a.limit > 0).map(a => ({ id: a.id, limit: a.limit }))
  if (!candidates.length) return { ok: false, reason: 'no_accounts' }
  const token = randomUUID()
  const keys = [GLOBAL_LEASE_KEY, GATEWAY_REDIS_PREFIX + 'affinity:' + (input.affinityHash || 'unused'),
    ROUND_ROBIN_KEY, ACCOUNT_COOLDOWN_KEY, ...candidates.map(a => accountLeaseKey(a.id))]
  const result = await redis.eval(ACQUIRE, keys.length, ...keys, token, input.leaseMs ?? LEASE_MS,
    Math.max(1, input.globalLimit), Math.max(1000, input.affinityTtlSeconds * 1000),
    JSON.stringify(candidates), input.affinityHash ? '1' : '0') as string[]
  if (result[0] !== 'acquired') return { ok: false, reason: result[0] as 'global_capacity' | 'account_capacity' | 'no_accounts' }
  return { ok: true, lease: { accountId: result[1]!, token: result[2]!, expiresAt: Number(result[3]) } }
}

export async function renewLease(redis: Redis, lease: Lease, leaseMs = LEASE_MS): Promise<boolean> {
  return Number(await redis.eval(RENEW, 2, GLOBAL_LEASE_KEY, accountLeaseKey(lease.accountId),
    lease.token, leaseMs)) === 1
}
export async function releaseLease(redis: Redis, lease: Lease): Promise<void> {
  await redis.eval(RELEASE, 2, GLOBAL_LEASE_KEY, accountLeaseKey(lease.accountId), lease.token)
}
export async function cooldownAccount(redis: Redis, accountId: string, seconds: number) {
  await redis.eval(COOLDOWN, 1, ACCOUNT_COOLDOWN_KEY, accountId, Math.max(1, seconds) * 1000)
}
export async function readInflightCounts(redis: Redis, accountIds: string[]) {
  const time = await redis.time()
  const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000)
  const pipeline = redis.pipeline()
  pipeline.zcount(GLOBAL_LEASE_KEY, '(' + now, '+inf')
  for (const id of accountIds) pipeline.zcount(accountLeaseKey(id), '(' + now, '+inf')
  const values = await pipeline.exec()
  if (!values || values.some(([error]) => error)) throw new Error('Cannot read current gateway leases')
  return { total: Number(values[0]![1]), accounts: Object.fromEntries(accountIds.map((id, i) => [id, Number(values[i + 1]![1])])) }
}