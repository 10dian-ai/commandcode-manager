export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  telemetry: false,
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  app: { head: { htmlAttrs: { lang: 'zh-CN' }, title: 'Command Code Manager', meta: [{ name: 'description', content: '账号、额度和模型调用管理' }] } },
  ui: { colorMode: false, fonts: false },
  icon: { serverBundle: { collections: ['ph'] } },
  nitro: { preset: 'node-server', experimental: { tasks: false } },
  typescript: { strict: true },
})
