<script setup lang="ts">
import type { AccountView } from '#shared/types'
type AccountDetail = AccountView & { observedModels?: { modelId: string; status: string; reason: string | null; cooldownUntil: string | null; lastCheckedAt: string }[] }
useHead({ title: '账号详情 · Command Code Manager' })
const route = useRoute()
const api = useRequestFetch()
const accountId = computed(() => String(route.params.id))
const { data, pending, error, refresh } = await useFetch<AccountDetail>(() => '/api/accounts/' + encodeURIComponent(accountId.value))
useLiveRefresh(refresh)
function accountFields(account: AccountDetail) {
  return { label: account.label, groupName: account.groupName, note: account.note, enabled: account.enabled, maxConcurrency: account.maxConcurrency }
}
const { form, dirty, reset } = useEditableFields(() => data.value ? accountFields(data.value) : null, () => data.value?.id)
const { busy, run } = useApiAction()
async function save() {
  if (!form.value) return
  const { enabled, ...fields } = form.value
  const body = enabled === data.value?.enabled ? fields : { ...fields, enabled }
  const result = await run(() => api<AccountDetail>('/api/accounts/' + accountId.value, { method: 'PATCH', body }), '账号设置已保存')
  if (result.ok) { reset(accountFields(result.value)); await refresh() }
}
async function sync() { await run(() => api('/api/accounts/actions', { method: 'POST', body: { ids: [accountId.value], action: 'refresh' } }), '已提交刷新任务，完成后会自动更新') }
async function cancelQuotaResume() {
  const result = await run(() => api<AccountDetail>('/api/accounts/' + accountId.value, { method: 'PATCH', body: { enabled: false } }), '已取消自动恢复，账号保持停用')
  if (result.ok) await refresh()
}
</script>
<template>
  <NuxtLink to="/accounts" class="back-link"><UIcon name="i-ph-arrow-left-bold" />返回账号列表</NuxtLink>
  <AppPageHeader :title="data?.label || data?.email || '账号详情'" description="额度与窗口限制直接展示上游返回的数据。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />更新详情</button><button class="button primary" :disabled="busy || !data" @click="sync"><UIcon name="i-ph-arrows-clockwise-bold" />刷新上游数据</button></AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" />
  <template v-else-if="form">
    <div class="detail-meta"><StatusBadge :status="data.status" /><span>{{ data.quotaPaused ? '额度用尽 · 自动暂停' : data.enabled ? '已启用转发' : '手动停用转发' }}</span><span>当前并发 {{ data.inFlight }} / {{ data.maxConcurrency }}</span><span>最近同步 {{ formatDate(data.lastSyncAt) }}</span></div>
    <div v-if="data.quotaPaused" class="notice warning-notice quota-pause-notice"><UIcon name="i-ph-pause-circle-bold" /><div><strong>配额已满，账号已自动暂停</strong><p>{{ data.quotaResumeAt ? '恢复检查时间：' + formatDate(data.quotaResumeAt) + '。到期复查额度，恢复后自动启用。' : '上游尚未提供完整恢复时间，将定期复查额度，恢复后自动启用。' }}</p><button class="button small" :disabled="busy" @click="cancelQuotaResume">取消自动恢复，保持停用</button></div></div>
    <div v-if="data.syncError" class="notice error-notice" role="alert"><UIcon name="i-ph-warning-circle-bold" /><div><strong>最近一次同步未成功</strong><p>{{ data.syncError }}</p><p v-if="data.snapshot">下方保留最近成功获取的数据，请留意获取时间。</p></div></div>
    <div v-else-if="!data.snapshot" class="notice"><UIcon name="i-ph-clock-bold" /><div><strong>尚未获取账号快照</strong><p>请等待后台同步，或点击“刷新上游数据”。未知值不会显示为零。</p></div></div>
    <div class="account-detail-grid">
      <section class="panel"><div class="panel-heading"><h2>账号资料</h2><span class="muted">本地管理信息</span></div><form @submit.prevent="save"><fieldset class="form-stack" :disabled="busy"><label class="field"><span>显示名称</span><input v-model="form.label" maxlength="200" placeholder="便于识别的账号名称"></label><label class="field"><span>分组</span><input v-model="form.groupName" maxlength="100" placeholder="未分组"></label><label class="field"><span>备注</span><textarea v-model="form.note" rows="3" maxlength="5000" placeholder="记录用途或需要留意的事项" /></label><div class="form-row"><label class="field"><span>单账号并发上限</span><input v-model.number="form.maxConcurrency" type="number" min="1" max="100" step="1" required></label><label class="toggle-field"><input v-model="form.enabled" type="checkbox"><span>启用账号转发</span></label></div><div class="form-actions"><button class="button primary" :disabled="busy || !dirty"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存修改</button><button class="button" type="button" :disabled="busy || !dirty" @click="reset()">还原</button><span v-if="dirty" class="muted small-text">有未保存修改</span></div></fieldset></form><dl class="identity-list"><div><dt>邮箱</dt><dd>{{ data.email || '尚未获取' }}</dd></div><div><dt>上游 API Key</dt><dd>{{ data.hasApiKey ? '已保存' : '尚未获取' }}</dd></div><div><dt>最近调用</dt><dd>{{ formatDate(data.lastUsedAt) }}</dd></div><div><dt>导入时间</dt><dd>{{ formatDate(data.createdAt) }}</dd></div><div><dt>账号 ID</dt><dd class="mono small-text">{{ data.id }}</dd></div></dl></section>
      <div class="detail-right">
        <section class="panel"><div class="panel-heading"><h2>额度余额</h2><span class="muted small-text">获取于 {{ formatDate(data.snapshot?.fetchedAt) }}</span></div><RawFields :value="data.snapshot?.credits" /><p class="panel-note">保留上游字段与实际数值，不根据调用次数推算余额。</p></section>
        <section class="panel"><div class="panel-heading"><h2>账号配额</h2><span class="muted small-text">获取于 {{ formatDate(data.snapshot?.fetchedAt) }}</span></div><AccountQuota :snapshot="data.snapshot" /><p class="panel-note">5h、周、月配额任一项达到上限时自动暂停；到期复查确认恢复后自动启用。缺失数据以“未提供”显示。</p></section>
        <section class="panel"><div class="panel-heading"><h2>订阅信息</h2></div><dl class="summary-rows"><div><dt>套餐</dt><dd class="small-value">{{ data.snapshot?.subscription.planId || '未知' }}</dd></div><div><dt>订阅状态</dt><dd class="small-value">{{ data.snapshot?.subscription.status || '未知' }}</dd></div><div><dt>当前周期开始</dt><dd class="small-value">{{ formatDate(data.snapshot?.subscription.currentPeriodStart) }}</dd></div><div><dt>当前周期结束</dt><dd class="small-value">{{ formatDate(data.snapshot?.subscription.currentPeriodEnd) }}</dd></div><div><dt>周期结束后取消</dt><dd class="small-value">{{ displayValue(data.snapshot?.subscription.cancelAtPeriodEnd) }}</dd></div></dl></section>
      </div>
    </div>
    <section class="table-panel section-gap"><div class="panel-heading padded"><h2>模型权限观察</h2><span class="muted small-text">来自实际同步或调用结果</span></div><AppState v-if="!data.observedModels?.length" compact title="暂无权限观察记录" description="尚未观察到的模型权限为未知，不会根据目录或套餐名称推定可用。"/><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>模型</th><th>观察状态</th><th>原因</th><th>冷却截止</th><th>最近观察</th></tr></thead><tbody><tr v-for="model in data.observedModels" :key="model.modelId"><td class="mono">{{ model.modelId }}</td><td><StatusBadge :status="model.status" /></td><td class="wrap-cell">{{ model.reason || '—' }}</td><td>{{ model.cooldownUntil ? formatDate(model.cooldownUntil) : '—' }}</td><td>{{ formatDate(model.lastCheckedAt) }}</td></tr></tbody></table></div></section>
    <details class="raw-details section-gap"><summary><UIcon name="i-ph-code-bold" />查看最近同步的原始用量</summary><JsonViewer :value="data.snapshot?.usage" title="上游用量数据" /></details>
  </template>
</template>
