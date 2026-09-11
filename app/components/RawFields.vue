<script setup lang="ts">
const props = defineProps<{ value: Record<string, unknown> | null | undefined }>()
const labels: Record<string, string> = {
  balance: '余额', remaining: '剩余', total: '总额', used: '已使用', available: '可用',
  credits: '额度', remainingCredits: '剩余额度', totalCredits: '总额度', usedCredits: '已用额度',
  monthlyCredits: '月额度', purchasedCredits: '购买额度', bonusCredits: '赠送额度',
  subscriptionCredits: '订阅额度', additionalCredits: '额外额度',
  inputTokens: '输入 Token', outputTokens: '输出 Token', totalTokens: '总 Token',
  cachedInputTokens: '缓存输入 Token', requestCount: '请求次数', cost: '费用',
}
const rows = computed(() => Object.entries(props.value || {}))
</script>
<template>
  <dl v-if="rows.length" class="raw-fields"><div v-for="[key, value] in rows" :key="key"><dt>{{ labels[key] || key }}<small v-if="labels[key]">{{ key }}</small></dt><dd>{{ displayValue(value) }}</dd></div></dl>
  <p v-else class="muted empty-note">暂未获取到真实数据。</p>
</template>
