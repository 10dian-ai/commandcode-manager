import { z } from 'zod'
import { getDb } from './db'
import { DEFAULT_SETTINGS, type SystemSettings } from '../../shared/types'

export const settingsSchema = z.object({
  globalConcurrency: z.number().int().min(1).max(1000),
  defaultAccountConcurrency: z.number().int().min(1).max(100),
  activeRefreshSeconds: z.number().int().min(15).max(3600),
  idleRefreshSeconds: z.number().int().min(60).max(86400),
  activeWindowSeconds: z.number().int().min(60).max(86400),
  refreshConcurrency: z.number().int().min(1).max(10),
  refreshRatePerSecond: z.number().int().min(1).max(20),
  logRetentionDays: z.number().int().min(1).max(365),
  affinityTtlSeconds: z.number().int().min(60).max(604800),
  maxRequestBodyMb: z.number().int().min(1).max(64),
}).strict()
let cached: { value: SystemSettings; until: number } | undefined
export async function getSettings(): Promise<SystemSettings> {
  if (cached && cached.until > Date.now()) return { ...cached.value }
  const rows = await getDb()`SELECT value FROM app_settings WHERE id = 1`
  const value = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) })
  cached = { value, until: Date.now() + 5000 }
  return { ...value }
}
export async function saveSettings(input: SystemSettings): Promise<SystemSettings> {
  const value = settingsSchema.parse(input)
  await getDb()`INSERT INTO app_settings (id,value) VALUES (1,${getDb().json(value as any)})
    ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`
  cached = { value, until: Date.now() + 5000 }
  return value
}