import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
await mkdir('.worker', { recursive: true })
await build({ entryPoints: { index: 'worker/index.ts', migrate: 'scripts/migrate.ts' }, outdir: '.worker', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true })
const result = spawnSync(process.execPath, ['scripts/build-core.mjs'], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status || 1)
