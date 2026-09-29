import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useButtonFeedback } from '@/hooks/useButtonFeedback'

describe('useButtonFeedback', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup() {
    return renderHook(() => useButtonFeedback()).result
  }

  it('starts in idle state with default key', () => {
    const result = setup()
    expect(result.current.stateOf()).toBe('idle')
  })

  it('starts in idle state with custom key', () => {
    const result = setup()
    expect(result.current.stateOf('some-key')).toBe('idle')
  })

  it('transitions to loading during run', async () => {
    const result = setup()
    let resolve!: () => void
    let promise: Promise<void>
    act(() => {
      promise = result.current.run(() => new Promise<void>(r => { resolve = r }))
    })
    expect(result.current.stateOf()).toBe('loading')
    await act(async () => { resolve(); await promise })
  })

  it('transitions to success after successful run', async () => {
    const result = setup()
    await act(async () => { await result.current.run(async () => {}) })
    expect(result.current.stateOf()).toBe('success')
  })

  it('resets to idle after 1500ms on success', async () => {
    const result = setup()
    await act(async () => { await result.current.run(async () => {}) })
    expect(result.current.stateOf()).toBe('success')
    act(() => { vi.advanceTimersByTime(1500) })
    expect(result.current.stateOf()).toBe('idle')
  })

  it('transitions to error and re-throws on failure', async () => {
    const result = setup()
    let caught: unknown
    await act(async () => {
      try {
        await result.current.run(async () => { throw new Error('test error') })
      } catch (e) {
        caught = e
      }
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('test error')
    expect(result.current.stateOf()).toBe('error')
  })

  it('resets to idle after 1500ms on error', async () => {
    const result = setup()
    await act(async () => {
      await result.current.run(async () => { throw new Error('fail') }).catch(() => {})
    })
    expect(result.current.stateOf()).toBe('error')
    act(() => { vi.advanceTimersByTime(1500) })
    expect(result.current.stateOf()).toBe('idle')
  })

  it('isolates state between different keys', async () => {
    const result = setup()
    await act(async () => { await result.current.run(async () => {}, 'key-a') })
    expect(result.current.stateOf('key-a')).toBe('success')
    expect(result.current.stateOf('key-b')).toBe('idle')
  })
})
