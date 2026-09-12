import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountSnapshot, UsageWindow } from '../shared/types'
import { summarizeDashboardQuota, type DashboardQuotaAccount } from '../server/lib/dashboard-quota'

const fixture = vi.hoisted(() => ({ db: vi.fn(), get: vi.fn(), zcount: vi.fn() }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.db }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ get: fixture.get, zcount: fixture.zcount }) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ kernelUrl: 'http://kernel.example.invalid' }) }))
import { getDashboardView } from '../server/lib/dashboard'

const now = Date.parse('2026-09-12T00:00:00Z')
const window = (used: number, cap: number, resetAt = now + 60_000): UsageWindow => ({ used, cap, exceeded: false, resetAt })
function snapshot(limits: AccountSnapshot['windowLimits']): AccountSnapshot {
  return {
    identity: { id: 'upstream-id', name: 'Account', email: null },
    credits: {}, windowLimits: limits,
    subscription: { planId: null, status: null, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: null },
    usage: null, fetchedAt: new Date(now).toISOString(),
  }
}
const account = (limits: AccountSnapshot['windowLimits'] = null, overrides: Partial<DashboardQuotaAccount> = {}): DashboardQuotaAccount => ({
  enabled: true, status: 'ready', has_api_key: true, snapshot: snapshot(limits), ...overrides,
})
const completeAccounts = () => [
  account({ fiveHour: window(2, 10), weekly: window(5, 40), monthly: window(9, 120) }),
  account({ fiveHour: window(3, 20), weekly: window(11, 60), monthly: window(31, 180) }),
]

beforeEach(() => { vi.resetAllMocks() })

describe('dashboard quota from usable pool accounts', () => {
  it('adds each real window independently across normal enabled accounts', () => {
    expect(summarizeDashboardQuota(completeAccounts(), now)).toEqual({
      accountCount: 2,
      fiveHour: { used: 5, cap: 30, remaining: 25, knownAccounts: 2, unknownAccounts: 0 },
      weekly: { used: 16, cap: 100, remaining: 84, knownAccounts: 2, unknownAccounts: 0 },
      monthly: { used: 40, cap: 300, remaining: 260, knownAccounts: 2, unknownAccounts: 0 },
    })
  })

  it('excludes disabled, abnormal, keyless and exhausted accounts from every total', () => {
    const healthy = account({ fiveHour: window(1, 10), weekly: window(2, 20), monthly: window(3, 30) })
    const excluded = [
      account(null, { enabled: false }),
      account(null, { status: 'pending' }),
      account(null, { status: 'credential_expired' }),
      account(null, { status: 'sync_error' }),
      account(null, { has_api_key: false }),
      account({ fiveHour: window(10, 10) }),
      account({ weekly: { ...window(10, 20), exceeded: true } }),
      account({ monthly: window(31, 30) }),
      account({ exceeded: 'monthly' }),
    ]
    expect(summarizeDashboardQuota([healthy, ...excluded], now)).toEqual(summarizeDashboardQuota([healthy], now))
  })

  it('reports unknown coverage separately for each missing window without deriving a monthly plan', () => {
    const result = summarizeDashboardQuota([
      account({ fiveHour: window(2, 10) }),
      account({ weekly: window(4, 20), monthly: window(6, 30) }),
      account(null, { snapshot: null }),
    ], now)
    expect(result).toEqual({
      accountCount: 3,
      fiveHour: { used: 2, cap: 10, remaining: 8, knownAccounts: 1, unknownAccounts: 2 },
      weekly: { used: 4, cap: 20, remaining: 16, knownAccounts: 1, unknownAccounts: 2 },
      monthly: { used: 6, cap: 30, remaining: 24, knownAccounts: 1, unknownAccounts: 2 },
    })
  })

  it('sums monthly credits using the upstream grant and remaining values from older snapshots', () => {
    const first = snapshot(null); first.credits = { monthlyCreditsGranted: 100, monthlyCredits: 65 }
    const second = snapshot(null); second.credits = { monthlyCreditsGranted: 40, monthlyCredits: 8 }
    const result = summarizeDashboardQuota([account(null, { snapshot: first }), account(null, { snapshot: second })], now)
    expect(result.monthly).toEqual({ used: 67, cap: 140, remaining: 73, knownAccounts: 2, unknownAccounts: 0 })
    expect(result.fiveHour.unknownAccounts).toBe(2)
    expect(result.weekly.unknownAccounts).toBe(2)
  })

  it('keeps the monthly cap unknown when the upstream only returned remaining credits', () => {
    const incomplete = snapshot(null); incomplete.credits = { monthlyCredits: 65 }
    const result = summarizeDashboardQuota([account(null, { snapshot: incomplete })], now)
    expect(result.monthly).toEqual({ used: 0, cap: 0, remaining: 0, knownAccounts: 0, unknownAccounts: 1 })
  })

  it('excludes stale exhausted snapshots until a fresh sync confirms recovery', () => {
    const result = summarizeDashboardQuota([
      account({ fiveHour: { ...window(10, 10, now - 1), exceeded: true } }),
    ], now)
    expect(result.accountCount).toBe(0)
    expect(result.fiveHour).toEqual({ used: 0, cap: 0, remaining: 0, knownAccounts: 0, unknownAccounts: 0 })
  })

  it('does not turn malformed limits into plausible totals', () => {
    const result = summarizeDashboardQuota([
      account({ fiveHour: window(Number.NaN, 10), weekly: window(2, Number.POSITIVE_INFINITY), monthly: window(-1, 20) }),
    ], now)
    expect(result.accountCount).toBe(1)
    for (const period of [result.fiveHour, result.weekly, result.monthly]) {
      expect(period).toEqual({ used: 0, cap: 0, remaining: 0, knownAccounts: 0, unknownAccounts: 1 })
    }
  })

  it('returns an empty usable pool with explicit zero coverage', () => {
    const result = summarizeDashboardQuota([], now)
    expect(result.accountCount).toBe(0)
    for (const period of [result.fiveHour, result.weekly, result.monthly]) {
      expect(period).toEqual({ used: 0, cap: 0, remaining: 0, knownAccounts: 0, unknownAccounts: 0 })
    }
  })
})

