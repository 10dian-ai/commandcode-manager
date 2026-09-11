import { defineEventHandler, readBody, createError, getRequestIP } from 'h3'
import { z } from 'zod'
import { startAdminSession, validAdminCredentials } from '../../lib/auth'
import { getRedis } from '../../lib/redis'
import { hashGatewayKey } from '../../lib/crypto'
const input = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(512) })
export default defineEventHandler(async event => {
  const parsed = input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '请填写用户名和密码' })
  const redis = getRedis(); const key = 'ccm:login:' + hashGatewayKey(getRequestIP(event, { xForwardedFor: true }) ?? 'unknown')
  const attempts = Number(await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n", 1, key))
  if (attempts > 20) throw createError({ statusCode: 429, statusMessage: '尝试过于频繁，请稍后再试' })
  if (!validAdminCredentials(parsed.data.username, parsed.data.password)) throw createError({ statusCode: 401, statusMessage: '用户名或密码不正确' })
  await startAdminSession(event); await redis.del(key)
  return { ok: true }
})
