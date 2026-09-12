<script setup lang="ts">
import type { GatewayKeyView } from '#shared/types'

const props = defineProps<{ kind: 'gateway' | 'service' }>()
// Each mounted section owns an immutable endpoint and its own dialogs and data.
const config = props.kind === 'service'
  ? {
      endpoint: '/api/service-keys',
      formId: 'create-service-key-form',
      title: '外调服务 Key',
      description: '用于通过 API 添加账号、查询导入进度和池状态，与模型调用 Key 独立验证。',
      placeholder: '例如：自动加号服务',
      usage: '将此密钥配置到外部服务，通过 Authorization: Bearer 或 x-api-key 请求 /api/external/*。',
      revokeEffect: '使用此密钥的外部服务将无法继续添加账号或查询状态。',
    }
  : {
      endpoint: '/api/keys',
      formId: 'create-gateway-key-form',
      title: '模型 API Key',
      description: '用于客户端访问 /v1 模型转发接口。',
      placeholder: '例如：日常开发客户端',
      usage: '将此密钥填入模型调用客户端的 API Key 设置，Base URL 使用你的域名加 /v1。',
      revokeEffect: '使用此密钥的客户端将无法继续调用模型。',
    }
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ items: GatewayKeyView[] }>(config.endpoint)
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
  const result = await run(() => api<{ key: string; item: GatewayKeyView }>(config.endpoint, {
    method: 'POST', body: { name: keyName.value.trim() },
  }))
  if (result.ok) {
    createOpen.value = false
    keyName.value = ''
    createdKey.value = result.value.key
    await refresh()
  }
}
async function toggle(key: GatewayKeyView) {
  const result = await run(() => api(config.endpoint + '/' + key.id, {
    method: 'PATCH', body: { enabled: !key.enabled },
  }), key.enabled ? '密钥已停用' : '密钥已启用')
  if (result.ok) await refresh()
}
async function revoke() {
  const target = revokeTarget.value
  if (!target) return
  const result = await run(() => api(config.endpoint + '/' + target.id, { method: 'DELETE' }), '密钥已撤销')
  if (result.ok) {
    revokeTarget.value = null
    await refresh()
  }
}
async function copyKey() {
  try {
    await navigator.clipboard.writeText(createdKey.value)
    toast.add({ title: '密钥已复制', icon: 'i-ph-check-bold' })
  } catch {
    toast.add({ title: '无法访问剪贴板，请手动复制密钥', color: 'error', icon: 'i-ph-warning-bold' })
  }
}
</script>

<template>
  <section class="table-panel">
    <div class="table-toolbar">
      <div>
        <h2>{{ config.title }}</h2>
        <p class="small-text muted">{{ config.description }}</p>
      </div>
      <div class="inline-actions toolbar-meta">
        <button class="button" :disabled="pending" @click="refresh()">
          <UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新
        </button>
        <button class="button primary" :disabled="busy" @click="createOpen = true">
          <UIcon name="i-ph-plus-bold" />创建{{ config.title }}
        </button>
      </div>
    </div>
    <AppState v-if="error" :error="error" @retry="refresh()" />
    <AppState v-else-if="!data" :loading="pending" />
    <AppState v-else-if="!data.items.length" icon="i-ph-key-bold" :title="'还没有' + config.title" :description="config.description">
      <button class="button primary" :disabled="busy" @click="createOpen = true">创建第一个密钥</button>
    </AppState>
    <div v-else class="table-scroll">
      <table class="data-table">
        <thead>
          <tr><th>名称</th><th>密钥标识</th><th>状态</th><th>创建时间</th><th>最近使用</th><th class="align-right">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="key in data.items" :key="key.id">
            <td><strong>{{ key.name }}</strong></td>
            <td class="mono">{{ key.prefix }}…</td>
            <td><StatusBadge :status="key.enabled ? 'enabled' : 'disabled'" :label="key.enabled ? '已启用' : '已停用'" /></td>
            <td>{{ formatDate(key.createdAt) }}</td>
            <td>{{ formatDate(key.lastUsedAt) }}</td>
            <td>
              <div class="inline-actions justify-end">
                <button class="button small" :disabled="busy" @click="toggle(key)">{{ key.enabled ? '停用' : '启用' }}</button>
                <button class="button small danger" :disabled="busy" @click="revokeTarget = key">撤销</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-footnote">完整密钥只在创建时显示一次，列表仅展示识别前缀。{{ kind === 'service' ? '外调服务 Key 使用 ccm_service_ 前缀。' : '模型 API Key 使用 ccm_ 前缀。' }}</div>
  </section>

  <AppDialog v-model="createOpen" :title="'创建' + config.title" description="填写容易辨认的名称，例如客户端或使用用途。" :close-disabled="busy">
    <form :id="config.formId" @submit.prevent="createKey">
      <label class="field"><span>密钥名称</span><input v-model="keyName" required maxlength="80" :placeholder="config.placeholder" autofocus></label>
    </form>
    <template #footer>
      <button class="button" :disabled="busy" @click="createOpen = false">取消</button>
      <button :form="config.formId" class="button primary" :disabled="busy || !keyName.trim()">创建密钥</button>
    </template>
  </AppDialog>

  <AppDialog v-model="secretOpen" :title="'请保存新' + config.title" description="完整密钥仅显示这一次。关闭后无法再次查看。">
    <div class="secret-box"><code>{{ createdKey }}</code></div>
    <p class="small-text muted">{{ config.usage }}</p>
    <template #footer>
      <button class="button" @click="secretOpen = false">已保存，关闭</button>
      <button class="button primary" @click="copyKey"><UIcon name="i-ph-copy-bold" />复制密钥</button>
    </template>
  </AppDialog>

  <AppDialog v-model="revokeOpen" :title="'撤销' + config.title" :description="'确认撤销「' + (revokeTarget?.name || '') + '」？' + config.revokeEffect" :close-disabled="busy">
    <p class="muted">此操作不能撤销。如只需暂时关闭访问，可以选择停用。</p>
    <template #footer>
      <button class="button" :disabled="busy" @click="revokeTarget = null">取消</button>
      <button class="button danger-solid" :disabled="busy" @click="revoke">确认撤销</button>
    </template>
  </AppDialog>
</template>
