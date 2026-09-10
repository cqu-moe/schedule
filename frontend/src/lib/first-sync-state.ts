import type { Subscription } from '@/types/api'

export type FirstSyncPhase = 'preparing' | 'syncing' | 'success' | 'error'

export interface FirstSyncInput {
  subscriptions: Subscription[]
  targetIds: string[]
  pendingIds: ReadonlySet<string>
  localErrors: Readonly<Record<string, string>>
  preparing: boolean
  preparationError: string | null
}

export function deriveFirstSyncPhase(input: FirstSyncInput): FirstSyncPhase | null {
  if (input.preparing) return 'preparing'
  if (input.preparationError) return 'error'
  const targets = input.subscriptions.filter((subscription) =>
    input.targetIds.includes(subscription.id),
  )
  if (targets.length === 0) return null
  if (targets.some((subscription) =>
    input.pendingIds.has(subscription.id)
    || subscription.sync_status === 'queued'
    || subscription.sync_status === 'running')) {
    return 'syncing'
  }
  if (targets.some((subscription) =>
    Boolean(input.localErrors[subscription.id]) || subscription.sync_status === 'error')) {
    return 'error'
  }
  if (targets.every((subscription) =>
    subscription.sync_status === 'success' && Boolean(subscription.last_synced_at))) {
    return 'success'
  }
  return 'preparing'
}
