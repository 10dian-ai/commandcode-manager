<script setup lang="ts">
import type { RequestLogView } from '#shared/types'
interface LogList { items: RequestLogView[]; total: number; page: number; pageSize: number }
useHead({ title: '请求日志 · Command Code Manager' })
const page = ref(1)
const pageSize = 50
const modelInput = ref('')
const model = ref('')
const status = ref('')
const { data, pending, error, refresh } = await useFetch<LogList>('/api/logs', { query: { page, pageSize, model, status } })
useLiveRefresh(refresh)
watch([model, status], () => { page.value = 1 })
function usageTotal(log: RequestLogView) {
  const value = log.usage?.total_tokens ?? log.usage?.totalTokens
  return typeof value === 'number' ? formatNumber(value) : '—'
}
</script>
<template>
  <AppPageHeader title="请求日志" description="检索实际调用结果，查看请求内容、回复与错误详情。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新日志</button></AppPageHeader>
  <section class="table-panel"><form class="table-toolbar" @submit.prevent="model = modelInput.trim()"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="modelInput" aria-label="按模型筛选" placeholder="输入模型 ID"><button v-if="modelInput" class="icon-button" type="button" aria-label="清除模型筛选" @click="modelInput = ''; model = ''"><UIcon name="i-ph-x-bold" /></button></label><button class="button">搜索</button><select v-model="status" aria-label="请求结果"><option value="">全部结果</option><option value="success">成功</option><option value="error">错误</option><option value="cancelled">取消</option><option value="incomplete">不完整</option></select><span v-if="pending && data" class="toolbar-updating"><UIcon name="i-ph-circle-notch-bold" class="spinning" />更新中</span></form><AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" /><AppState v-else-if="!data.items.length" icon="i-ph-list-bullets-bold" :title="model || status ? '没有匹配的请求' : '还没有调用记录'" :description="model || status ? '调整筛选条件后再试。' : '通过本系统发起模型调用后，日志会显示在这里。'" /><div v-else class="table-scroll"><table class="data-table log-table"><thead><tr><th>时间 / 来源</th><th>模型 / 协议</th><th>账号</th><th>结果</th><th class="align-right">耗时</th><th class="align-right">总 Token</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="log in data.items" :key="log.id"><td><span class="date-text">{{ formatDate(log.createdAt) }}</span><div class="cell-secondary">{{ log.keyName || '密钥记录不可用' }}</div></td><td><strong class="mono model-id">{{ log.model || '未指定模型' }}</strong><div class="cell-secondary">{{ log.protocol }} · {{ log.streaming ? '流式' : '非流式' }}</div></td><td><NuxtLink v-if="log.accountId" :to="'/accounts/' + log.accountId" class="text-link">{{ log.accountLabel || '查看账号' }}</NuxtLink><span v-else class="muted">未分配 / 已删除</span></td><td><StatusBadge :status="log.status" /><div class="cell-secondary">HTTP {{ log.httpStatus ?? '—' }}</div></td><td class="mono align-right">{{ formatDuration(log.durationMs) }}</td><td class="mono align-right">{{ usageTotal(log) }}</td><td class="align-right"><NuxtLink :to="'/logs/' + log.id" class="button small">详情<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></td></tr></tbody></table></div><AppPagination v-if="data" v-model:page="page" :page-size="pageSize" :total="data.total" :loading="pending" /></section>
</template>
