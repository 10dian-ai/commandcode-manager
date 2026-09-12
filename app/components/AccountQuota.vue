<script setup lang="ts">
import type { AccountSnapshot, UsageWindow } from '#shared/types'
import { getMonthlyRemaining, getQuotaBlock, getQuotaWindows } from '#shared/quota'

const props = defineProps<{ snapshot: AccountSnapshot | null; compact?: boolean }>()
const windows = computed(() => {
  const values = getQuotaWindows(props.snapshot)
  const blocked = getQuotaBlock(props.snapshot, Date.now(), false).reasons
  const periods = [
    { key: 'fiveHour', label: '5h 限额' },
    { key: 'weekly', label: '周限额' },
    { key: 'monthly', label: '月限额' },
  ] as const
  return periods.map(period => ({
    ...period,
    value: values[period.key],
    exhausted: blocked.includes(period.key),
    remaining: period.key === 'monthly' && !values.monthly ? getMonthlyRemaining(props.snapshot) : undefined,
  }))
})
function percent(window: UsageWindow) { return window.cap > 0 ? Math.max(0, Math.min(100, window.used / window.cap * 100)) : 0 }
</script>

<template>
  <dl v-if="compact" class="account-quota-list" aria-label="配额已用量与总额度">
    <div v-for="window in windows" :key="window.label" :class="{ 'quota-exhausted': window.exhausted }">
      <dt>{{ window.label }}</dt>
      <dd><span v-if="window.value" class="mono">{{ formatNumber(window.value.used) }} / {{ formatNumber(window.value.cap) }}</span><span v-else-if="window.remaining !== undefined">剩余 {{ formatNumber(window.remaining) }} · 总额未提供</span><span v-else class="muted">未提供</span><span v-if="window.exhausted" class="quota-limit-label">已满</span></dd>
    </div>
  </dl>
  <div v-else class="window-grid quota-window-grid">
    <div v-for="window in windows" :key="window.label" class="usage-window">
      <h3>{{ window.label }}</h3>
      <template v-if="window.value">
        <div class="window-value"><strong>{{ formatNumber(window.value.used) }}</strong><span>/ {{ formatNumber(window.value.cap) }}</span></div>
        <p class="quota-value-caption">已用 / 总额度</p>
        <progress v-if="window.value.cap > 0" :value="percent(window.value)" max="100" :aria-label="window.label + '已使用比例'" />
        <p>重置时间 {{ window.value.resetAt > 0 ? formatDate(window.value.resetAt) : '未提供' }}</p>
      </template>
      <template v-else-if="window.remaining !== undefined"><p class="small-text">剩余 {{ formatNumber(window.remaining) }} · 总额未提供</p><p>上游仅返回剩余额度</p></template>
      <template v-else><strong class="unknown-value">未提供</strong><p>上游暂未返回此项配额</p></template>
      <StatusBadge v-if="window.exhausted" status="cooldown" label="已达上限" class="quota-window-status" />
    </div>
  </div>
</template>
