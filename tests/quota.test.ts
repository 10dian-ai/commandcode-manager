import { describe, expect, it } from 'vitest'
import type { AccountSnapshot, UsageWindow } from '../shared/types'
import { getMonthlyRemaining, getQuotaBlock, getQuotaWindows, quotaResetAtMs, quotaWindowIsExhausted } from '../shared/quota'
import { buildSnapshot } from '../server/lib/commandcode'

const now = Date.parse('2026-09-12T00:00:00Z')
const end = '2026-10-05T07:35:12Z'
const quota = (used: number, cap: number, resetAt = 0, exceeded = false): UsageWindow => ({ used, cap, resetAt, exceeded })
function snapshot(fields: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    identity: { id: 'fixture-user', name: 'Fixture', email: null },
    credits: {}, windowLimits: null,
    subscription: { planId: 'individual-go', status: 'active', currentPeriodStart: '2026-09-05T07:35:12Z', currentPeriodEnd: end, cancelAtPeriodEnd: false },
    usage: null, fetchedAt: new Date(now).toISOString(), ...fields,
  }
}

describe('monthly quota normalization', () => {
  it('uses the observed grant and remaining balance independently of delayed usage summaries', () => {
    const value = snapshot({ credits: { monthlyCreditsGranted: 10, monthlyCredits: 9.991540466 }, usage: { totalCost: 0, totalMonthlyCredits: 0 } })
    expect(getQuotaWindows(value).monthly).toEqual({ cap: 10, used: 10 - 9.991540466, exceeded: false, resetAt: Date.parse(end) })
    expect(value.usage?.totalCost).toBe(0)
    expect(value.credits.monthlyCredits).toBe(9.991540466)
  })
  it('prefers a directly reported monthly window over credit-derived presentation', () => {
    const monthly = quota(4, 50, now + 60_000, true)
    const value = snapshot({ credits: { monthlyCreditsGranted: 10, monthlyCredits: 0 }, windowLimits: { monthly } })
    expect(getQuotaWindows(value).monthly).toEqual(monthly)
  })
  it('does not guess missing totals, coerce strings, or fill inconsistent balances with zero usage', () => {
    for (const credits of [
      { monthlyCredits: 10 }, { monthlyCreditsGranted: 10 },
      { monthlyCreditsGranted: '10', monthlyCredits: 4 }, { monthlyCreditsGranted: 10, monthlyCredits: '4' },
      { monthlyCreditsGranted: 0, monthlyCredits: 0 }, { monthlyCreditsGranted: 10, monthlyCredits: 11 },
      { monthlyCreditsGranted: Infinity, monthlyCredits: 0 }, { monthlyCreditsGranted: 10, monthlyCredits: NaN },
    ]) expect(getQuotaWindows(snapshot({ credits })).monthly).toBeUndefined()
  })
  it('leaves unavailable month reset times unknown and retains negative balance exhaustion', () => {
    const value = snapshot({ credits: { monthlyCreditsGranted: 10, monthlyCredits: -0.5 } })
    value.subscription.currentPeriodEnd = 'invalid'
    expect(getQuotaWindows(value).monthly).toEqual(quota(10.5, 10, 0, true))
    expect(getQuotaBlock(value, now)).toEqual({ blocked: true, resetAt: null, reasons: ['monthly'] })
  })
  it('persists normalized monthly data while preserving every raw credits field', () => {
    const credits = { monthlyCreditsGranted: 10, monthlyCredits: 8, purchasedCredits: 99 }
    const value = buildSnapshot({ user: { id: 'fixture-user' } }, { credits, windowLimits: { limited: true } }, snapshot().subscription, { totalCost: 0 })
    expect(value.windowLimits?.monthly).toEqual(quota(2, 10, Date.parse(end)))
    expect(value.credits).toEqual(credits)
  })
  it('normalizes monthly data even when the upstream omits rolling windows', () => {
    const value = buildSnapshot({ user: { id: 'fixture-user' } }, { credits: { monthlyCreditsGranted: 10, monthlyCredits: 8 } }, snapshot().subscription, {})
    expect(value.windowLimits?.monthly).toEqual(quota(2, 10, Date.parse(end)))
  })
})

