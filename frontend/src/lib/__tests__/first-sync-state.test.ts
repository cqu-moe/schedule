import { describe, expect, it } from 'vitest'
import { mockSubscription } from '@/test-utils'
import { deriveFirstSyncPhase, type FirstSyncInput } from '@/lib/first-sync-state'

function input(overrides: Partial<FirstSyncInput> = {}): FirstSyncInput {
  return {
    subscriptions: [],
    targetIds: [],
    pendingIds: new Set(),
    localErrors: {},
    preparing: false,
    preparationError: null,
    ...overrides,
  }
}

describe('deriveFirstSyncPhase', () => {
  it.each(['queued', 'running'] as const)('keeps a %s target in syncing', (syncStatus) => {
    const subscription = mockSubscription({ id: 'a', sync_status: syncStatus })
    expect(deriveFirstSyncPhase(input({
      subscriptions: [subscription],
      targetIds: ['a'],
    }))).toBe('syncing')
  })

  it('reports success only when all targets completed with synced data', () => {
    const subscriptions = ['a', 'b', 'c'].map((id) => mockSubscription({
      id,
      sync_status: 'success',
      last_synced_at: '2026-09-10T08:00:00Z',
    }))
    expect(deriveFirstSyncPhase(input({ subscriptions, targetIds: ['a', 'b', 'c'] })))
      .toBe('success')
  })

  it('reports an error after all targets finish with a mixed success/error result', () => {
    const subscriptions = [
      mockSubscription({ id: 'a', sync_status: 'success' }),
      mockSubscription({ id: 'b', sync_status: 'error' }),
    ]
    expect(deriveFirstSyncPhase(input({ subscriptions, targetIds: ['a', 'b'] })))
      .toBe('error')
  })

  it('waits while a mixed success/queued result is still active', () => {
    const subscriptions = [
      mockSubscription({ id: 'a', sync_status: 'success' }),
      mockSubscription({ id: 'b', sync_status: 'queued' }),
    ]
    expect(deriveFirstSyncPhase(input({ subscriptions, targetIds: ['a', 'b'] })))
      .toBe('syncing')
  })

  it('does not mistake existing data for completion of a new request', () => {
    const subscription = mockSubscription({
      id: 'a',
      sync_status: 'success',
      last_synced_at: '2026-09-10T08:00:00Z',
    })
    expect(deriveFirstSyncPhase(input({
      subscriptions: [subscription],
      targetIds: ['a'],
      pendingIds: new Set(['a']),
    }))).toBe('syncing')
  })

  it('uses preparation errors before subscription state', () => {
    expect(deriveFirstSyncPhase(input({ preparationError: 'offline' }))).toBe('error')
  })

  it('returns null when no target subscription exists', () => {
    expect(deriveFirstSyncPhase(input({ targetIds: ['deleted'] }))).toBeNull()
  })

  it('derives the result from surviving targets after one is deleted', () => {
    const remaining = mockSubscription({
      id: 'remaining',
      sync_status: 'success',
      last_synced_at: '2026-09-10T08:00:00Z',
    })
    expect(deriveFirstSyncPhase(input({
      subscriptions: [remaining],
      targetIds: ['deleted', 'remaining'],
    }))).toBe('success')
  })

  it('does not report success without last_synced_at', () => {
    const subscription = mockSubscription({
      id: 'a',
      sync_status: 'success',
      last_synced_at: null,
    })
    expect(deriveFirstSyncPhase(input({ subscriptions: [subscription], targetIds: ['a'] })))
      .toBe('preparing')
  })

  it('lets a local timeout override stale successful data', () => {
    const subscription = mockSubscription({
      id: 'a',
      sync_status: 'success',
      last_synced_at: '2026-09-10T08:00:00Z',
    })
    expect(deriveFirstSyncPhase(input({
      subscriptions: [subscription],
      targetIds: ['a'],
      localErrors: { a: '同步超时，请稍后重试' },
    }))).toBe('error')
  })

  it('keeps preparation loading ahead of an older error', () => {
    expect(deriveFirstSyncPhase(input({
      preparing: true,
      preparationError: 'old error',
    }))).toBe('preparing')
  })
})
