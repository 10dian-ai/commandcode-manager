<script setup lang="ts">
definePageMeta({ layout: false })
useHead({ title: '登录 · Command Code Manager' })
const username = ref('')
const password = ref('')
const route = useRoute()
const { ensureSession } = useAuth()
const { busy, run } = useApiAction()
async function submit() {
  const result = await run(() => $fetch('/api/auth/login', { method: 'POST', body: { username: username.value, password: password.value } }))
  if (result.ok) {
    password.value = ''
    await ensureSession(true)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await navigateTo(redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.startsWith('/login') ? redirect : '/')
  }
}
</script>
<template>
  <main class="login-page"><div class="login-brand"><UIcon name="i-ph-command-bold" /><span>Command Code Manager</span></div><section class="login-panel"><p class="eyebrow">管理员工作空间</p><h1>登录管理工作台</h1><p class="muted">集中管理账号、查看真实额度与调用记录。</p><form class="form-stack login-form" @submit.prevent="submit"><label class="field"><span>管理员用户名</span><input v-model="username" autocomplete="username" required autofocus placeholder="输入管理员用户名"></label><label class="field"><span>密码</span><input v-model="password" type="password" autocomplete="current-password" required placeholder="输入管理员密码"></label><button class="button primary login-submit" :disabled="busy"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />{{ busy ? '正在登录' : '登录' }}<UIcon v-if="!busy" name="i-ph-arrow-right-bold" /></button></form></section><p class="login-footnote">使用部署时设置的管理员账号登录。</p></main>
</template>
