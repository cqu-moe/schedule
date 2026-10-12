import { useCallback, useEffect, useRef, useState } from 'react'

export type ButtonState = 'idle' | 'loading' | 'success' | 'error'

/**
 * Manages button operation state feedback.
 * Supports tracking multiple buttons by key (e.g., one refresh button per subscription).
 */
export function useButtonFeedback() {
  const [states, setStates] = useState<Record<string, ButtonState>>({})
  const pendingRunsRef = useRef<Map<string, Promise<void>>>(new Map())
  const resetTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const mountedRef = useRef(true)

  useEffect(
    () => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        for (const timer of resetTimersRef.current.values()) clearTimeout(timer)
        resetTimersRef.current.clear()
        pendingRunsRef.current.clear()
      }
    },
    [],
  )

  const stateOf = useCallback(
    (key = '_'): ButtonState => states[key] ?? 'idle',
    [states],
  )

  const run = useCallback(async (fn: () => Promise<void>, key = '_') => {
    const pendingRun = pendingRunsRef.current.get(key)
    if (pendingRun) return pendingRun

    const clearResetTimer = () => {
      const timer = resetTimersRef.current.get(key)
      if (timer) {
        clearTimeout(timer)
        resetTimersRef.current.delete(key)
      }
    }

    const request = (async () => {
      clearResetTimer()
      setStates((prev) => ({ ...prev, [key]: 'loading' }))
      try {
        await Promise.resolve().then(fn)
        if (mountedRef.current) setStates((prev) => ({ ...prev, [key]: 'success' }))
      } catch (e) {
        if (mountedRef.current) setStates((prev) => ({ ...prev, [key]: 'error' }))
        throw e
      } finally {
        pendingRunsRef.current.delete(key)
        if (mountedRef.current) {
          clearResetTimer()
          const timer = setTimeout(() => {
            resetTimersRef.current.delete(key)
            setStates((prev) => {
              if (prev[key] === undefined) return prev
              const next = { ...prev }
              delete next[key]
              return next
            })
          }, 1500)
          resetTimersRef.current.set(key, timer)
        }
      }
    })()

    pendingRunsRef.current.set(key, request)
    return request
  }, [])

  return { stateOf, run }
}

