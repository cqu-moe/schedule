import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'

export const useConfigStore = defineStore('config', () => {
  const publicUrl = ref(window.location.origin)
  const loaded = ref(false)
  const captchaEnabled = ref(false)
  const captchaSitekey = ref('')

  async function load() {
    if (loaded.value) return
    try {
      const data = await api.getConfig()
      publicUrl.value = data.public_url
      captchaEnabled.value = data.captcha.enabled
      captchaSitekey.value = data.captcha.sitekey
    } catch {
      // fallback: keep defaults, captcha disabled
    } finally {
      loaded.value = true
    }
  }

  function $reset() {
    publicUrl.value = window.location.origin
    loaded.value = false
    captchaEnabled.value = false
    captchaSitekey.value = ''
  }

  return { publicUrl, loaded, captchaEnabled, captchaSitekey, load, $reset }
})
