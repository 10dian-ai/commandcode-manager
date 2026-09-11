import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../../lib/db'
import { requireUuid } from '../../lib/http'
import { publishUpdate } from '../../lib/events'
export default defineEventHandler(async event => {
  const id = requireUuid(getRouterParam(event, 'id'))
  const parsed = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional() }).safeParse(await readBody(event))
  if (!parsed.success || !Object.keys(parsed.data).length) throw createError({ statusCode: 400, statusMessage: '无效的修改内容' })
  const rows = await getDb()`UPDATE gateway_keys SET name=coalesce(${parsed.data.name ?? null},name),enabled=coalesce(${parsed.data.enabled ?? null},enabled) WHERE id=${id} RETURNING id`
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: '密钥不存在' })
  await publishUpdate({ type: 'keys' }); return { ok: true }
})
