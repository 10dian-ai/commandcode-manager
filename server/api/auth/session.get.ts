import { defineEventHandler } from 'h3'
import { getAdminSession } from '../../lib/auth'
export default defineEventHandler(async event => {
  const session = await getAdminSession(event)
  return { authenticated: !!session, username: session?.username ?? null }
})