describe('dashboard quota integration', () => {
  it('reads stored snapshots once and uses the same usable pool count without upstream account requests', async () => {
    const accounts = completeAccounts()
    accounts.push(account({ monthly: { ...window(30, 30, Date.now() + 60_000), exceeded: true } }))
    fixture.db.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join('?')
      if (query.includes('AS has_api_key')) return accounts
      if (query.includes('FROM managed_accounts')) return [{ total: 8, enabled: 6, attention: 2, pending: 1, last_sync_at: new Date(now) }]
      if (query.includes('FROM request_logs')) return [{ total: 12, success: 9, failed: 3 }]
      throw new Error('Unexpected query: ' + query)
    })
    fixture.get.mockResolvedValue('worker-heartbeat')
    fixture.zcount.mockResolvedValue(2)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    try {
      const result = await getDashboardView()
      expect(result.counts).toEqual({ total: 8, enabled: 6, ready: 2, needsAttention: 2, notSynced: 1 })
      expect(result.quota).toEqual(summarizeDashboardQuota(completeAccounts(), now))
      expect(result.requests).toEqual({ total: 12, success: 9, failed: 3, inFlight: 2 })
      expect(result.lastSyncAt).toBe(new Date(now).toISOString())
      const quotaQueries = fixture.db.mock.calls.map(([strings]) => (strings as TemplateStringsArray).join('?')).filter(query => query.includes('AS has_api_key'))
      expect(quotaQueries).toHaveLength(1)
      expect(quotaQueries[0]).toContain("WHERE enabled AND status='ready' AND api_key_ciphertext IS NOT NULL AND api_key_ciphertext<>''")
      expect(fixture.db).toHaveBeenCalledTimes(3)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('http://kernel.example.invalid/health', expect.any(Object))
    } finally {
      fetchMock.mockRestore()
    }
  })
})
