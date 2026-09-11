import type { AccountSnapshot } from '../../../shared/types'
function timestampMs(value: number) { return value > 100_000_000_000 ? value : value * 1000 }

// limited=true means the plan HAS windows, as confirmed by the recorded upstream
// response. Exhaustion comes only from an explicit exceeded value, never from
// limited, derived subtraction, or an unverified credit field.
export function snapshotIsLimited(snapshot: AccountSnapshot | null, now = Date.now()): boolean {
  const limits = snapshot?.windowLimits
  if (!limits) return false
  const windows = [limits.fiveHour, limits.weekly].filter(Boolean)
  const exceeded = windows.filter(window => window!.exceeded)
  if (exceeded.some(window => !window!.resetAt || timestampMs(window!.resetAt) > now)) return true
  if (exceeded.length) return false // Every reported exhausted window has now reset.
  return typeof limits.exceeded === 'string' && limits.exceeded.trim().length > 0
}