<script setup lang="ts">
defineProps<{ status: string; label?: string }>()
</script>
<template><span class="status-badge" :class="statusTone(status)"><span class="status-dot" />{{ label || statusLabel(status) }}</span></template>
