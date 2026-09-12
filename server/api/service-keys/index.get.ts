import { defineEventHandler } from 'h3'
import { getDb } from '../../lib/db'
export default defineEventHandler(async () => {
  const rows = await getDb()`SELECT id,name,prefix,enabled,created_at,last_used_at FROM service_keys ORDER BY created_at DESC`
  return { items: rows.map(row => ({ id: row.id, name: row.name, prefix: row.prefix, enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null })) }
})
