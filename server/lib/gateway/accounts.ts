import { getDb } from '../db'
import type { AccountSnapshot } from '../../../shared/types'
import type { UpstreamFailure } from './errors'
import { getRedis } from '../redis'
import { cooldownAccount } from './scheduler'
import { snapshotIsLimited } from './quota'

export interface GatewayAccount { id: string; apiKeyCiphertext: string; limit: number }
export async function listCandidates(model: string): Promise<GatewayAccount[]> {
  const sql = getDb()
  const rows = await sql<{ id: string; api_key_ciphertext: string; max_concurrency: number; snapshot: AccountSnapshot | null }[]>`
    SELECT a.id, a.api_key_ciphertext, a.max_concurrency, a.snapshot
    FROM managed_accounts a
    LEFT JOIN account_models m ON m.account_id = a.id AND m.model_id = ${model}
    WHERE a.enabled = TRUE AND a.status = 'ready' AND a.api_key_ciphertext IS NOT NULL
      AND (m.status IS NULL OR m.status <> 'denied')
      AND (m.status IS NULL OR m.status <> 'cooldown' OR m.cooldown_until <= NOW() OR m.cooldown_until IS NULL)
    ORDER BY a.last_used_at ASC NULLS FIRST, a.id
  `
  return rows.filter(row => !snapshotIsLimited(row.snapshot)).map(row => ({
    id: row.id, apiKeyCiphertext: row.api_key_ciphertext, limit: row.max_concurrency,
  }))
}
export async function touchAccount(accountId: string) {
  await getDb()`UPDATE managed_accounts SET last_used_at = NOW() WHERE id = ${accountId}`
}
export async function recordModelAllowed(accountId: string, model: string) {
  await getDb()`
    INSERT INTO account_models (account_id, model_id, status, reason, cooldown_until, last_checked_at)
    VALUES (${accountId}, ${model}, 'allowed', NULL, NULL, NOW())
    ON CONFLICT (account_id, model_id) DO UPDATE
      SET status = 'allowed', reason = NULL, cooldown_until = NULL, last_checked_at = NOW()
  `
}
export async function recordFailure(accountId: string, model: string, failure: UpstreamFailure) {
  if (failure.category === 'model_denied') {
    await getDb()`
      INSERT INTO account_models (account_id, model_id, status, reason, cooldown_until, last_checked_at)
      VALUES (${accountId}, ${model}, 'denied', ${failure.message}, NULL, NOW())
      ON CONFLICT (account_id, model_id) DO UPDATE
        SET status = 'denied', reason = EXCLUDED.reason, cooldown_until = NULL, last_checked_at = NOW()
    `
  } else if (failure.cooldownSeconds > 0) {
    await cooldownAccount(getRedis(), accountId, failure.cooldownSeconds)
  }
  // A proxy HTTP 401 can mean a model denial. Never abandon/disable the account here.
}
export async function listGatewayModels() {
  const rows = await getDb()<{
    id: string; name: string; observed_allowed: number; observed_denied: number; unknown_accounts: number; created: number
  }[]>`
    WITH ready AS (
      SELECT id FROM managed_accounts
      WHERE enabled = TRUE AND status = 'ready' AND api_key_ciphertext IS NOT NULL
    ), ids AS (
      SELECT model_id FROM model_catalog
      UNION SELECT m.model_id FROM account_models m JOIN ready a ON a.id = m.account_id
    )
    SELECT ids.model_id AS id, COALESCE(c.name, ids.model_id) AS name,
      COUNT(*) FILTER (WHERE m.status = 'allowed')::int AS observed_allowed,
      COUNT(*) FILTER (WHERE m.status = 'denied')::int AS observed_denied,
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND (m.status IS NULL OR m.status = 'cooldown'))::int AS unknown_accounts,
      COALESCE(EXTRACT(EPOCH FROM MIN(c.updated_at))::bigint, 0)::int AS created
    FROM ids LEFT JOIN model_catalog c ON c.model_id = ids.model_id
    LEFT JOIN ready a ON TRUE
    LEFT JOIN account_models m ON m.account_id = a.id AND m.model_id = ids.model_id
    GROUP BY ids.model_id, c.name
    HAVING COUNT(*) FILTER (WHERE a.id IS NOT NULL AND (m.status IS NULL OR m.status <> 'denied')) > 0
    ORDER BY ids.model_id
  `
  return {
    object: 'list',
    data: rows.map(row => ({
      id: row.id, object: 'model', created: Number(row.created), owned_by: 'commandcode', name: row.name,
      availability: { observedAllowed: row.observed_allowed, observedDenied: row.observed_denied, unknownAccounts: row.unknown_accounts },
    })),
  }
}