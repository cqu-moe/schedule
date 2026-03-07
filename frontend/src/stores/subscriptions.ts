import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Subscription } from '@/types/api'

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const subscriptions = ref<Subscription[]>([])
  const max = ref(5)

  async function load(noCache = false) {
    const authStore = useAuthStore()
    const data = await api.getSubscriptions(authStore.token, noCache)
    subscriptions.value = data.subscriptions
    max.value = data.max
  }

  function $reset() {
    subscriptions.value = []
    max.value = 5
  }

  return { subscriptions, max, load, $reset }
})
