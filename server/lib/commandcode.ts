import type { AccountSnapshot, UsageWindow } from '../../shared/types'

type Json = Record<string, unknown>
const object = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
export class CommandCodeError extends Error {
  constructor(public code: string, public status: number, public credentialExpired = false, public retryAfterMs = 0) {
    super(`Command Code ${code} (HTTP ${status})`)
    this.name = 'CommandCodeError'
  }
}
export function classifyUpstreamError(status: number, body: unknown, retryAfterMs = 0): CommandCodeError {
  const data = object(body), error = object(data?.error), nested = object(data?.data)
  const raw = text(error?.code) ?? text(data?.code) ?? text(data?.error) ?? text(nested?.code)
  const code = raw && /^[a-zA-Z0-9_-]{1,64}$/.test(raw) ? raw : `HTTP_${status}`
  const permission = ['MODEL_NOT_IN_PLAN', 'upgrade_required', 'model_not_in_plan', 'INSUFFICIENT_CREDITS', 'RATE_LIMITED'].includes(code)
  return new CommandCodeError(code, status, !permission && (status === 401 || ['INVALID_SESSION', 'SESSION_EXPIRED', 'UNAUTHORIZED', 'INVALID_TOKEN'].includes(code)), retryAfterMs)
}
export function unwrap(value: unknown): unknown {
  const obj = object(value)
  if (obj && obj.success === false) throw classifyUpstreamError(400, value)
  return obj && 'data' in obj ? obj.data : value
}
function window(value: unknown): UsageWindow | undefined {
  const v = object(value)
  if (!v || !['used','cap','resetAt'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k])) || typeof v.exceeded !== 'boolean') return undefined
  return { used: v.used as number, cap: v.cap as number, resetAt: v.resetAt as number, exceeded: v.exceeded }
}
export function buildSnapshot(session: unknown, creditsResponse: unknown, subscriptionsResponse: unknown, usageResponse: unknown): AccountSnapshot {
  const sessionData = object(unwrap(session)), user = object(sessionData?.user)
  if (!user || typeof user.id !== 'string') throw new CommandCodeError('INVALID_SESSION', 401, true)
  const creditsData = object(unwrap(creditsResponse))
  const credits = object(creditsData?.credits)
  if (!credits) throw new CommandCodeError('INVALID_CREDITS_RESPONSE', 502)
  const rawSubscription = unwrap(subscriptionsResponse)
  const subscriptionData = object(rawSubscription)
  if (rawSubscription !== null && (!subscriptionData || typeof subscriptionData.planId !== 'string' || typeof subscriptionData.status !== 'string')) throw new CommandCodeError('INVALID_SUBSCRIPTION_RESPONSE', 502)
  const subscription = subscriptionData
  const limits = object(creditsData?.windowLimits)
  const usage = object(unwrap(usageResponse))
  if (!usage) throw new CommandCodeError('INVALID_USAGE_RESPONSE', 502)
  return {
    identity: { id: user.id, name: text(user.name) ?? text(user.login) ?? user.id, email: text(user.email) },
    credits,
    windowLimits: limits ? {
      ...(typeof limits.limited === 'boolean' ? { limited: limits.limited } : {}),
      ...(limits.exceeded === null || typeof limits.exceeded === 'string' ? { exceeded: limits.exceeded } : {}),
      ...(window(limits.fiveHour) ? { fiveHour: window(limits.fiveHour) } : {}),
      ...(window(limits.weekly) ? { weekly: window(limits.weekly) } : {}),
    } : null,
    subscription: {
      planId: text(subscription?.planId), status: text(subscription?.status),
      currentPeriodStart: text(subscription?.currentPeriodStart), currentPeriodEnd: text(subscription?.currentPeriodEnd),
      cancelAtPeriodEnd: typeof subscription?.cancelAtPeriodEnd === 'boolean' ? subscription.cancelAtPeriodEnd : null,
    },
    usage, fetchedAt: new Date().toISOString(),
  }
}
export interface UpstreamKey { id: string; name: string; apiKey?: string }
export interface CatalogModel { id: string; name: string; metadata: Json }
export class CommandCodeClient {
  constructor(private options: { baseUrl?: string; fetch?: typeof fetch; beforeRequest?: () => Promise<void> } = {}) {}
  private async request(path: string, cookie?: string, body?: Json): Promise<unknown> {
    await this.options.beforeRequest?.()
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? 'https://api.commandcode.ai'}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(25_000),
        headers: { accept: 'application/json', origin: 'https://commandcode.ai', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch { throw new CommandCodeError('NETWORK_ERROR', 0) }
    let payload: unknown
    try { payload = await response.json() } catch { throw new CommandCodeError('INVALID_JSON_RESPONSE', response.status) }
    if (!response.ok || object(payload)?.success === false) {
      const retry = response.headers.get('retry-after')
      const retryMs = retry ? Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0
      throw classifyUpstreamError(response.status, payload, Math.max(0, Math.min(86_400_000, retryMs || 0)))
    }
    return payload
  }
  async session(cookie: string): Promise<unknown> {
    const data = await this.request('/auth/get-session', cookie)
    if (!object(data)?.user) throw new CommandCodeError('INVALID_SESSION', 401, true)
    return data
  }
  async snapshot(cookie: string, session?: unknown): Promise<AccountSnapshot> {
    const identity = session ?? await this.session(cookie)
    const credits = await this.request('/internal/billing/credits', cookie)
    const subscription = await this.request('/internal/billing/subscriptions', cookie)
    const usage = await this.request('/internal/usage/summary', cookie)
    return buildSnapshot(identity, credits, subscription, usage)
  }
  async listKeys(cookie: string): Promise<UpstreamKey[]> {
    const raw = await this.request('/internal/api-keys/list', cookie, { orgId: null })
    const list = Array.isArray(raw) ? raw : null
    if (!list) throw new CommandCodeError('INVALID_KEY_LIST_RESPONSE', 502)
    return list.map(object).filter((v): v is Json => !!v && typeof v.id === 'string' && typeof v.name === 'string')
      .map(v => ({ id: v.id as string, name: v.name as string, ...(typeof v.apiKey === 'string' ? { apiKey: v.apiKey } : {}) }))
  }
  async createKey(cookie: string, name: string): Promise<{ id: string | null; apiKey: string }> {
    const raw = object(unwrap(await this.request('/internal/api-keys/create', cookie, { orgId: null, name, description: 'Dedicated Command Code Manager key' })))
    if (!raw || typeof raw.apiKey !== 'string' || raw.apiKey.length < 10) throw new CommandCodeError('INVALID_KEY_CREATE_RESPONSE', 502)
    return { id: text(raw.id) ?? text(raw.apiKeyId), apiKey: raw.apiKey }
  }
  async deleteKey(cookie: string, id: string): Promise<void> {
    await this.request('/internal/api-keys/delete', cookie, { orgId: null, apiKeyId: id })
  }
  async catalog(cookie?: string): Promise<CatalogModel[]> {
    const raw = unwrap(await this.request('/provider/v1/models')), wrapped = object(raw)
    const list = Array.isArray(raw) ? raw : Array.isArray(wrapped?.models) ? wrapped.models : null
    if (!list) throw new CommandCodeError('INVALID_MODEL_CATALOG', 502)
    const result: CatalogModel[] = []
    for (const item of list) {
      const model = object(item), id = text(model?.id) ?? text(model?.modelId)
      if (model && id) result.push({ id, name: text(model.name) ?? id, metadata: model })
    }
    if (!result.length) throw new CommandCodeError('EMPTY_MODEL_CATALOG', 502)
    return result
  }
}