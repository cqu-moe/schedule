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
    if (loaded.value) return
    try {
      const data = await api.getConfig()
      publicUrl.value = data.public_url
    } catch {
      // fallback: keep window.location.origin
    } finally {
      loaded.value = true
    }
  }

  async function loadCaptchaConfig() {
    if (captchaLoaded.value) return
    try {
      const config = await api.getCaptchaConfig()
      captchaEnabled.value = config.enabled
      captchaSitekey.value = config.sitekey
      captchaLoaded.value = true
    } catch {
      // Proceed without captcha — graceful degradation
      // Don't set captchaLoaded so it can be retried
    }
  }

  function $reset() {
    publicUrl.value = window.location.origin
    loaded.value = false
    captchaEnabled.value = false
    captchaSitekey.value = ''
    captchaLoaded.value = false
  }

  return { publicUrl, loaded, captchaEnabled, captchaSitekey, captchaLoaded, load, loadCaptchaConfig, $reset }
})
