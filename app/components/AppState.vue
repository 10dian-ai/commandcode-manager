<script setup lang="ts">
const props = defineProps<{ title?: string; description?: string; loading?: boolean; error?: unknown; compact?: boolean; icon?: string }>()
defineEmits<{ retry: [] }>()
const route = useRoute()
const { session } = useAuth()
watch(() => props.error, (error) => {
  const value = error as { statusCode?: number; status?: number } | null
  if (value?.statusCode === 401 || value?.status === 401) {
    session.value = { authenticated: false, username: null }
    void navigateTo({ path: '/login', query: { redirect: route.fullPath } })
  }
}, { immediate: true })
</script>
<template>
  <div class="state-box" :class="{ compact }" :role="error ? 'alert' : 'status'" :aria-busy="loading">
    <UIcon :name="loading ? 'i-ph-circle-notch-bold' : error ? 'i-ph-warning-circle-bold' : icon || 'i-ph-tray-bold'" class="state-icon" :class="{ spinning: loading }" />
    <h3>{{ loading ? '正在读取数据' : error ? '数据加载失败' : title || '暂无数据' }}</h3>
    <p>{{ loading ? '请稍候，正在获取实际记录。' : error ? apiErrorMessage(error) : description }}</p>
    <button v-if="error" class="button" @click="$emit('retry')">重新加载</button>
    <slot v-else-if="!loading" />
  </div>
</template>
