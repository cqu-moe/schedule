import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'

export const useConfigStore = defineStore('config', () => {
  const publicUrl = ref(window.location.origin)
  const loaded = ref(false)

  async function load() {
    if (loaded.value) return
    try {
      const data = await api.getConfig()
      publicUrl.value = data.public_url
      loaded.value = true
    } catch (e) {
      console.warn('[config] Failed to load config:', e)
      // Fallback to origin; mark loaded so subsequent calls skip the fetch.
      loaded.value = true
    }
  }

  function $reset() {
    publicUrl.value = window.location.origin
    loaded.value = false
  }

  return { publicUrl, loaded, load, $reset }
})
