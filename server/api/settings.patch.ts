import { defineEventHandler, readBody, createError } from 'h3'
import { saveSettings, settingsSchema } from '../lib/settings'
import { publishUpdate } from '../lib/events'
export default defineEventHandler(async event => {
  const parsed = settingsSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '设置值超出允许范围', data: parsed.error.flatten() })
  await saveSettings(parsed.data)
  await publishUpdate({ type: 'settings' })
  return { settings: parsed.data, kernel: { version: '0.1.0', upstreamCommit: '621730578ff95b56a1df77e3dda3396cdfd2c585', cliVersion: '1.53.0' } }
})
