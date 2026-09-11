<script setup lang="ts">
const props = defineProps<{ page: number; pageSize: number; total: number; loading?: boolean }>()
defineEmits<{ 'update:page': [value: number] }>()
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
</script>
<template>
  <div class="pagination">
    <span>共 <strong>{{ formatNumber(total) }}</strong> 条<span v-if="total"> · 第 {{ page }} / {{ pages }} 页</span></span>
    <div class="inline-actions">
      <button class="button small" :disabled="page <= 1 || loading" aria-label="上一页" @click="$emit('update:page', page - 1)"><UIcon name="i-ph-caret-left-bold" />上一页</button>
      <button class="button small" :disabled="page >= pages || loading" aria-label="下一页" @click="$emit('update:page', page + 1)">下一页<UIcon name="i-ph-caret-right-bold" /></button>
    </div>
  </div>
</template>
