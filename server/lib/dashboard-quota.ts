import type { AccountSnapshot, DashboardView, QuotaTotal } from '../../shared/types'
import { getQuotaBlock, getQuotaWindows } from '../../shared/quota'

export interface DashboardQuotaAccount {
  enabled: boolean
  status: string
  has_api_key: boolean
  snapshot: AccountSnapshot | null
}

const emptyTotal = (): QuotaTotal => ({ used: 0, cap: 0, remaining: 0, knownAccounts: 0, unknownAccounts: 0 })
const quotaPeriods = ['fiveHour', 'weekly', 'monthly'] as const

export function summarizeDashboardQuota(accounts: readonly DashboardQuotaAccount[], now = Date.now()): DashboardView['quota'] {
  const result: DashboardView['quota'] = { accountCount: 0, fiveHour: emptyTotal(), weekly: emptyTotal(), monthly: emptyTotal() }
  for (const account of accounts) {
    if (!account.enabled || account.status !== 'ready' || !account.has_api_key || getQuotaBlock(account.snapshot, now, false).blocked) continue
    result.accountCount++
    const windows = getQuotaWindows(account.snapshot)
    for (const period of quotaPeriods) {
      const window = windows[period]
      const total = result[period]
      if (!window || !Number.isFinite(window.used) || !Number.isFinite(window.cap) || window.used < 0 || window.cap < 0) {
        total.unknownAccounts++
        continue
      }
      total.knownAccounts++
      total.used += window.used
      total.cap += window.cap
      total.remaining += Math.max(0, window.cap - window.used)
    }
  }
  return result
}
