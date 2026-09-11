import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { getConfig } from './config'
const aad = Buffer.from('commandcode-manager:credential:v1')
function secretKey() { return Buffer.from(getConfig().encryptionKey, 'base64') }
export function encryptSecret(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}
export function decryptSecret(value: string): string {
  const [version, iv, tag, body] = value.split('.')
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Invalid encrypted credential')
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'))
  decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}
export function fingerprint(value: string): string { return createHmac('sha256', secretKey()).update('credential:').update(value).digest('hex') }
export function hashGatewayKey(value: string): string { return createHash('sha256').update(value).digest('hex') }
