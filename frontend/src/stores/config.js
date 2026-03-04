import { defineStore } from 'pinia'
import api from '@/api/index.js'

export const useConfigStore = defineStore('config', {
  state: () => ({
    publicUrl: window.location.origin,
    loaded: false,
    captchaEnabled: false,
    captchaSitekey: '',
    captchaLoaded: false,
  }),

  actions: {
    async load() {
      if (this.loaded) return
      try {
        const data = await api.getConfig()
        this.publicUrl = data.public_url
      } catch {
        // fallback: keep window.location.origin
      } finally {
        this.loaded = true
      }
    },

    async loadCaptchaConfig() {
      if (this.captchaLoaded) return
      try {
        const config = await api.getCaptchaConfig()
        this.captchaEnabled = config.enabled
        this.captchaSitekey = config.sitekey
      } catch {
        // Proceed without captcha — graceful degradation
      } finally {
        this.captchaLoaded = true
      }
    },
  },
})
