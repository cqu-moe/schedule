import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'
import type { SessionUser, CalendarCaps } from '@/types/api'

export const useSession = defineStore('session', () => {
  const user = ref<SessionUser | null>(null)
  const caps = ref<CalendarCaps | null>(null)
  const loaded = ref(false)
  const loading = ref(false)

  // ── Getters ────────────────────────────────────────────────────────────────

  const isAuthenticated = computed(() => !!user.value)

  function can(flag: 'sync' | 'external' | 'share'): boolean {
    return !!caps.value?.[flag]
  }

  function quota(
    key: 'sub_limit' | 'share_limit' | 'sync_interval' | 'manual_refresh',
  ): number | null {
    return caps.value?.[key] ?? null
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      const data = await api.getMe()
      user.value = data.user
      caps.value = data.caps.calendar
      loaded.value = true
    } finally {
      loading.value = false
    }
    // On 401, the axios interceptor redirects to auth.cqu.moe/login — the
    // rejection propagates here. Callers may catch if they need to react;
    // but in most cases we just let it reject (page redirects away anyway).
  }

  // Composition API stores don't auto-generate $reset() — implement manually.
  function $reset(): void {
    user.value = null
    caps.value = null
    loaded.value = false
    loading.value = false
  }

  return {
    user,
    caps,
    loaded,
    loading,
    isAuthenticated,
    can,
    quota,
    load,
    $reset,
  }
})
