import { reactive } from 'vue'

export type ButtonState = 'idle' | 'loading' | 'success' | 'error'

/**
 * Manages button operation state feedback.
 * Supports tracking multiple buttons by key (e.g., one refresh button per subscription).
 */
export function useButtonFeedback() {
  const states = reactive(new Map<string, ButtonState>())

  function stateOf(key = '_'): ButtonState {
    return states.get(key) ?? 'idle'
  }

  async function run(fn: () => Promise<void>, key = '_') {
    states.set(key, 'loading')
    try {
      await fn()
      states.set(key, 'success')
    } catch (e) {
      states.set(key, 'error')
      throw e
    } finally {
      setTimeout(() => { states.delete(key) }, 1500)
    }
  }

  return { stateOf, run }
}
