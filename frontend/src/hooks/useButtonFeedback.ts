import { useCallback, useState } from 'react'

export type ButtonState = 'idle' | 'loading' | 'success' | 'error'

/**
 * Manages button operation state feedback.
 * Supports tracking multiple buttons by key (e.g., one refresh button per subscription).
 */
export function useButtonFeedback() {
  const [states, setStates] = useState<Record<string, ButtonState>>({})

  const stateOf = useCallback(
    (key = '_'): ButtonState => states[key] ?? 'idle',
    [states],
  )

  const run = useCallback(async (fn: () => Promise<void>, key = '_') => {
    setStates((prev) => ({ ...prev, [key]: 'loading' }))
    try {
      await fn()
      setStates((prev) => ({ ...prev, [key]: 'success' }))
    } catch (e) {
      setStates((prev) => ({ ...prev, [key]: 'error' }))
      throw e
    } finally {
      setTimeout(() => {
        setStates((prev) => {
          if (prev[key] === undefined) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }, 1500)
    }
  }, [])

  return { stateOf, run }
}

