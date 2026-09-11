<script setup lang="ts">
import type { GatewayKeyView } from '#shared/types'
useHead({ title: 'API 密钥 · Command Code Manager' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ items: GatewayKeyView[] }>('/api/keys')
useLiveRefresh(refresh)
const createOpen = ref(false)
const keyName = ref('')
const createdKey = ref('')
const secretOpen = computed({ get: () => !!createdKey.value, set: value => { if (!value) createdKey.value = '' } })
const revokeTarget = ref<GatewayKeyView | null>(null)
const revokeOpen = computed({ get: () => !!revokeTarget.value, set: value => { if (!value) revokeTarget.value = null } })
const { busy, run } = useApiAction()
const toast = useToast()
async function createKey() {
  const result = await run(() => api<{ key: string; item: GatewayKeyView }>('/api/keys', { method: 'POST', body: { name: keyName.value.trim() } }))
  if (result.ok) { createOpen.value = false; keyName.value = ''; createdKey.value = result.value.key; await refresh() }
}
async function toggle(key: GatewayKeyView) {
  const result = await run(() => api('/api/keys/' + key.id, { method: 'PATCH', body: { enabled: !key.enabled } }), key.enabled ? '密钥已停用' : '密钥已启用')
  if (result.ok) await refresh()
}
async function revoke() {
  if (!revokeTarget.value) return
  const result = await run(() => api('/api/keys/' + revokeTarget.value!.id, { method: 'DELETE' }), '密钥已撤销')
  if (result.ok) { revokeTarget.value = null; await refresh() }
}
async function copyKey() {
  try { await navigator.clipboard.writeText(createdKey.value); toast.add({ title: '密钥已复制', icon: 'i-ph-check-bold' }) }
  catch { toast.add({ title: '无法访问剪贴板，请手动复制密钥', color: 'error', icon: 'i-ph-warning-bold' }) }
}
</script>
<template>
  <AppPageHeader title="API 密钥" description="为调用客户端创建独立密钥，便于识别来源与控制访问。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button><button class="button primary" @click="createOpen = true"><UIcon name="i-ph-plus-bold" />创建密钥</button></AppPageHeader>
  <section class="table-panel"><AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" /><AppState v-else-if="!data.items.length" icon="i-ph-key-bold" title="还没有 API 密钥" description="创建一个密钥，用于从客户端访问本系统的转发接口。"><button class="button primary" @click="createOpen = true">创建第一个密钥</button></AppState><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>名称</th><th>密钥标识</th><th>状态</th><th>创建时间</th><th>最近使用</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="key in data.items" :key="key.id"><td><strong>{{ key.name }}</strong></td><td class="mono">{{ key.prefix }}…</td><td><StatusBadge :status="key.enabled ? 'enabled' : 'disabled'" :label="key.enabled ? '已启用' : '已停用'" /></td><td>{{ formatDate(key.createdAt) }}</td><td>{{ formatDate(key.lastUsedAt) }}</td><td><div class="inline-actions justify-end"><button class="button small" :disabled="busy" @click="toggle(key)">{{ key.enabled ? '停用' : '启用' }}</button><button class="button small danger" :disabled="busy" @click="revokeTarget = key">撤销</button></div></td></tr></tbody></table></div><div v-if="data?.items.length" class="table-footnote">完整密钥只在创建时显示一次，列表仅展示识别前缀。</div></section>
  <AppDialog v-model="createOpen" title="创建 API 密钥" description="填写容易辨认的名称，例如客户端或使用用途。" :close-disabled="busy"><form id="create-key-form" @submit.prevent="createKey"><label class="field"><span>密钥名称</span><input v-model="keyName" required maxlength="100" placeholder="例如：日常开发客户端" autofocus></label></form><template #footer><button class="button" :disabled="busy" @click="createOpen = false">取消</button><button form="create-key-form" class="button primary" :disabled="busy || !keyName.trim()">创建密钥</button></template></AppDialog>
  <AppDialog v-model="secretOpen" title="请保存新密钥" description="完整密钥仅显示这一次。关闭后无法再次查看。"><div class="secret-box"><code>{{ createdKey }}</code></div><p class="small-text muted">将此密钥填入调用客户端的 API Key 设置。</p><template #footer><button class="button" @click="secretOpen = false">已保存，关闭</button><button class="button primary" @click="copyKey"><UIcon name="i-ph-copy-bold" />复制密钥</button></template></AppDialog>
  <AppDialog v-model="revokeOpen" title="撤销 API 密钥" :description="'确认撤销「' + (revokeTarget?.name || '') + '」？使用此密钥的客户端将无法继续调用。'" :close-disabled="busy"><p class="muted">此操作不能撤销。如只需暂时关闭访问，可以选择停用。</p><template #footer><button class="button" :disabled="busy" @click="revokeTarget = null">取消</button><button class="button danger-solid" :disabled="busy" @click="revoke">确认撤销</button></template></AppDialog>
</template>
