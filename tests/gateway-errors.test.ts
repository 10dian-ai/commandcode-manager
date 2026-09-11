import { describe, expect, it } from 'vitest'
import { classifyFailure } from '../server/lib/gateway/errors'
import { makeKernelHeaders } from '../server/lib/gateway/transport'

describe('real upstream error semantics', () => {
  it('records explicit per-model denial independently of rewritten HTTP status', () => {
    for (const status of [401, 403, 502]) {
      expect(classifyFailure(status, { error: { code: 'MODEL_NOT_IN_PLAN', message: 'Model not available in this plan' } }))
        .toMatchObject({ category: 'model_denied', safeToRetry: true, cooldownSeconds: 0 })
    }
  })
  it('does not confuse proxy-generated 429 errors with a definite unexecuted rejection', () => {
    expect(classifyFailure(429, { error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' } }))
      .toMatchObject({ category: 'empty_output', safeToRetry: false })
    expect(classifyFailure(429, { error: { type: 'rate_limit_error', message: 'Response timeout - request timed out' } }))
      .toMatchObject({ category: 'timeout', safeToRetry: false })
    expect(classifyFailure(429, { error: { type: 'rate_limit_error', message: 'Request failed' } }).safeToRetry).toBe(false)
    expect(classifyFailure(502, { error: { message: 'Connection reset after generation started' } }).safeToRetry).toBe(false)
  })
  it('separates exhausted quota, explicit invalid credentials and unknown authentication errors', () => {
    expect(classifyFailure(429, { error: { code: 'insufficient_credits' } })).toMatchObject({ category: 'quota', safeToRetry: true })
    expect(classifyFailure(401, { error: { code: 'invalid_api_key' } })).toMatchObject({ category: 'authentication', safeToRetry: true })
    expect(classifyFailure(401, { error: { message: 'Unauthorized' } })).toMatchObject({ category: 'authentication', safeToRetry: false })
  })
})

describe('gateway credentials are isolated from upstream credentials', () => {
  it('only supplies the selected account key and the explicit protocol/session headers', () => {
    const headers = makeKernelHeaders({
      authorization: 'Bearer downstream-only-secret',
      'x-api-key': 'another-client-secret',
      cookie: 'session=browser-secret',
      'x-forwarded-host': 'attacker.example',
      'anthropic-version': '2023-06-01',
      'x-session-id': 'conversation-a',
    }, 'selected-account-key')
    expect(headers.get('authorization')).toBe('Bearer selected-account-key')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-forwarded-host')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('x-session-id')).toBe('conversation-a')
  })
})