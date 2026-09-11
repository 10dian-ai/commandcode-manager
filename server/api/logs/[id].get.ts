import { defineEventHandler, getRouterParam, createError } from 'h3'
import { getDb } from '../../lib/db'
import { requireUuid } from '../../lib/http'
export default defineEventHandler(async event => {
  const rows = await getDb()`SELECT l.*,a.label AS account_label,k.name AS key_name FROM request_logs l
    LEFT JOIN managed_accounts a ON a.id=l.account_id LEFT JOIN gateway_keys k ON k.id=l.key_id WHERE l.id=${requireUuid(getRouterParam(event,'id'))}`
  const r = rows[0]
  if (!r) throw createError({statusCode:404,statusMessage:'日志不存在或已清理'})
  return {id:r.id,accountId:r.account_id,accountLabel:r.account_label,keyName:r.key_name,model:r.model,protocol:r.protocol,status:r.status,httpStatus:r.http_status,
    durationMs:r.duration_ms,streaming:r.streaming,usage:r.usage,errorMessage:r.error_message,responseTruncated:r.response_truncated,createdAt:new Date(r.created_at).toISOString(),
    requestBody:r.request_body,responseBody:r.response_body,sessionId:r.session_id}
})
