import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useButtonFeedback } from '@/hooks/useButtonFeedback'

describe('useButtonFeedback', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup() {
    return renderHook(() => useButtonFeedback()).result
  }

  function controlledPromise() {
    let resolve!: () => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
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
    const operation = controlledPromise()
    let promise: Promise<void>
    act(() => {
      promise = result.current.run(async () => { await operation.promise })
    })
    expect(result.current.stateOf()).toBe('loading')
    await act(async () => {
      operation.resolve()
      await promise
    })
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

  it('reuses the in-flight request when the same key runs again', async () => {
    const result = setup()
    const operation = controlledPromise()
    const run = vi.fn(async () => { await operation.promise })
    let first!: Promise<void>
    let second!: Promise<void>

    act(() => {
      first = result.current.run(run)
      second = result.current.run(run)
    })

    expect(result.current.stateOf()).toBe('loading')

    await act(async () => {
      operation.resolve()
      await Promise.all([first, second])
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.current.stateOf()).toBe('success')
  })

  it('keeps a newer same-key run loading after the older result timer expires', async () => {
    const result = setup()
    const firstOperation = controlledPromise()
    const secondOperation = controlledPromise()
    let first!: Promise<void>

    act(() => {
      first = result.current.run(async () => { await firstOperation.promise })
    })
    await act(async () => {
      firstOperation.resolve()
      await first
    })

    let second!: Promise<void>
    act(() => {
      second = result.current.run(async () => { await secondOperation.promise })
    })

    act(() => { vi.advanceTimersByTime(1500) })
    expect(result.current.stateOf()).toBe('loading')

    await act(async () => {
      secondOperation.resolve()
      await second
    })
    expect(result.current.stateOf()).toBe('success')
  })

  it('clears pending feedback timers on unmount', async () => {
    const hook = renderHook(() => useButtonFeedback())
    await act(async () => {
      await hook.result.current.run(async () => {})
    })

    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows retry after a synchronous operation failure', async () => {
    const result = setup()
    let attempts = 0
    let first!: Promise<void>

    act(() => {
      first = result.current.run(() => {
        attempts += 1
        throw new Error('sync failure')
      })
    })
    expect(result.current.stateOf()).toBe('loading')

    await act(async () => {
      await first.catch(() => {})
    })
    expect(attempts).toBe(1)
    expect(result.current.stateOf()).toBe('error')

    await act(async () => {
      await result.current.run(async () => {
        attempts += 1
      })
    })
    expect(attempts).toBe(2)
    expect(result.current.stateOf()).toBe('success')
  })

  it('preserves operation rejection after unmount', async () => {
    const hook = renderHook(() => useButtonFeedback())
    const operation = controlledPromise()
    let request!: Promise<void>

    act(() => {
      request = hook.result.current.run(async () => { await operation.promise })
    })
    hook.unmount()

    let caught: unknown
    await act(async () => {
      operation.reject(new Error('failed after unmount'))
      try {
        await request
      } catch (error) {
        caught = error
      }
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('failed after unmount')
    expect(vi.getTimerCount()).toBe(0)
  })
})
