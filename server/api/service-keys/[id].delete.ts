import { defineEventHandler, getRouterParam } from 'h3'
import { getDb } from '../../lib/db'
import { requireUuid } from '../../lib/http'
import { publishUpdate } from '../../lib/events'
export default defineEventHandler(async event => {
  await getDb()`DELETE FROM service_keys WHERE id=${requireUuid(getRouterParam(event, 'id'))}`
  await publishUpdate({ type: 'keys' })
  return { ok: true }
})
