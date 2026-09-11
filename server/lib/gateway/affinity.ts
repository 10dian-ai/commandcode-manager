import { createHash } from 'node:crypto'

export interface AffinityInput {
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  keyId: string
}
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 4096)
  }
  return null
}
export function extractAffinity({ headers, body, keyId }: AffinityInput) {
  const metadata = body.metadata && typeof body.metadata === 'object'
    ? body.metadata as Record<string, unknown> : {}
  const sessionId = firstString(headers['x-session-id'], headers['x-claude-code-session-id'],
    headers['x-codex-session-id'], body.session_id, metadata.session_id, body.prompt_cache_key)
  const agentId = firstString(headers['x-agent-id'], headers['x-subagent-id'], body.agent_id,
    metadata.agent_id, metadata.subagent_id)
  // A gateway key namespaces explicit sessions; it never creates a session itself.
  const affinityHash = sessionId
    ? createHash('sha256').update(JSON.stringify([keyId, sessionId, agentId])).digest('hex') : null
  return { sessionId, agentId, affinityHash }
}