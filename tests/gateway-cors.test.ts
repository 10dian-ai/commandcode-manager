import { describe, expect, it } from 'vitest'
import { gatewayCors } from '../server/lib/gateway/cors'

describe('browser API CORS policy', () => {
  it('is restricted to the v1 namespace and never enables the admin API', () => {
    for (const path of ['/api/accounts', '/api/auth/login', '/api/keys', '/v10/models', '/dashboard']) {
      expect(gatewayCors(path, 'OPTIONS', 'authorization')).toBeNull()
    }
  })
  it('makes a keyless preflight a 204 and permits the actual API authentication headers', () => {
    const cors = gatewayCors('/v1/responses', 'OPTIONS', 'Authorization, Content-Type')
    expect(cors?.preflight).toBe(true)
    expect(cors?.statusCode).toBe(204)
    const allowed = cors!.headers['access-control-allow-headers']!.split(', ')
    expect(allowed).toContain('authorization')
    expect(allowed).toContain('x-api-key')
    expect(allowed).toContain('content-type')
    expect(cors!.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS')
  })
  it('does not mark an actual request as preflight, so it continues through key authentication', () => {
    for (const method of ['GET', 'POST']) {
      const cors = gatewayCors('/v1/models', method)
      expect(cors?.preflight).toBe(false)
      expect(cors?.statusCode).toBeNull()
      expect(cors!.headers['access-control-expose-headers']).toContain('x-request-id')
      expect(cors!.headers['access-control-expose-headers']).toContain('retry-after')
    }
  })
  it('allows bearer origins without enabling browser cookies', () => {
    const cors = gatewayCors('/v1/messages', 'OPTIONS', 'cookie')
    expect(cors!.headers['access-control-allow-origin']).toBe('*')
    expect(cors!.headers['access-control-allow-credentials']).toBeUndefined()
    expect(cors!.headers['access-control-allow-headers']!.split(', ')).not.toContain('cookie')
  })
  it('permits Anthropic/session headers plus bounded SDK and custom-client metadata', () => {
    const cors = gatewayCors('/v1/chat/completions', 'OPTIONS',
      'X-Stainless-Package-Version, x-client-trace-id, x-client-build, x-unrelated-header')
    const allowed = cors!.headers['access-control-allow-headers']!.split(', ')
    for (const header of ['anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
      'x-session-id', 'x-claude-code-session-id', 'x-codex-session-id', 'x-agent-id', 'x-subagent-id',
      'x-stainless-package-version', 'x-client-trace-id', 'x-client-build']) expect(allowed).toContain(header)
    expect(allowed).not.toContain('x-unrelated-header')
  })
  it('does not reflect malformed headers or credential-mode controls', () => {
    const cors = gatewayCors('/v1/responses', 'OPTIONS',
      'x-client-good, x-client-bad\r\nAccess-Control-Allow-Credentials: true, cookie, proxy-authorization')
    expect(cors!.headers['access-control-allow-headers']).toContain('x-client-good')
    expect(cors!.headers['access-control-allow-headers']).not.toMatch(/[\r\n]/)
    expect(cors!.headers['access-control-allow-headers']).not.toContain('proxy-authorization')
  })
})