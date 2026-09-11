<script setup lang="ts">
const props = withDefaults(defineProps<{ modelValue: boolean; title: string; description?: string; wide?: boolean; closeDisabled?: boolean }>(), { wide: false, closeDisabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const dialog = ref<HTMLDialogElement>()
function close() { if (!props.closeDisabled) emit('update:modelValue', false) }
watch(() => props.modelValue, (value) => {
  if (!dialog.value) return
  if (value && !dialog.value.open) dialog.value.showModal()
  if (!value && dialog.value.open) dialog.value.close()
}, { flush: 'post' })
onMounted(() => { if (props.modelValue) dialog.value?.showModal() })
</script>
<template>
  <dialog ref="dialog" class="app-dialog" :class="{ wide }" aria-label="对话框" @cancel.prevent="close" @click="($event.target === dialog) && close()">
    <div class="dialog-header"><div><h2>{{ title }}</h2><p v-if="description">{{ description }}</p></div><button class="icon-button" :disabled="closeDisabled" aria-label="关闭" @click="close"><UIcon name="i-ph-x-bold" /></button></div>
    <div class="dialog-body"><slot /></div>
    <div v-if="$slots.footer" class="dialog-footer"><slot name="footer" /></div>
  </dialog>
</template>
