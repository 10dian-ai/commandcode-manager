import type { AccountSnapshot } from '../../../shared/types'
import { getQuotaBlock } from '../../../shared/quota'

export function snapshotIsLimited(snapshot: AccountSnapshot | null, now = Date.now()): boolean {
  // Resume only after a synchronized snapshot confirms every exhausted quota recovered.
  return getQuotaBlock(snapshot, now, false).blocked
}
