import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError, deleteCookie, getCookie, getHeader, setCookie, type H3Event } from 'h3'
import { getConfig } from './config'
import { getDb } from './db'
import { getRedis } from './redis'
import { hashGatewayKey } from './crypto'
const COOKIE = 'ccm_session'
const SESSION_TTL = 7 * 24 * 3600
const digest = (value: string) => createHash('sha256').update(value).digest()
const sessionKey = (token: string) => 'ccm:admin:session:' + hashGatewayKey(token)
export function validAdminCredentials(username: string, password: string) {
  const config = getConfig()
  return timingSafeEqual(digest(username), digest(config.adminUsername)) && timingSafeEqual(digest(password), digest(config.adminPassword))
}
export async function getAdminSession(event: H3Event): Promise<{ username: string } | null> {
  const token = getCookie(event, COOKIE)
  if (!token) return null
  const username = await getRedis().get(sessionKey(token))
  return username ? { username } : null
}
export async function requireAdmin(event: H3Event) {
  const session = await getAdminSession(event)
  if (!session) throw createError({ statusCode: 401, statusMessage: '请先登录管理后台' })
  return session
}
export async function startAdminSession(event: H3Event) {
  const config = getConfig(); const token = randomBytes(32).toString('base64url')
  await getRedis().set(sessionKey(token), config.adminUsername, 'EX', SESSION_TTL)
  setCookie(event, COOKIE, token, { httpOnly: true, secure: new URL(config.appUrl).protocol === 'https:', sameSite: 'strict', path: '/', maxAge: SESSION_TTL })
}
export async function endAdminSession(event: H3Event) {
  const token = getCookie(event, COOKIE)
  if (token) await getRedis().del(sessionKey(token))
  deleteCookie(event, COOKIE, { path: '/' })
}
export async function authenticateGatewayKey(secret: string): Promise<{ id: string; name: string } | null> {
  if (!secret.startsWith('ccm_') || secret.startsWith('ccm_service_') || secret.length > 200) return null
  const db = getDb()
  const rows = await db<{ id: string; name: string }[]> `SELECT id,name FROM gateway_keys WHERE secret_hash=${hashGatewayKey(secret)} AND enabled=true LIMIT 1`
  const key = rows[0]
  if (!key) return null
  await db`UPDATE gateway_keys SET last_used_at=now() WHERE id=${key.id} AND (last_used_at IS NULL OR last_used_at < now()-interval '1 minute')`
  return key
}
export async function authenticateServiceKey(secret: string): Promise<{ id: string; name: string } | null> {
  if (!/^ccm_service_[A-Za-z0-9_-]{43}$/.test(secret)) return null
  const db = getDb()
  const rows = await db<{ id: string; name: string }[]>`SELECT id,name FROM service_keys WHERE secret_hash=${hashGatewayKey(secret)} AND enabled=true LIMIT 1`
  const key = rows[0]
  if (!key) return null
  await db`UPDATE service_keys SET last_used_at=now() WHERE id=${key.id} AND (last_used_at IS NULL OR last_used_at < now()-interval '1 minute')`
  return key
}
export async function requireServiceKey(event: H3Event) {
  const authorization = getHeader(event, 'authorization')
  const bearer = authorization && /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : null
  const secret = bearer || getHeader(event, 'x-api-key')?.trim()
  const key = secret ? await authenticateServiceKey(secret) : null
  if (!key) throw createError({ statusCode: 401, statusMessage: 'A valid external service key is required' })
  return key
}
