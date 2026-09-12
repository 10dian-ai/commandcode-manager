<script setup lang="ts">
useHead({ title: 'API 密钥 · Command Code Manager' })
</script>

<template>
  <AppPageHeader title="API 密钥" description="分别管理模型调用和外调服务的访问密钥，按使用用途独立启停与撤销。" />
  <div class="form-stack">
    <KeyManager kind="gateway" />
    <KeyManager kind="service" />
  </div>
</template>
