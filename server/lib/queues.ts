import { Queue } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRedisConnection, getRedis } from './redis'
import { encryptSecret, fingerprint } from './crypto'
import { parseCookieText } from './account-import'
import { getDb } from './db'

export const IMPORT_QUEUE = 'ccm-import'
export const REFRESH_QUEUE = 'ccm-refresh'
export const REFRESH_PRIORITY = { manual: 1, request: 2, scheduled: 20 } as const
export interface ImportJobData { entries: { line: number; ciphertext: string; fingerprint: string }[]; groupName?: string; rejected: { line: number; message: string }[]; duplicates: number }
let imports: Queue<ImportJobData> | undefined, refreshes: Queue | undefined
export function getImportQueue() { return imports ??= new Queue<ImportJobData>(IMPORT_QUEUE, { connection: createRedisConnection(), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400, count: 200 }, removeOnFail: { age: 604800, count: 200 } } }) }
export function getRefreshQueue() { return refreshes ??= new Queue(REFRESH_QUEUE, { connection: createRedisConnection(), defaultJobOptions: { priority: REFRESH_PRIORITY.scheduled, attempts: 3, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true, removeOnFail: { age: 3600, count: 1000 } } }) }
export async function queueImport(text: string, groupName?: string) {
  const parsed = parseCookieText(text)
  const unique = parsed.entries.map(entry => ({ ...entry, fingerprint: fingerprint(entry.cookie) }))
  const existing = unique.length ? await getDb()`SELECT credential_fingerprint FROM managed_accounts WHERE credential_fingerprint IN ${getDb()(unique.map(e=>e.fingerprint))}` : []
  const known = new Set(existing.map(row => row.credential_fingerprint))
  const accepted = unique.filter(entry => !known.has(entry.fingerprint))
  const duplicates = parsed.duplicates + unique.length - accepted.length
  const jobId = randomUUID()
  await getImportQueue().add('import', {
    entries: accepted.map(entry => ({ line: entry.line, ciphertext: encryptSecret(entry.cookie), fingerprint: entry.fingerprint })),
    ...(groupName !== undefined ? { groupName } : {}), rejected: parsed.errors, duplicates,
  }, { jobId })
  return { jobId, accepted: accepted.length, rejected: parsed.errors.length, duplicates }
}
export async function enqueueAccountRefresh(accountId: string, options: { reason?: string; force?: boolean } = {}) {
  const redis = getRedis(), dirty = `ccm:refresh:dirty:${accountId}`
  const queue = getRefreshQueue(), jobId = `refresh-${accountId}`
  const reason = options.force || options.reason === 'manual' ? 'manual' : options.reason === 'request' ? 'request' : 'scheduled'
  const priority = REFRESH_PRIORITY[reason]
  // Serialize promotions from simultaneous completion callbacks so a stale periodic enqueue can
  // neither lower an urgent job's priority nor postpone the original coalescing deadline.
  const lockKey = `ccm:refresh:enqueue-lock:${accountId}`, token = randomUUID(), deadline = Date.now() + 2000
  while (!await redis.set(lockKey, token, 'PX', 5000, 'NX')) {
    if (Date.now() >= deadline) throw new Error('Refresh enqueue is busy; retry shortly')
    await sleep(20)
  }
  try {
    const previous = await queue.getJob(jobId)
    const state = previous ? await previous.getState() : null
    if (previous && reason === 'scheduled' && !['failed','completed'].includes(state!)) return
    await redis.multi().incr(dirty).expire(dirty, 604800).exec()
    if (previous && state === 'active') return
    const cooldown = options.force ? 0 : Math.max(0, Number(await redis.pttl(`ccm:refresh:backoff:${accountId}`)))
    const delay = options.force ? 0 : Math.max(cooldown, reason === 'request' ? 10_000 : 0)
    if (previous) {
      if (state === 'failed' || state === 'completed') await previous.remove().catch(() => {})
      else {
        const existingPriority = previous.priority || REFRESH_PRIORITY.scheduled
        if (priority < existingPriority) {
          await previous.changePriority({ priority })
          await previous.updateData({ ...previous.data, reason })
        }
        if (state === 'delayed') {
          // BullMQ encodes the actual scheduled time in its delayed score. Unlike timestamp+delay,
          // this remains correct after changeDelay and retry backoff (BullMQ 5 is pinned).
          const score = await redis.zscore(queue.toKey('delayed'), jobId)
          const existingDueAt = score === null ? null : Math.floor(Number(score) / 4096)
          if (existingDueAt !== null && Date.now() + delay < existingDueAt) {
            if (delay === 0) await previous.promote().catch(() => {})
            else await previous.changeDelay(delay).catch(() => {})
          }
        }
        return
      }
    }
    await queue.add('refresh', { accountId, reason }, { jobId, delay, priority })
  } finally {
    await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,1,lockKey,token).catch(() => {})
  }
}
export async function closeQueues() { await Promise.all([imports?.close(),refreshes?.close()]); imports=undefined;refreshes=undefined }