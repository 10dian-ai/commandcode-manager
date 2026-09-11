import { randomUUID } from 'node:crypto'
import { getDb } from './db'
export interface RequestLogInput {
  id?: string; keyId: string | null; accountId: string | null; model: string
  protocol: 'chat/completions' | 'messages' | 'responses'; sessionId: string | null
  status: 'success' | 'error' | 'cancelled' | 'incomplete'; httpStatus: number | null
  durationMs: number; streaming: boolean; usage: Record<string, unknown> | null
  errorMessage: string | null; requestBody: unknown; responseBody: unknown; responseTruncated: boolean
}
export function redactLogFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogFields)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(authorization|cookie|api[_-]?key|password|access_token|refresh_token|session_token)$/i.test(key) ? '[redacted]' : redactLogFields(item)]))
  return value
}
export async function insertRequestLog(input: RequestLogInput) {
  const json = (value: unknown) => value === null || value === undefined ? null : JSON.stringify(redactLogFields(value))
  const id = input.id ?? randomUUID()
  const write = async (keyId: string | null, accountId: string | null) => {
    await getDb()`INSERT INTO request_logs(id,key_id,account_id,model,protocol,session_id,status,http_status,duration_ms,streaming,usage,error_message,request_body,response_body,response_truncated)
      VALUES(${id},(SELECT id FROM gateway_keys WHERE id=${keyId}),(SELECT id FROM managed_accounts WHERE id=${accountId}),
      ${input.model},${input.protocol},${input.sessionId},${input.status},${input.httpStatus},${input.durationMs},${input.streaming},
      ${json(input.usage)}::jsonb,${input.errorMessage},${json(input.requestBody)}::jsonb,${json(input.responseBody)}::jsonb,${input.responseTruncated})
      ON CONFLICT(id) DO NOTHING`
  }
  try { await write(input.keyId, input.accountId) }
  catch (error) {
    // A referenced account/key can disappear while a request finishes. Keep the payload.
    if ((error as { code?: string }).code !== '23503') throw error
    await write(null, null)
  }
  return { id }
}
