const STANDARD_HEADERS = [
  'authorization', 'content-type', 'accept', 'x-api-key',
  'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'openai-beta', 'openai-organization', 'openai-project',
  'x-session-id', 'x-claude-code-session-id', 'x-codex-session-id',
  'x-agent-id', 'x-subagent-id', 'x-request-id',
  'x-client-name', 'x-client-version',
]

export interface GatewayCors {
  headers: Record<string, string>
  preflight: boolean
  statusCode: 204 | null
}

/** Public API keys authenticate /v1; the admin cookie API never shares this policy. */
export function gatewayCors(pathname: string, method: string, requestedHeaders?: string | string[]): GatewayCors | null {
  if (!/^\/v1(?:\/|$)/.test(pathname)) return null
  const allowed = new Set(STANDARD_HEADERS)
  // Browser SDK metadata and application-specific client metadata can evolve.
  // Extend only these namespaces, without reflecting cookies or arbitrary headers.
  const requested = (Array.isArray(requestedHeaders) ? requestedHeaders.join(',') : requestedHeaders || '').slice(0, 4096)
  for (const value of requested.split(',').slice(0, 64)) {
    const header = value.trim().toLowerCase()
    if (/^x-(?:client|stainless)-[a-z0-9-]{1,64}$/.test(header)) allowed.add(header)
  }
  const preflight = method.toUpperCase() === 'OPTIONS'
  const headers: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': [...allowed].join(', '),
    'access-control-expose-headers': 'x-request-id, retry-after',
    vary: 'Access-Control-Request-Headers',
  }
  if (preflight) headers['access-control-max-age'] = '600'
  // Deliberately omit Access-Control-Allow-Credentials. Cookie-based browser
  // credentials are incompatible with this wildcard origin policy.
  return { headers, preflight, statusCode: preflight ? 204 : null }
}