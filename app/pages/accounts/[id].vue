<script setup lang="ts">
import type { AccountView, UsageWindow } from '#shared/types'
type AccountDetail = AccountView & { observedModels?: { modelId: string; status: string; reason: string | null; cooldownUntil: string | null; lastCheckedAt: string }[] }
useHead({ title: '账号详情 · Command Code Manager' })
const route = useRoute()
const api = useRequestFetch()
const accountId = computed(() => String(route.params.id))
const { data, pending, error, refresh } = await useFetch<AccountDetail>(() => '/api/accounts/' + encodeURIComponent(accountId.value))
useLiveRefresh(refresh)
const form = reactive({ label: '', groupName: '', note: '', enabled: true, maxConcurrency: 2 })
let initializedFor = ''
function fillForm(account: AccountDetail) { Object.assign(form, { label: account.label, groupName: account.groupName, note: account.note, enabled: account.enabled, maxConcurrency: account.maxConcurrency }); initializedFor = account.id }
watch(data, account => { if (account && initializedFor !== account.id) fillForm(account) }, { immediate: true })
const dirty = computed(() => !!data.value && (Object.keys(form) as (keyof typeof form)[]).some(key => form[key] !== data.value?.[key]))
const { busy, run } = useApiAction()
async function save() {
  const result = await run(() => api<AccountDetail>('/api/accounts/' + accountId.value, { method: 'PATCH', body: { ...form } }), '账号设置已保存')
  if (result.ok) { fillForm(result.value); await refresh() }
}
async function sync() { await run(() => api('/api/accounts/actions', { method: 'POST', body: { ids: [accountId.value], action: 'refresh' } }), '已提交刷新任务，完成后会自动更新') }
const windows = computed(() => [
  { label: '5 小时窗口', value: data.value?.snapshot?.windowLimits?.fiveHour },
  { label: '每周窗口', value: data.value?.snapshot?.windowLimits?.weekly },
])
function percent(window: UsageWindow) { return window.cap > 0 ? Math.max(0, Math.min(100, window.used / window.cap * 100)) : 0 }
</script>
<template>
  <NuxtLink to="/accounts" class="back-link"><UIcon name="i-ph-arrow-left-bold" />返回账号列表</NuxtLink>
  <AppPageHeader :title="data?.label || data?.email || '账号详情'" description="额度与窗口限制直接展示上游返回的数据。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />更新详情</button><button class="button primary" :disabled="busy || !data" @click="sync"><UIcon name="i-ph-arrows-clockwise-bold" />刷新上游数据</button></AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" />
  <template v-else>
    <div class="detail-meta"><StatusBadge :status="data.status" /><span>{{ data.enabled ? '已启用转发' : '已停用转发' }}</span><span>当前并发 {{ data.inFlight }} / {{ data.maxConcurrency }}</span><span>最近同步 {{ formatDate(data.lastSyncAt) }}</span></div>
    <div v-if="data.syncError" class="notice error-notice" role="alert"><UIcon name="i-ph-warning-circle-bold" /><div><strong>最近一次同步未成功</strong><p>{{ data.syncError }}</p><p v-if="data.snapshot">下方保留最近成功获取的数据，请留意获取时间。</p></div></div>
    <div v-else-if="!data.snapshot" class="notice"><UIcon name="i-ph-clock-bold" /><div><strong>尚未获取账号快照</strong><p>请等待后台同步，或点击“刷新上游数据”。未知值不会显示为零。</p></div></div>
    <div class="account-detail-grid">
      <section class="panel"><div class="panel-heading"><h2>账号资料</h2><span class="muted">本地管理信息</span></div><form class="form-stack" @submit.prevent="save"><label class="field"><span>显示名称</span><input v-model="form.label" maxlength="200" placeholder="便于识别的账号名称"></label><label class="field"><span>分组</span><input v-model="form.groupName" maxlength="100" placeholder="未分组"></label><label class="field"><span>备注</span><textarea v-model="form.note" rows="3" maxlength="4000" placeholder="记录用途或需要留意的事项" /></label><div class="form-row"><label class="field"><span>单账号并发上限</span><input v-model.number="form.maxConcurrency" type="number" min="1" step="1" required></label><label class="toggle-field"><input v-model="form.enabled" type="checkbox"><span>启用账号转发</span></label></div><div class="form-actions"><button class="button primary" :disabled="busy || !dirty"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存修改</button><button class="button" type="button" :disabled="busy || !dirty" @click="fillForm(data)">还原</button><span v-if="dirty" class="muted small-text">有未保存修改</span></div></form><dl class="identity-list"><div><dt>邮箱</dt><dd>{{ data.email || '尚未获取' }}</dd></div><div><dt>上游 API Key</dt><dd>{{ data.hasApiKey ? '已保存' : '尚未获取' }}</dd></div><div><dt>最近调用</dt><dd>{{ formatDate(data.lastUsedAt) }}</dd></div><div><dt>导入时间</dt><dd>{{ formatDate(data.createdAt) }}</dd></div><div><dt>账号 ID</dt><dd class="mono small-text">{{ data.id }}</dd></div></dl></section>
      <div class="detail-right">
        <section class="panel"><div class="panel-heading"><h2>额度余额</h2><span class="muted small-text">获取于 {{ formatDate(data.snapshot?.fetchedAt) }}</span></div><RawFields :value="data.snapshot?.credits" /><p class="panel-note">保留上游字段与实际数值，不根据调用次数推算余额。</p></section>
        <section class="panel"><div class="panel-heading"><h2>使用窗口</h2><StatusBadge v-if="data.snapshot?.windowLimits?.limited" status="cooldown" label="当前受限" /></div><div class="window-grid"><div v-for="window in windows" :key="window.label" class="usage-window"><h3>{{ window.label }}</h3><template v-if="window.value"><div class="window-value"><strong>{{ formatNumber(window.value.used) }}</strong><span>/ {{ formatNumber(window.value.cap) }}</span><StatusBadge v-if="window.value.exceeded" status="cooldown" label="已达上限" /></div><progress v-if="window.value.cap > 0" :value="percent(window.value)" max="100" /><p>重置时间 {{ formatDate(window.value.resetAt) }}</p></template><template v-else><strong class="unknown-value">未知</strong><p>上游暂未返回此窗口数据</p></template></div></div><p v-if="data.snapshot?.windowLimits?.exceeded" class="panel-note">上游限制标记：{{ data.snapshot.windowLimits.exceeded }}</p></section>
        <section class="panel"><div class="panel-heading"><h2>订阅信息</h2></div><dl class="summary-rows"><div><dt>套餐</dt><dd class="small-value">{{ data.snapshot?.subscription.planId || '未知' }}</dd></div><div><dt>订阅状态</dt><dd class="small-value">{{ data.snapshot?.subscription.status || '未知' }}</dd></div><div><dt>当前周期开始</dt><dd class="small-value">{{ formatDate(data.snapshot?.subscription.currentPeriodStart) }}</dd></div><div><dt>当前周期结束</dt><dd class="small-value">{{ formatDate(data.snapshot?.subscription.currentPeriodEnd) }}</dd></div><div><dt>周期结束后取消</dt><dd class="small-value">{{ displayValue(data.snapshot?.subscription.cancelAtPeriodEnd) }}</dd></div></dl></section>
      </div>
    </div>
    <section class="table-panel section-gap"><div class="panel-heading padded"><h2>模型权限观察</h2><span class="muted small-text">来自实际同步或调用结果</span></div><AppState v-if="!data.observedModels?.length" compact title="暂无权限观察记录" description="尚未观察到的模型权限为未知，不会根据目录或套餐名称推定可用。"/><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>模型</th><th>观察状态</th><th>原因</th><th>冷却截止</th><th>最近观察</th></tr></thead><tbody><tr v-for="model in data.observedModels" :key="model.modelId"><td class="mono">{{ model.modelId }}</td><td><StatusBadge :status="model.status" /></td><td class="wrap-cell">{{ model.reason || '—' }}</td><td>{{ model.cooldownUntil ? formatDate(model.cooldownUntil) : '—' }}</td><td>{{ formatDate(model.lastCheckedAt) }}</td></tr></tbody></table></div></section>
    <details class="raw-details section-gap"><summary><UIcon name="i-ph-code-bold" />查看最近同步的原始用量</summary><JsonViewer :value="data.snapshot?.usage" title="上游用量数据" /></details>
  </template>
</template>
