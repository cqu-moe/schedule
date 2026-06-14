import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'
import type { Subscription } from '@/types/api'

// TODO(FE-2): This store will be fully rewritten for the v2 Dashboard.
// For now it provides a minimal shim so Dashboard.vue compiles.
export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const subscriptions = ref<Subscription[]>([])
  // v2: cap comes from session caps.sub_limit (null = unlimited); use 99 as placeholder
  const max = ref(99)

  async function load(noCache = false) {
    const data = await api.getSubscriptions(noCache)
    subscriptions.value = data.subscriptions
    // TODO(FE-2): derive max from session.quota('sub_limit') instead
    max.value = 99
  }

  function $reset() {
    subscriptions.value = []
    max.value = 99
  }

  return { subscriptions, max, load, $reset }
})
