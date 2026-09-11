import { access, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
const file = '.env'
try { await access(file); console.log('.env already exists; nothing changed.'); process.exit(0) } catch {}
const secret = () => randomBytes(24).toString('base64url')
const db = secret(), redis = secret(), admin = secret()
const lines = [
  'APP_URL=http://localhost:3000', 'APP_PORT=3000', 'BIND_ADDRESS=127.0.0.1',
  'ADMIN_USERNAME=admin', 'ADMIN_PASSWORD=' + admin,
  'APP_ENCRYPTION_KEY=' + randomBytes(32).toString('base64'),
  'POSTGRES_PASSWORD=' + db, 'REDIS_PASSWORD=' + redis,
  'DATABASE_URL=postgres://ccm:' + db + '@127.0.0.1:55432/commandcode',
  'REDIS_URL=redis://:' + redis + '@127.0.0.1:56379/0',
  'KERNEL_URL=http://127.0.0.1:3050', '',
]
await writeFile(file, lines.join('\n'), { mode: 0o600, flag: 'wx' })
console.log('Created .env with random credentials. Administrator username: admin. Read ADMIN_PASSWORD locally in .env.')
