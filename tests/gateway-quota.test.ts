import { describe, expect, it } from 'vitest'
import type { AccountSnapshot } from '../shared/types'
import { snapshotIsLimited } from '../server/lib/gateway/quota'
function snapshot(windowLimits: AccountSnapshot['windowLimits']) {
  return { windowLimits } as AccountSnapshot
}
describe('real quota window semantics', () => {
  it('keeps the observed healthy Go account eligible despite limited=true', () => {
    expect(snapshotIsLimited(snapshot({
      limited: true, exceeded: null,
      fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
      weekly: { used: 0, cap: 6, exceeded: false, resetAt: 0 },
    }))).toBe(false)
  })
  it('excludes explicitly exhausted windows without inventing a reset for zero', () => {
    expect(snapshotIsLimited(snapshot({ fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: 0 } }))).toBe(true)
    expect(snapshotIsLimited(snapshot({ exceeded: 'weekly' }))).toBe(true)
    expect(snapshotIsLimited(snapshot({ limited: true }))).toBe(false)
  })
  it('accepts observed seconds or milliseconds and waits for a healthy snapshot after reset', () => {
    const now = 1_790_000_000_000
    expect(snapshotIsLimited(snapshot({ weekly: { used: 6, cap: 6, exceeded: true, resetAt: (now + 60_000) / 1000 } }), now)).toBe(true)
    expect(snapshotIsLimited(snapshot({ weekly: { used: 6, cap: 6, exceeded: true, resetAt: now + 60_000 } }), now)).toBe(true)
    expect(snapshotIsLimited(snapshot({ exceeded: 'weekly', weekly: { used: 6, cap: 6, exceeded: true, resetAt: (now - 60_000) / 1000 } }), now)).toBe(true)
    expect(snapshotIsLimited(snapshot({ exceeded: null, weekly: { used: 0, cap: 6, exceeded: false, resetAt: 0 } }), now)).toBe(false)
  })
  it('does not clear a weekly summary merely because the five-hour window reset', () => {
    const now = 1_790_000_000_000
    expect(snapshotIsLimited(snapshot({ exceeded: 'weekly', fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: (now - 60_000) / 1000 } }), now)).toBe(true)
    expect(snapshotIsLimited(snapshot({ exceeded: 'weekly', weekly: { used: 6, cap: 6, exceeded: false, resetAt: (now + 60_000) / 1000 } }), now)).toBe(true)
  })
})

describe('gateway quota normalization integration', () => {
  it('excludes exact-cap five-hour, weekly and monthly balances', () => {
    for (const key of ['fiveHour', 'weekly', 'monthly'] as const) {
      expect(snapshotIsLimited(snapshot({ [key]: { used: 10, cap: 10, resetAt: 0, exceeded: false } }))).toBe(true)
    }
  })
  it('uses the real monthly grant and balance when the upstream has no monthly window', () => {
    const value = { credits: { monthlyCreditsGranted: 10, monthlyCredits: 0 }, windowLimits: null, subscription: { currentPeriodEnd: null } } as AccountSnapshot
    expect(snapshotIsLimited(value)).toBe(true)
  })
})
