<script setup lang="ts">
const props = defineProps<{ value: unknown; title?: string; emptyText?: string }>()
const text = computed(() => props.value == null ? '' : typeof props.value === 'string' ? props.value : JSON.stringify(props.value, null, 2))
const toast = useToast()
async function copy() {
  try { await navigator.clipboard.writeText(text.value); toast.add({ title: '已复制', icon: 'i-ph-check-bold' }) }
  catch { toast.add({ title: '无法访问剪贴板，请手动选择文本复制', color: 'error', icon: 'i-ph-warning-bold' }) }
}
</script>
<template>
  <section class="json-viewer">
    <div class="json-toolbar"><strong>{{ title || '原始数据' }}</strong><button v-if="text" class="button small" @click="copy"><UIcon name="i-ph-copy-bold" />复制</button></div>
    <pre v-if="text" tabindex="0">{{ text }}</pre><p v-else class="json-empty">{{ emptyText || '暂无已保存数据' }}</p>
  </section>
</template>
