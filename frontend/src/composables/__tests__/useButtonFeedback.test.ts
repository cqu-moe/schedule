import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useButtonFeedback } from '@/composables/useButtonFeedback'

describe('useButtonFeedback', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts in idle state with default key', () => {
    const { stateOf } = useButtonFeedback()
    expect(stateOf()).toBe('idle')
  })

  it('starts in idle state with custom key', () => {
    const { stateOf } = useButtonFeedback()
    expect(stateOf('some-key')).toBe('idle')
  })

  it('transitions to loading during run', async () => {
    const { stateOf, run } = useButtonFeedback()
    let resolve!: () => void
    const promise = run(() => new Promise<void>(r => { resolve = r }))

    expect(stateOf()).toBe('loading')

    resolve()
    await promise
  })

  it('transitions to success after successful run', async () => {
    const { stateOf, run } = useButtonFeedback()
    await run(async () => {})

    expect(stateOf()).toBe('success')
  })

  it('resets to idle after 1500ms on success', async () => {
    const { stateOf, run } = useButtonFeedback()
    await run(async () => {})

    expect(stateOf()).toBe('success')
    vi.advanceTimersByTime(1500)
    expect(stateOf()).toBe('idle')
  })

  it('transitions to error and re-throws on failure', async () => {
    const { stateOf, run } = useButtonFeedback()
    const error = new Error('test error')

    await expect(run(async () => { throw error })).rejects.toThrow('test error')
    expect(stateOf()).toBe('error')
  })

  it('resets to idle after 1500ms on error', async () => {
    const { stateOf, run } = useButtonFeedback()

    await run(async () => { throw new Error('fail') }).catch(() => {})

    expect(stateOf()).toBe('error')
    vi.advanceTimersByTime(1500)
    expect(stateOf()).toBe('idle')
  })

  it('isolates state between different keys', async () => {
    const { stateOf, run } = useButtonFeedback()

    await run(async () => {}, 'key-a')
    expect(stateOf('key-a')).toBe('success')
    expect(stateOf('key-b')).toBe('idle')
  })
})
