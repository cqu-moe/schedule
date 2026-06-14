import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'
import type { Subscription, CalendarLink } from '@/types/api'
import { useSession } from '@/stores/session'

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const subscriptions = ref<Subscription[]>([])

  // ── Getters ────────────────────────────────────────────────────────────────

  const count = computed(() => subscriptions.value.length)

  /**
   * True when the user has reached their subscription cap.
   * null sub_limit means unlimited → never at limit.
   */
  const atLimit = computed<boolean>(() => {
    const session = useSession()
    const limit = session.quota('sub_limit')
    if (limit === null) return false
    return count.value >= limit
  })

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Returns the default CalendarLink for a subscription, or undefined if none
   * exists (shouldn't happen after subscription creation, but guard anyway).
   */
  function defaultLink(sub: Subscription): CalendarLink | undefined {
    return sub.links.find(l => l.is_default)
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function load(noCache = false) {
    const data = await api.getSubscriptions(noCache)
    subscriptions.value = data.subscriptions
  }

  function $reset() {
    subscriptions.value = []
  }

  return { subscriptions, count, atLimit, defaultLink, load, $reset }
})
