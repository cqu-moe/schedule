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

  /**
   * Total non-default (share) links across ALL subscriptions.
   * Used to show usage against the per-user share_limit quota.
   */
  const shareLinkCount = computed<number>(() =>
    subscriptions.value.reduce(
      (sum, sub) => sum + sub.links.filter(l => !l.is_default).length,
      0,
    ),
  )

  /**
   * True when the user has reached their share link cap.
   * null share_limit means unlimited → never at limit.
   */
  const atShareLimit = computed<boolean>(() => {
    const session = useSession()
    const limit = session.quota('share_limit')
    if (limit === null) return false
    return shareLinkCount.value >= limit
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

  return { subscriptions, count, atLimit, shareLinkCount, atShareLimit, defaultLink, load, $reset }
})
