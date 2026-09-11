import { defineEventHandler } from 'h3'
import { endAdminSession } from '../../lib/auth'
export default defineEventHandler(async event => { await endAdminSession(event); return { ok: true } })
