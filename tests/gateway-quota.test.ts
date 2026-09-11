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
  it('accepts observed seconds or milliseconds and resumes after a known reset', () => {
    const now = 1_790_000_000_000
    expect(snapshotIsLimited(snapshot({ weekly: { used: 6, cap: 6, exceeded: true, resetAt: (now + 60_000) / 1000 } }), now)).toBe(true)
    expect(snapshotIsLimited(snapshot({ weekly: { used: 6, cap: 6, exceeded: true, resetAt: now + 60_000 } }), now)).toBe(true)
    expect(snapshotIsLimited(snapshot({ exceeded: 'weekly', weekly: { used: 6, cap: 6, exceeded: true, resetAt: (now - 60_000) / 1000 } }), now)).toBe(false)
  })
})