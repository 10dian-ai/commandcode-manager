export function formatNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}
export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '暂无记录'
  const normalized = typeof value === 'number' && value < 1e12 ? value * 1000 : value
  const date = new Date(normalized)
  if (!Number.isFinite(date.getTime())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}
export function formatDuration(value: number): string {
  return value < 1000 ? value + ' ms' : (value / 1000).toFixed(1) + ' s'
}
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '未知'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
export function statusLabel(status: string): string {
  return ({
    pending: '待同步', ready: '正常', credential_expired: '凭证失效', sync_error: '同步失败',
    success: '成功', error: '失败', failed: '失败', cancelled: '已取消', incomplete: '不完整',
    allowed: '已确认可用', denied: '已确认不可用', cooldown: '冷却中',
    waiting: '等待处理', active: '处理中', completed: '已完成', delayed: '等待重试',
  } as Record<string, string>)[status] || status
}
export function statusTone(status: string): string {
  if (['ready', 'success', 'allowed', 'completed', 'enabled'].includes(status)) return 'green'
  if (['credential_expired', 'sync_error', 'error', 'failed', 'denied'].includes(status)) return 'red'
  if (['pending', 'cooldown', 'waiting', 'active', 'delayed', 'incomplete'].includes(status)) return 'amber'
  return 'neutral'
}
