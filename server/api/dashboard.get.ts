import { defineEventHandler } from 'h3'
import type { DashboardView } from '../../shared/types'
import { getDb } from '../lib/db'
import { getRedis } from '../lib/redis'
import { getConfig } from '../lib/config'
export default defineEventHandler(async (): Promise<DashboardView> => {
  const db = getDb(); const redis = getRedis()
  const [accounts, requests, heartbeat, inFlight, kernel] = await Promise.all([
    db`SELECT count(*)::int AS total,count(*) FILTER(WHERE enabled)::int AS enabled,
      count(*) FILTER(WHERE enabled AND status='ready' AND api_key_ciphertext IS NOT NULL)::int AS ready,
      count(*) FILTER(WHERE enabled AND status IN ('credential_expired','sync_error'))::int AS attention,
      count(*) FILTER(WHERE last_sync_at IS NULL)::int AS pending,max(last_sync_at) AS last_sync_at FROM managed_accounts`,
    db`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='success')::int AS success,count(*) FILTER(WHERE status='error')::int AS failed FROM request_logs`,
    redis.get('ccm:worker:heartbeat'),
    redis.zcount('ccm:gateway:leases:global', Date.now(), '+inf'),
    fetch(getConfig().kernelUrl + '/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false),
  ])
  const a = accounts[0]!; const r = requests[0]!
  return {
    counts: { total: a.total, enabled: a.enabled, ready: a.ready, needsAttention: a.attention, notSynced: a.pending },
    requests: { total: r.total, success: r.success, failed: r.failed, inFlight },
    services: { database: true, redis: true, workerLastSeen: heartbeat, kernel },
    lastSyncAt: a.last_sync_at ? new Date(a.last_sync_at).toISOString() : null,
  }
})
