import { describe, expect, it } from 'vitest'
import { extractAffinity } from '../server/lib/gateway/affinity'

describe('session affinity identity', () => {
  it('does not bind every request sharing one gateway key to one account', () => {
    expect(extractAffinity({ headers: {}, body: {}, keyId: 'same-key' }).affinityHash).toBeNull()
    expect(extractAffinity({ headers: {}, body: { metadata: { user_id: 'same-user' } }, keyId: 'same-key' }).affinityHash).toBeNull()
  })
  it('keeps a session stable, separates client keys and separates concurrent subagents', () => {
    const base = { headers: { 'x-session-id': 'conversation-1' }, body: {}, keyId: 'key-1' }
    const hash = extractAffinity(base).affinityHash
    expect(hash).toBeTruthy()
    expect(extractAffinity(base).affinityHash).toBe(hash)
    expect(extractAffinity({ ...base, keyId: 'key-2' }).affinityHash).not.toBe(hash)
    expect(extractAffinity({ ...base, body: { agent_id: 'parallel-agent' } }).affinityHash).not.toBe(hash)
    expect(extractAffinity({ ...base, headers: { 'x-session-id': 'conversation-2' } }).affinityHash).not.toBe(hash)
  })
  it('reads Claude session and explicit body IDs while preserving header priority', () => {
    expect(extractAffinity({ headers: { 'x-claude-code-session-id': 'claude-1' }, body: {}, keyId: 'k' }).sessionId).toBe('claude-1')
    expect(extractAffinity({ headers: {}, body: { session_id: 'body-session' }, keyId: 'k' }).sessionId).toBe('body-session')
    expect(extractAffinity({ headers: {}, body: { prompt_cache_key: 'cache-session' }, keyId: 'k' }).sessionId).toBe('cache-session')
    expect(extractAffinity({ headers: { 'x-session-id': 'header' }, body: { prompt_cache_key: 'body' }, keyId: 'k' }).sessionId).toBe('header')
  })
})