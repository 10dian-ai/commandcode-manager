import postgres, { type Sql } from 'postgres'
import { getConfig } from './config'
let database: Sql | undefined
export function getDb(): Sql {
  database ??= postgres(getConfig().databaseUrl, { max: 10, connect_timeout: 10, idle_timeout: 20, max_lifetime: 1800, onnotice: () => {} })
  return database
}
export async function closeDb() { if (database) { await database.end({ timeout: 5 }); database = undefined } }
