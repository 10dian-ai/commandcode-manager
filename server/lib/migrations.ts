import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Sql } from 'postgres'
import { getDb } from './db'

// Importing this module never connects to or closes a database. Both entry points call it explicitly.
export async function migrate(sql: Sql = getDb()): Promise<void> {
  const directory = path.resolve(process.cwd(), 'db/migrations')
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71645201)`
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    for (const name of (await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      if ((await tx`SELECT name FROM schema_migrations WHERE name=${name}`).length) continue
      await tx.unsafe(await readFile(path.join(directory, name), 'utf8')).simple()
      await tx`INSERT INTO schema_migrations(name) VALUES (${name})`
    }
  })
}