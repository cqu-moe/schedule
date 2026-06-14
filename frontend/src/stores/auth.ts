/**
 * @deprecated This store is a temporary FE-1 shim. It will be deleted in FE-2
 * when Dashboard/Add/RotateTokenDialog are rewritten for the v2 API.
 *
 * In v2, identity comes from the `useSession` store (cookie-based,
 * loaded via GET /api/v2/me). There is no longer a `token` or `logout()` —
 * account management goes through auth.cqu.moe.
 *
 * TODO(FE-2): delete this file once Dashboard.vue / Add.vue / RotateTokenDialog.vue
 * no longer import from @/stores/auth.
 */
import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useSession } from '@/stores/session'

export const useAuthStore = defineStore('auth', () => {
  const session = useSession()

  // token shim — always empty string in v2 (cookie auth, no bearer)
  const token = computed({
    get: () => '',
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    set: (_v: string) => { /* noop in v2 */ },
  })

  const isAuthenticated = computed(() => session.isAuthenticated.value)

  // userInfo shim — maps session.user into the old shape where possible
  const userInfo = computed(() => session.user.value)

  const loading = computed(() => session.loading.value)

  // logout: no-op in v2; account management is via auth.cqu.moe
  function logout() {
    // TODO(FE-2): remove — in v2 the user goes to https://auth.cqu.moe to log out
  }

  // fetchUserInfo: delegates to session.load()
  async function fetchUserInfo() {
    await session.load().catch(() => {})
  }

  return { token, isAuthenticated, userInfo, loading, logout, fetchUserInfo }
})
