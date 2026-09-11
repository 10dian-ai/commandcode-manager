<script setup lang="ts">
import type { ModelView } from '#shared/types'
useHead({ title: '模型目录 · Command Code Manager' })
const { data, pending, error, refresh } = await useFetch<{ items: ModelView[]; updatedAt: string | null }>('/api/models')
useLiveRefresh(refresh)
const search = ref('')
const items = computed(() => { const q = search.value.trim().toLowerCase(); return (data.value?.items || []).filter(item => !q || item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)) })
</script>
<template>
  <AppPageHeader title="模型目录" description="查看已获取的模型目录，以及各模型在账号池中的权限观察结果。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新列表</button></AppPageHeader>
  <div class="notice"><UIcon name="i-ph-info-bold" /><p>目录中的模型不代表每个账号都可用。已确认可用、不可用和未知账号分别来自实际观察记录。</p></div>
  <section class="table-panel"><div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" placeholder="搜索模型名称或 ID" aria-label="搜索模型"></label><span class="toolbar-meta">目录更新于 {{ formatDate(data?.updatedAt) }}</span></div><AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" /><AppState v-else-if="!items.length" icon="i-ph-cube-bold" :title="search ? '未找到匹配模型' : '尚未获取模型目录'" :description="search ? '换一个名称或模型 ID 试试。' : '导入账号并完成同步后，模型目录会在此显示。'" /><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>模型</th><th class="align-right">已确认可用</th><th class="align-right">已确认不可用</th><th class="align-right">权限未知</th><th>更新于</th></tr></thead><tbody><tr v-for="model in items" :key="model.id"><td><strong>{{ model.name }}</strong><div class="cell-secondary mono">{{ model.id }}</div></td><td class="align-right"><span class="number-chip green">{{ formatNumber(model.observedAllowed) }}</span></td><td class="align-right"><span class="number-chip" :class="{ red: model.observedDenied > 0 }">{{ formatNumber(model.observedDenied) }}</span></td><td class="align-right"><span class="number-chip">{{ formatNumber(model.unknownAccounts) }}</span></td><td class="date-text">{{ formatDate(model.updatedAt) }}</td></tr></tbody></table></div><div v-if="data" class="table-footnote">显示 {{ items.length }} / {{ data.items.length }} 个模型</div></section>
</template>
