import { defineConfig } from 'vitest/config'
export default defineConfig({
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { target: 'ES2022', useDefineForClassFields: true } }) },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000, fileParallelism: false },
})
