import 'dotenv/config'
import { migrate } from '../server/lib/migrations'
import { closeDb } from '../server/lib/db'

migrate().then(() => closeDb()).catch(async () => {
  console.error('Database migration failed; check connection and migration compatibility.')
  await closeDb()
  process.exitCode = 1
})