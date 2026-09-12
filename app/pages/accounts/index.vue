<script setup lang="ts">
import type { AccountView, JobView } from '#shared/types'
interface AccountList { items: AccountView[]; total: number; page: number; pageSize: number; groups: string[] }
useHead({ title: '账号管理 · Command Code Manager' })
const route = useRoute()
const api = useRequestFetch()
const queryInput = ref('')
const query = ref('')
const status = ref('')
const group = ref('')
const page = ref(1)
const pageSize = 50
const selected = ref<string[]>([])
const { data, pending, error, refresh } = await useFetch<AccountList>('/api/accounts', { query: { q: query, status, group, page, pageSize } })
useLiveRefresh(refresh)
watch([query, status, group], () => { page.value = 1; selected.value = [] })
watch(page, () => { selected.value = [] })
watch(() => data.value?.total, total => { if (total !== undefined) page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize))) })
watch(() => data.value?.items, (items) => { selected.value = selected.value.filter(id => items?.some(item => item.id === id)) })
const allSelected = computed(() => !!data.value?.items.length && data.value.items.every(item => selected.value.includes(item.id)))
function toggleAll() { selected.value = allSelected.value ? [] : (data.value?.items.map(item => item.id) || []) }
const importOpen = ref(route.query.import === '1')
const importText = ref('')
const importGroup = ref('')
const { busy, run } = useApiAction()
const deleteOpen = ref(false)
async function action(action: 'refresh' | 'enable' | 'disable' | 'delete') {
  const result = await run(() => api<{ ok: true; affected: number }>('/api/accounts/actions', { method: 'POST', body: { ids: [...selected.value], action } }), action === 'refresh' ? '刷新任务已提交' : action === 'delete' ? '账号已删除' : '账号状态已更新')
  if (result.ok) { deleteOpen.value = false; selected.value = []; await refresh() }
}
const job = ref<JobView | null>(null)
const jobId = ref<string | null>(null)
const jobError = ref('')
const importSummary = ref<{ accepted: number; rejected: number; duplicates: number } | null>(null)
let jobTimer: ReturnType<typeof setTimeout> | undefined
let stopped = false
const jobRunning = computed(() => !!jobId.value && !['completed', 'failed'].includes(job.value?.status || ''))
const jobPercent = computed(() => job.value?.progress.total ? Math.min(100, Math.round(job.value.progress.processed / job.value.progress.total * 100)) : 0)
async function pollJob() {
  if (!jobId.value || stopped) return
  if (jobTimer) clearTimeout(jobTimer)
  try {
    job.value = await api<JobView>('/api/jobs/' + encodeURIComponent(jobId.value))
    jobError.value = ''
    if (jobRunning.value && !stopped) jobTimer = setTimeout(pollJob, 1800)
    else await refresh()
  } catch (error) { jobError.value = apiErrorMessage(error) }
}
async function importAccounts() {
  const result = await run(() => api<{ jobId: string; accepted: number; rejected: number; duplicates: number }>('/api/accounts/import', { method: 'POST', body: { text: importText.value, groupName: importGroup.value.trim() } }), '导入任务已创建')
  if (result.ok) {
    jobId.value = result.value.jobId; importSummary.value = result.value; job.value = null
    importOpen.value = false; importText.value = ''; importGroup.value = ''
    await navigateTo({ path: '/accounts', query: { job: jobId.value } }, { replace: true })
    await pollJob(); await refresh()
  }
}
onMounted(() => {
  if (typeof route.query.job === 'string') { jobId.value = route.query.job; void pollJob() }
})
onBeforeUnmount(() => { stopped = true; if (jobTimer) clearTimeout(jobTimer) })
async function cancelQuotaResume(account: AccountView) {
  const result = await run(() => api<AccountView>('/api/accounts/' + encodeURIComponent(account.id), { method: 'PATCH', body: { enabled: false } }), '已取消自动恢复，账号保持停用')
  if (result.ok) await refresh()
}
</script>
<template>
  <AppPageHeader title="账号管理" description="批量维护账号，查看真实额度、同步状态与当前负载。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />更新列表</button><button class="button primary" @click="importOpen = true"><UIcon name="i-ph-plus-bold" />批量导入</button></AppPageHeader>
  <section v-if="jobId" class="job-panel"><div class="panel-heading"><div class="inline-actions"><UIcon name="i-ph-tray-arrow-down-bold" /><h2>导入进度</h2><StatusBadge v-if="job" :status="job.status" /></div><button v-if="!jobRunning" class="icon-button" aria-label="收起导入进度" @click="jobId = null"><UIcon name="i-ph-x-bold" /></button></div><div v-if="jobError" class="inline-error" role="alert">{{ jobError }}<button class="text-link" @click="pollJob">重试读取进度</button></div><template v-else><div class="job-progress"><progress :value="jobPercent" max="100" /><span>{{ job ? job.progress.processed + ' / ' + job.progress.total : '正在读取任务' }}</span></div><p v-if="importSummary" class="muted small-text">接收 {{ importSummary.accepted }} 条 · 无效 {{ importSummary.rejected }} 条 · 重复 {{ importSummary.duplicates }} 条</p><p v-if="job?.result" class="small-text">新导入 {{ job.result.imported }} · 已更新 {{ job.result.updated }} · 跳过 {{ job.result.skipped }} · 失败 {{ job.result.failed }}</p><p v-if="job?.error" class="inline-error">{{ job.error }}</p><details v-if="job?.result?.errors.length" class="job-errors"><summary>查看 {{ job.result.errors.length }} 条错误</summary><p v-for="item in job.result.errors" :key="item.line">第 {{ item.line }} 行：{{ item.message }}</p></details></template></section>
  <section class="table-panel">
    <form class="table-toolbar" @submit.prevent="query = queryInput.trim()"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="queryInput" aria-label="搜索账号" placeholder="搜索名称、邮箱或备注"><button v-if="queryInput" type="button" class="icon-button" aria-label="清除搜索" @click="queryInput = ''; query = ''"><UIcon name="i-ph-x-bold" /></button></label><button class="button">搜索</button><label class="select-field"><span class="sr-only">同步状态</span><select v-model="status"><option value="">全部状态</option><option value="ready">正常</option><option value="pending">待同步</option><option value="credential_expired">凭证失效</option><option value="sync_error">同步失败</option></select></label><label class="select-field"><span class="sr-only">账号分组</span><select v-model="group"><option value="">全部分组</option><option v-for="item in data?.groups.filter(Boolean)" :key="item" :value="item">{{ item || '未分组' }}</option></select></label><span v-if="pending && data" class="toolbar-updating"><UIcon name="i-ph-circle-notch-bold" class="spinning" />更新中</span></form>
    <div v-if="selected.length" class="selection-bar"><strong>已选 {{ selected.length }} 个账号</strong><div class="inline-actions"><button class="button small" :disabled="busy" @click="action('refresh')"><UIcon name="i-ph-arrow-clockwise-bold" />刷新额度</button><button class="button small" :disabled="busy" @click="action('enable')">启用</button><button class="button small" :disabled="busy" @click="action('disable')">停用</button><button class="button small danger" :disabled="busy" @click="deleteOpen = true">删除</button><button class="text-link" @click="selected = []">取消选择</button></div></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" />
    <AppState v-else-if="!data.items.length" title="没有匹配的账号" :description="query || status || group ? '调整搜索或筛选条件后再试。' : '批量粘贴账号 Cookie Token，即可开始同步账号资料与额度。'" icon="i-ph-users-three-bold"><button v-if="!query && !status && !group" class="button primary" @click="importOpen = true">导入账号</button></AppState>
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" aria-label="选择当前页全部账号" :checked="allSelected" :indeterminate="selected.length > 0 && !allSelected" @change="toggleAll"></th><th>账号</th><th>状态</th><th>套餐 / 配额（已用 / 总量）</th><th>并发</th><th>最近同步</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="account in data.items" :key="account.id" :class="{ selected: selected.includes(account.id), 'muted-row': !account.enabled }"><td class="checkbox-cell"><input v-model="selected" type="checkbox" :value="account.id" :aria-label="'选择 ' + (account.label || account.email || account.id)"></td><td><NuxtLink :to="'/accounts/' + account.id" class="account-name">{{ account.label || account.email || '未命名账号' }}</NuxtLink><div class="cell-secondary">{{ account.email || '未获取邮箱' }}<span v-if="account.groupName" class="group-label">{{ account.groupName }}</span></div></td><td><StatusBadge :status="account.status" /><div class="cell-secondary">{{ account.quotaPaused ? '额度用尽 · 自动暂停' : account.enabled ? '已启用' : '手动停用' }}<span v-if="!account.hasApiKey"> · 暂无 API Key</span></div><template v-if="account.quotaPaused"><div class="cell-secondary quota-resume-time">{{ account.quotaResumeAt ? '恢复检查 ' + formatDate(account.quotaResumeAt) : '等待上游提供恢复时间，定期复查' }}</div><button class="text-link quota-resume-action" :disabled="busy" @click="cancelQuotaResume(account)">取消自动恢复</button></template></td><td><span>{{ account.snapshot?.subscription.planId || '套餐未知' }}</span><AccountQuota :snapshot="account.snapshot" compact /></td><td class="mono">{{ account.inFlight }} <span class="muted">/ {{ account.maxConcurrency }}</span></td><td><span class="date-text">{{ formatDate(account.lastSyncAt) }}</span><div v-if="account.syncError" class="cell-error" :title="account.syncError">{{ account.syncError }}</div></td><td class="align-right"><NuxtLink :to="'/accounts/' + account.id" class="button small">详情<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></td></tr></tbody></table></div>
    <AppPagination v-if="data" v-model:page="page" :page-size="pageSize" :total="data.total" :loading="pending" />
  </section>
  <AppDialog v-model="importOpen" title="批量导入账号" description="每行粘贴一个 Cookie Token。导入后会在后台读取账号资料并同步额度。" :close-disabled="busy"><form id="import-form" class="form-stack" @submit.prevent="importAccounts"><label class="field"><span>Cookie Token <span class="required">*</span></span><textarea v-model="importText" class="mono credential-input" rows="9" required autocomplete="off" spellcheck="false" placeholder="每行一个 Cookie Token" /><small>不会在导入结果中回显凭证。请勿粘贴账号密码。</small></label><label class="field"><span>分组名称 <small>可选</small></span><input v-model="importGroup" maxlength="100" placeholder="例如：个人开发"></label></form><template #footer><button class="button" :disabled="busy" @click="importOpen = false">取消</button><button form="import-form" class="button primary" :disabled="busy || !importText.trim()"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />{{ busy ? '正在提交' : '开始导入' }}</button></template></AppDialog>
  <AppDialog v-model="deleteOpen" title="删除选中账号" :description="'将删除选中的 ' + selected.length + ' 个账号及保存的凭证。此操作不能撤销。'" :close-disabled="busy"><p class="muted">只删除本系统中的管理记录，不会注销上游账号。</p><template #footer><button class="button" :disabled="busy" @click="deleteOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="action('delete')">确认删除</button></template></AppDialog>
</template>
