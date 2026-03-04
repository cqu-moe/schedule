import { defineStore } from 'pinia'
import api from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'

export const useSubscriptionsStore = defineStore('subscriptions', {
  state: () => ({
    subscriptions: [],
    max: 5,
  }),

  actions: {
    async load() {
      const authStore = useAuthStore()
      const data = await api.getSubscriptions(authStore.token)
      this.subscriptions = data.subscriptions
      this.max = data.max
    },
  },
})
