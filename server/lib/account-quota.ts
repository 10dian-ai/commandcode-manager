import type { AccountSnapshot } from '../../shared/types'
import { getMonthlyRemaining, getQuotaBlock, getQuotaWindows } from '../../shared/quota'
import { getDb } from './db'

// Snapshot and pause ownership change in the same statement. Evaluate the current
// database flags so a concurrent manual disable can never be claimed by the worker.
// Compare the initially read snapshot so a delayed response cannot overwrite a newer sync.
export async function saveAccountSnapshot(id: string, fingerprint: string, snapshot: AccountSnapshot, expectedPreviousSnapshot: AccountSnapshot | null) {
  const sql = getDb(), block = getQuotaBlock(snapshot, Date.now(), false)
  const observed = confirmedQuotaReasons(snapshot)
  return sql`UPDATE managed_accounts SET snapshot=${sql.json(snapshot as any)},email=${snapshot.identity.email},last_sync_at=now(),updated_at=now(),
    enabled=CASE WHEN ${block.blocked} THEN false ELSE enabled END,
    quota_paused=CASE WHEN ${block.blocked} THEN (enabled OR quota_paused) ELSE quota_paused END,
    quota_resume_at=CASE WHEN quota_paused AND NOT (quota_pause_reasons <@ ${sql.array(observed)}::text[]) THEN NULL
      WHEN enabled OR quota_paused THEN ${block.resetAt}::timestamptz ELSE NULL END,
    quota_pause_reasons=CASE WHEN ${block.blocked} AND (enabled OR quota_paused) THEN ARRAY(SELECT DISTINCT reason FROM unnest(quota_pause_reasons || ${sql.array(block.reasons)}::text[]) AS reason) ELSE quota_pause_reasons END
    WHERE id=${id} AND credential_fingerprint=${fingerprint}
      AND snapshot IS NOT DISTINCT FROM ${expectedPreviousSnapshot === null ? null : sql.json(expectedPreviousSnapshot as any)}::jsonb RETURNING id`
}

function confirmedQuotaReasons(snapshot: AccountSnapshot): string[] {
  const windows = getQuotaWindows(snapshot)
  const confirmed = Object.entries(windows).filter(([, window]) => !!window).map(([key]) => key)
  if (!windows.monthly && (getMonthlyRemaining(snapshot) ?? 0) > 0) confirmed.push('monthly')
  if (snapshot.windowLimits?.exceeded === null && confirmed.length) confirmed.push('unknown')
  return confirmed
}

export async function completeAccountSync(id: string, fingerprint: string, snapshot: AccountSnapshot) {
  const sql = getDb(), block = getQuotaBlock(snapshot, Date.now(), false)
  const confirmed = confirmedQuotaReasons(snapshot)
  // A missing window is not evidence of recovery. Every reason that originally
  // paused this account must now have a valid, non-exhausted upstream observation.
  const recover = sql`(quota_paused AND ${!block.blocked} AND quota_pause_reasons <@ ${sql.array(confirmed)}::text[])`
  return sql`UPDATE managed_accounts SET status='ready',sync_error=NULL,updated_at=now(),
    enabled=CASE WHEN ${recover} THEN true ELSE enabled END,
    quota_paused=CASE WHEN ${recover} THEN false ELSE quota_paused END,
    quota_resume_at=CASE WHEN ${recover} THEN NULL ELSE quota_resume_at END,
    quota_pause_reasons=CASE WHEN ${recover} THEN '{}'::text[] ELSE quota_pause_reasons END
    WHERE id=${id} AND credential_fingerprint=${fingerprint} AND snapshot=${sql.json(snapshot as any)}::jsonb RETURNING id`
}
