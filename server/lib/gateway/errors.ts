export type GatewayErrorCategory = 'model_denied' | 'quota' | 'rate_limit' | 'authentication' | 'timeout' | 'empty_output' | 'upstream_error'
export interface UpstreamFailure {
  category: GatewayErrorCategory
  message: string
  safeToRetry: boolean
  cooldownSeconds: number
}
function errorDescription(body: unknown): string {
  if (typeof body === 'string') {
    try { return errorDescription(JSON.parse(body)) } catch { return body.slice(0, 4000) }
  }
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  const error = b.error && typeof b.error === 'object' ? b.error as Record<string, unknown> : {}
  return [error.code, error.type, error.message, b.code, b.type, b.message,
    typeof b.error === 'string' ? b.error : null]
    .filter(value => typeof value === 'string' && value).join(' | ').slice(0, 4000)
}
export function classifyFailure(status: number, body: unknown): UpstreamFailure {
  const message = errorDescription(body) || 'Upstream returned HTTP ' + status
  const result = (category: GatewayErrorCategory, safeToRetry = false, cooldownSeconds = 0) =>
    ({ category, message, safeToRetry, cooldownSeconds })
  // The core may map model denial to 401 or an unrecognised stream error to 502.
  // Only this explicit semantic code establishes a per-model denial.
  if (/\bMODEL_NOT_IN_PLAN\b/i.test(message)) return result('model_denied', true)
  if (/empty response|zero output tokens/i.test(message)) return result('empty_output', false, 15)
  if (/timeout|timed out|ETIMEDOUT|STREAM_IDLE_TIMEOUT/i.test(message)) return result('timeout', false, 15)
  if (/\b(insufficient_quota|insufficient_credits|credits_exhausted|payment_required|weekly_limit_exceeded|five_hour_limit_exceeded)\b|insufficient credits|credit balance (?:is )?exhausted|(?:weekly|5.hour|five.hour) (?:usage )?limit (?:reached|exceeded)/i.test(message))
    return result('quota', true, 60)
  if (/\b(invalid_api_key|invalid_token|expired_token)\b|invalid api key|api key (?:is )?(?:invalid|expired)/i.test(message))
    return result('authentication', true, 60)
  if (status === 401 || status === 403) return result('authentication', false, 30)
  if (status === 429) {
    // rate_limit_error alone is also produced by the core on empty output and timeout.
    const explicit = /\bRATE_LIMIT_EXCEEDED\b|too many requests|rate limit exceeded/i.test(message)
    return result('rate_limit', explicit, 15)
  }
  return result('upstream_error', false, 10)
}