import type { AccountSnapshot, UsageWindow } from './types'

export const QUOTA_WINDOW_KEYS = ['fiveHour', 'weekly', 'monthly'] as const
export type QuotaWindowKey = typeof QUOTA_WINDOW_KEYS[number]
export type QuotaBlockReason = QuotaWindowKey | 'unknown'
export interface QuotaBlock { blocked: boolean; resetAt: string | null; reasons: QuotaBlockReason[] }
export type QuotaWindows = Record<QuotaWindowKey, UsageWindow | undefined>

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function quotaResetAtMs(value: unknown): number | null {
  if (!finite(value) || value <= 0) return null
  const timestamp = value > 100_000_000_000 ? value : value * 1000
  return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null
}

function validWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const window = value as Record<string, unknown>
  if (!finite(window.used) || window.used < 0 || !finite(window.cap) || window.cap < 0) return undefined
  return {
    used: window.used, cap: window.cap, exceeded: window.exceeded === true,
    resetAt: quotaResetAtMs(window.resetAt) === null ? 0 : window.resetAt as number,
  }
}

function monthlyResetAt(snapshot: AccountSnapshot): number {
  const end = snapshot.subscription?.currentPeriodEnd
  const resetAt = typeof end === 'string' && end.trim() ? Date.parse(end) : NaN
  return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : 0
}

// The official Studio monthly meter uses monthlyCreditsGranted as the grant
// and monthlyCredits as the remaining balance. Never infer a grant from a plan
// name or combine it with the separately fetched, potentially delayed summary.
function monthlyWindow(snapshot: AccountSnapshot): UsageWindow | undefined {
  const grant = snapshot.credits?.monthlyCreditsGranted
  const remaining = snapshot.credits?.monthlyCredits
  if (!finite(grant) || grant <= 0 || !finite(remaining) || remaining > grant) return undefined
  const used = Math.max(0, grant - remaining)
  return finite(used) ? { used, cap: grant, exceeded: remaining <= 0, resetAt: monthlyResetAt(snapshot) } : undefined
}

export function getQuotaWindows(snapshot: AccountSnapshot | null | undefined): QuotaWindows {
  return {
    fiveHour: validWindow(snapshot?.windowLimits?.fiveHour),
    weekly: validWindow(snapshot?.windowLimits?.weekly),
    monthly: validWindow(snapshot?.windowLimits?.monthly) ?? (snapshot ? monthlyWindow(snapshot) : undefined),
  }
}

// Zero monthly credits alone does not mean a pay-as-you-go account is out of
// quota. A real grant or subscription window establishes a monthly allowance.
export function getMonthlyRemaining(snapshot: AccountSnapshot | null | undefined): number | undefined {
  if (!snapshot) return undefined
  const remaining = snapshot.credits?.monthlyCredits
  if (!finite(remaining)) return undefined
  const grant = snapshot.credits?.monthlyCreditsGranted
  const limits = snapshot.windowLimits
  const hasMonthlyAllowance = (finite(grant) && grant > 0) || limits?.limited === true
    || !!validWindow(limits?.monthly) || (validWindow(limits?.fiveHour)?.cap ?? 0) > 0 || (validWindow(limits?.weekly)?.cap ?? 0) > 0
  return hasMonthlyAllowance ? remaining : undefined
}

export function quotaWindowIsExhausted(window: UsageWindow | undefined): boolean {
  return !!window && (window.exceeded || window.used >= window.cap)
}

function summaryWindow(value: string): QuotaBlockReason {
  switch (value.toLowerCase().replace(/[\s_-]/g, '')) {
    case 'fivehour': case '5hour': case '5h': return 'fiveHour'
    case 'weekly': case 'week': return 'weekly'
    case 'monthly': case 'month': return 'monthly'
    default: return 'unknown'
  }
}

// respectReset=false is for a newly fetched snapshot: an expired timestamp
// cannot override an upstream response that still reports an exhausted window.
export function getQuotaBlock(snapshot: AccountSnapshot | null | undefined, now = Date.now(), respectReset = true): QuotaBlock {
  const windows = getQuotaWindows(snapshot)
  const blocked = new Map<QuotaBlockReason, number | null>()
  const add = (key: QuotaBlockReason, resetAt: unknown) => {
    const reset = quotaResetAtMs(resetAt)
    if (respectReset && reset !== null && reset <= now) return
    // A past reset in a fresh response is not a future recovery promise.
    blocked.set(key, reset !== null && reset > now ? reset : null)
  }
  for (const key of QUOTA_WINDOW_KEYS) {
    const window = windows[key]
    if (quotaWindowIsExhausted(window)) add(key, window?.resetAt)
  }
  // An observed zero monthly balance establishes exhaustion even when the
  // upstream omitted the grant; the displayed total must still stay unknown.
  const monthlyRemaining = getMonthlyRemaining(snapshot)
  if (!windows.monthly && snapshot && monthlyRemaining !== undefined && monthlyRemaining <= 0) add('monthly', monthlyResetAt(snapshot))
  const summaryValue = snapshot?.windowLimits?.exceeded
  const summary = typeof summaryValue === 'string' ? summaryValue.trim() : ''
  if (summary) {
    const key = summaryWindow(summary)
    add(key, key === 'unknown' ? undefined : windows[key]?.resetAt ?? (key === 'monthly' && snapshot ? monthlyResetAt(snapshot) : undefined))
  }
  const resets = [...blocked.values()]
  return {
    blocked: blocked.size > 0,
    resetAt: resets.length && resets.every((reset): reset is number => reset !== null) ? new Date(Math.max(...resets)).toISOString() : null,
    reasons: [...blocked.keys()],
  }
}
