import { ref, computed } from 'vue'
import { useConfigStore } from '@/stores/config'

export function useCaptcha() {
  const configStore = useConfigStore()
  const hcaptchaRef = ref<any>(null)

  async function getCaptchaToken(): Promise<string | null> {
    if (!configStore.captchaEnabled || !hcaptchaRef.value) return null
    const { response } = await hcaptchaRef.value.executeAsync()
    return response
  }

  return {
    hcaptchaRef,
    captchaEnabled: computed(() => configStore.captchaEnabled),
    captchaSitekey: computed(() => configStore.captchaSitekey),
    getCaptchaToken,
  }
}
