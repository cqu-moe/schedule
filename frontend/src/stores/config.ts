import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'

export const useConfigStore = defineStore('config', () => {
  const publicUrl = ref(window.location.origin)
  const loaded = ref(false)
  const captchaEnabled = ref(false)
  const captchaSitekey = ref('')
  const captchaLoaded = ref(false)

  async function load() {
    if (loaded.value && captchaLoaded.value) return
    try {
      const data = await api.getConfig()
      publicUrl.value = data.public_url
      captchaEnabled.value = data.captcha.enabled
      captchaSitekey.value = data.captcha.sitekey
      loaded.value = true
      captchaLoaded.value = true
    } catch (e) {
      console.warn('[config] Failed to load config:', e)
      // Mark publicUrl as loaded (fallback to origin), but allow captcha retry
      loaded.value = true
    }
  }

  function $reset() {
    publicUrl.value = window.location.origin
    loaded.value = false
    captchaEnabled.value = false
    captchaSitekey.value = ''
    captchaLoaded.value = false
  }

  return { publicUrl, loaded, captchaEnabled, captchaSitekey, captchaLoaded, load, $reset }
})
