import { defineEventHandler, getHeader, getRequestURL, createError, setHeader } from 'h3'
import { requireAdmin } from '../lib/auth'
export default defineEventHandler(async event => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  setHeader(event, 'Cache-Control', 'no-store')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.method)) {
    const origin = getHeader(event, 'origin')
    if (origin && new URL(origin).host !== getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).host)
      throw createError({ statusCode: 403, statusMessage: '请求来源不匹配' })
  }
  if (['/api/auth/session', '/api/auth/login'].includes(path)) return
  await requireAdmin(event)
})
