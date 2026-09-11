<script setup lang="ts">
import type { DashboardView } from '#shared/types'
useHead({ title: '概览 · Command Code Manager' })
const { data, pending, error, refresh } = await useFetch<DashboardView>('/api/dashboard')
useLiveRefresh(refresh)
const metrics = computed(() => data.value ? [
  { label: '管理账号', value: data.value.counts.total, icon: 'i-ph-users-three-bold', hint: '已导入的账号' },
  { label: '正常账号', value: data.value.counts.ready, icon: 'i-ph-check-circle-bold', hint: '最近同步状态正常' },
  { label: '需要处理', value: data.value.counts.needsAttention, icon: 'i-ph-warning-circle-bold', hint: '凭证或同步出现问题', warning: true },
  { label: '当前并发', value: data.value.requests.inFlight, icon: 'i-ph-pulse-bold', hint: '正在转发的请求' },
] : [])
</script>
<template>
  <AppPageHeader title="概览" description="查看账号状态、正在进行的请求与服务连接。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button><NuxtLink to="/accounts?import=1" class="button primary"><UIcon name="i-ph-plus-bold" />导入账号</NuxtLink></AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <AppState v-else-if="!data" :loading="pending" />
  <template v-else>
    <div class="metric-grid"><section v-for="metric in metrics" :key="metric.label" class="metric-card" :class="{ 'metric-warning': metric.warning && metric.value > 0 }"><div class="metric-top"><span>{{ metric.label }}</span><UIcon :name="metric.icon" /></div><strong>{{ formatNumber(metric.value) }}</strong><p>{{ metric.hint }}</p></section></div>
    <div v-if="data.counts.total === 0" class="onboarding-strip"><span class="strip-icon"><UIcon name="i-ph-tray-bold" /></span><div><h3>从导入第一个账号开始</h3><p>批量粘贴 Cookie Token，同步完成后即可查看账号与额度。</p></div><NuxtLink to="/accounts?import=1" class="button primary">导入账号<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-heading"><h2>账号与同步</h2><NuxtLink to="/accounts" class="text-link">查看账号<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink></div><dl class="summary-rows"><div><dt>已启用账号</dt><dd>{{ formatNumber(data.counts.enabled) }}</dd></div><div><dt>尚未同步</dt><dd>{{ formatNumber(data.counts.notSynced) }}</dd></div><div><dt>最近成功同步</dt><dd class="small-value">{{ formatDate(data.lastSyncAt) }}</dd></div></dl><p class="panel-note">账号启用状态与同步状态分别统计；额度以最近获取的实际结果为准。</p></section>
      <section class="panel"><div class="panel-heading"><h2>调用记录</h2><NuxtLink to="/logs" class="text-link">查看日志<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink></div><dl class="summary-rows"><div><dt>已记录请求</dt><dd>{{ formatNumber(data.requests.total) }}</dd></div><div><dt><span class="status-dot green-dot" />成功</dt><dd>{{ formatNumber(data.requests.success) }}</dd></div><div><dt><span class="status-dot red-dot" />失败</dt><dd>{{ formatNumber(data.requests.failed) }}</dd></div></dl><p class="panel-note">根据实际请求日志统计。正在执行的请求单独显示。</p></section>
      <section class="panel services-panel"><div class="panel-heading"><h2>服务状态</h2><span class="muted">连接检查</span></div><div class="service-list"><div><UIcon name="i-ph-database-bold" /><span>PostgreSQL</span><StatusBadge :status="data.services.database ? 'ready' : 'error'" :label="data.services.database ? '已连接' : '未连接'" /></div><div><UIcon name="i-ph-stack-bold" /><span>Redis</span><StatusBadge :status="data.services.redis ? 'ready' : 'error'" :label="data.services.redis ? '已连接' : '未连接'" /></div><div><UIcon name="i-ph-arrows-left-right-bold" /><span>转发内核</span><StatusBadge :status="data.services.kernel ? 'ready' : 'error'" :label="data.services.kernel ? '可访问' : '不可访问'" /></div><div><UIcon name="i-ph-clock-clockwise-bold" /><span>同步进程最近心跳</span><strong class="small-value">{{ formatDate(data.services.workerLastSeen) }}</strong></div></div></section>
    </div>
  </template>
</template>
