<script setup lang="ts">
const route = useRoute()
const { session } = useAuth()
const { connection } = useLiveUpdates()
const mobileOpen = ref(false)
const links = [
  { to: '/', label: '概览', icon: 'i-ph-squares-four-bold' },
  { to: '/accounts', label: '账号管理', icon: 'i-ph-users-three-bold' },
  { to: '/models', label: '模型目录', icon: 'i-ph-cube-bold' },
  { to: '/keys', label: 'API 密钥', icon: 'i-ph-key-bold' },
  { to: '/logs', label: '请求日志', icon: 'i-ph-list-bullets-bold' },
  { to: '/settings', label: '系统设置', icon: 'i-ph-sliders-horizontal-bold' },
]
const current = computed(() => links.find(link => link.to === '/' ? route.path === '/' : route.path.startsWith(link.to)) || links[0]!)
watch(() => route.fullPath, () => { mobileOpen.value = false })
const { busy, run } = useApiAction()
async function logout() {
  const result = await run(() => $fetch('/api/auth/logout', { method: 'POST' }))
  if (result.ok) { session.value = { authenticated: false, username: null }; await navigateTo('/login') }
}
</script>
<template>
  <div class="app-shell" @keydown.esc="mobileOpen = false">
    <button v-if="mobileOpen" class="sidebar-backdrop" aria-label="关闭导航" @click="mobileOpen = false" />
    <aside class="sidebar" :class="{ 'is-open': mobileOpen }">
      <NuxtLink to="/" class="brand"><span class="brand-mark"><UIcon name="i-ph-command-bold" /></span><span>Command Code<small>账号管理工作台</small></span></NuxtLink>
      <div class="nav-caption">工作空间</div>
      <nav aria-label="主导航"><NuxtLink v-for="link in links" :key="link.to" :to="link.to" class="nav-link" :class="{ active: link.to === '/' ? route.path === '/' : route.path.startsWith(link.to) }"><UIcon :name="link.icon" /><span>{{ link.label }}</span><UIcon v-if="current.to === link.to" name="i-ph-caret-right-bold" class="nav-chevron" /></NuxtLink></nav>
      <div class="sidebar-footer"><div class="admin-avatar"><UIcon name="i-ph-user-bold" /></div><div><strong>{{ session?.username || '管理员' }}</strong><span>最高管理员</span></div><button class="icon-button" :disabled="busy" aria-label="退出登录" title="退出登录" @click="logout"><UIcon name="i-ph-sign-out-bold" /></button></div>
    </aside>
    <div class="main-shell">
      <header class="topbar"><div class="breadcrumbs"><button class="icon-button mobile-menu" aria-label="打开导航" :aria-expanded="mobileOpen" @click="mobileOpen = true"><UIcon name="i-ph-list-bold" /></button><span class="workspace-label">管理工作台</span><UIcon name="i-ph-caret-right-bold" /><NuxtLink :to="current.to">{{ current.label }}</NuxtLink><template v-if="route.path.split('/').filter(Boolean).length > 1"><UIcon name="i-ph-caret-right-bold" /><span>详情</span></template></div><div class="live-status" :class="{ connected: connection === 'live' }"><span class="status-dot" />{{ connection === 'live' ? '实时更新已连接' : connection === 'connecting' ? '正在连接更新' : '更新连接重试中' }}</div></header>
      <main id="main-content" class="main-content"><slot /></main>
      <footer class="workspace-footer"><span>Command Code Manager</span><span>时间以北京时间显示</span></footer>
    </div>
  </div>
</template>