describe('quota exhaustion and recovery decisions', () => {
  it('does not treat limited=true or missing quota data as exhaustion', () => {
    expect(getQuotaBlock(snapshot({ windowLimits: { limited: true, exceeded: null, fiveHour: quota(0, 3), weekly: quota(0, 6) } }), now).blocked).toBe(false)
    expect(getQuotaBlock(null, now)).toEqual({ blocked: false, resetAt: null, reasons: [] })
  })
  it('exhausts at the exact cap for all three windows even when exceeded is false', () => {
    for (const key of ['fiveHour', 'weekly', 'monthly'] as const) {
      expect(getQuotaBlock(snapshot({ windowLimits: { [key]: quota(3, 3) } }), now)).toEqual({ blocked: true, resetAt: null, reasons: [key] })
    }
    expect(quotaWindowIsExhausted(quota(0, 0))).toBe(true)
    expect(quotaWindowIsExhausted(quota(0, 3, 0, true))).toBe(true)
  })
  it('takes the latest known exhausted-window reset instead of resuming at the earliest', () => {
    const value = snapshot({ windowLimits: { fiveHour: quota(3, 3, (now + 60_000) / 1000), weekly: quota(6, 6, now + 120_000), monthly: quota(2, 10, Date.parse(end)) } })
    expect(getQuotaBlock(value, now)).toEqual({ blocked: true, resetAt: new Date(now + 120_000).toISOString(), reasons: ['fiveHour', 'weekly'] })
    expect(getQuotaBlock(value, now + 90_000).reasons).toEqual(['weekly'])
    expect(getQuotaBlock(value, now + 120_000).blocked).toBe(false)
  })
  it('keeps recovery unknown when any exhausted window has an unknown reset', () => {
    expect(getQuotaBlock(snapshot({ windowLimits: { fiveHour: quota(3, 3, now + 60_000), weekly: quota(6, 6) } }), now).resetAt).toBeNull()
    expect(getQuotaBlock(snapshot({ windowLimits: { weekly: quota(6, 6, Infinity) } }), now).blocked).toBe(true)
    expect(quotaResetAtMs(0)).toBeNull()
    expect(quotaResetAtMs(-1)).toBeNull()
    expect(quotaResetAtMs(Number.MAX_VALUE)).toBeNull()
  })
  it('does not consider a fresh exhausted response recovered merely because its old reset passed', () => {
    const value = snapshot({ windowLimits: { fiveHour: quota(3, 3, now - 1) } })
    expect(getQuotaBlock(value, now).blocked).toBe(false)
    expect(getQuotaBlock(value, now, false)).toEqual({ blocked: true, resetAt: null, reasons: ['fiveHour'] })
  })
  it('honors explicit summaries independently and leaves unrecognized summaries blocked', () => {
    expect(getQuotaBlock(snapshot({ windowLimits: { exceeded: 'weekly', fiveHour: quota(3, 3, now - 1) } }), now).reasons).toEqual(['weekly'])
    expect(getQuotaBlock(snapshot({ windowLimits: { exceeded: ' 5-Hour ', fiveHour: quota(0, 3, now + 1) } }), now).reasons).toEqual(['fiveHour'])
    expect(getQuotaBlock(snapshot({ windowLimits: { exceeded: 'new-upstream-limit' } }), now)).toEqual({ blocked: true, resetAt: null, reasons: ['unknown'] })
  })
  it('blocks an observed empty subscription month without inventing its missing total', () => {
    const value = snapshot({ credits: { monthlyCredits: 0 }, windowLimits: { limited: true, fiveHour: quota(0, 3) } })
    expect(getQuotaWindows(value).monthly).toBeUndefined()
    expect(getQuotaBlock(value, now)).toEqual({ blocked: true, resetAt: new Date(end).toISOString(), reasons: ['monthly'] })
    value.credits.monthlyCredits = 2
    expect(getMonthlyRemaining(value)).toBe(2)
    expect(getQuotaBlock(value, now).blocked).toBe(false)
  })
  it('does not mistake pay-as-you-go zero monthly credits for a exhausted subscription', () => {
    const value = snapshot({ credits: { monthlyCredits: 0, purchasedCredits: 15 }, windowLimits: { limited: false } })
    expect(getMonthlyRemaining(value)).toBeUndefined()
    expect(getQuotaBlock(value, now).blocked).toBe(false)
  })
  it('does not count invalid rolling-window amounts as real known data', () => {
    expect(getQuotaWindows(snapshot({ windowLimits: { fiveHour: quota(-1, 3), weekly: quota(0, Infinity) } }))).toEqual({ fiveHour: undefined, weekly: undefined, monthly: undefined })
  })
})
