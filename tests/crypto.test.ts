import { beforeEach, describe, expect, it } from 'vitest'
import { resetConfigForTests } from '../server/lib/config'
import { encryptSecret, decryptSecret, fingerprint } from '../server/lib/crypto'
import { redactLogFields } from '../server/lib/logs'
beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.ADMIN_PASSWORD = 'test-only-password'
  process.env.DATABASE_URL = 'postgres://unused'
  process.env.REDIS_URL = 'redis://localhost'
  resetConfigForTests()
})
describe('credential protection', () => {
  it('uses randomized authenticated ciphertext while keeping stable import fingerprints', () => {
    const a = encryptSecret('test-cookie-value'), b = encryptSecret('test-cookie-value')
    expect(a).not.toBe(b); expect(a).not.toContain('test-cookie-value')
    expect(decryptSecret(a)).toBe('test-cookie-value')
    expect(fingerprint('test-cookie-value')).toBe(fingerprint('test-cookie-value'))
  })
  it('rejects tampering and another master key', () => {
    const encrypted = encryptSecret('private')
    const parts = encrypted.split('.'); const tag = Buffer.from(parts[2]!, 'base64url'); tag[0] = tag[0]! ^ 1; parts[2] = tag.toString('base64url')
    expect(() => decryptSecret(parts.join('.'))).toThrow()
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64'); resetConfigForTests()
    expect(() => decryptSecret(encrypted)).toThrow()
  })
  it('redacts credentials without removing token usage or business messages', () => {
    expect(redactLogFields({ authorization: 'secret', max_tokens: 128, nested: { apiKey: 'secret' }, messages: [{ content: 'hello' }] }))
      .toEqual({ authorization: '[redacted]', max_tokens: 128, nested: { apiKey: '[redacted]' }, messages: [{ content: 'hello' }] })
  })
})
