import { ref, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { redirect } from '@/api'
import { authCquBindUrl } from '@/config/auth'
import { RouteNames } from '@/router'
import { useSession } from '@/stores/session'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import { parseApiError } from '@/utils/error'

export interface PersonalSetupController {
  preparing: Ref<boolean>
  error: Ref<string | null>
  startedThisVisit: Ref<boolean>
  begin: () => Promise<void>
}

export function usePersonalSetup(): PersonalSetupController {
  const route = useRoute()
  const router = useRouter()
  const session = useSession()
  const subscriptions = useSubscriptionsStore()
  const preparing = ref(false)
  const error = ref<string | null>(null)
  const startedThisVisit = ref(false)
  let inFlight: Promise<void> | null = null

  async function removeSetupQuery(goToDashboard = false) {
    const query = { ...route.query }
    delete query.setup
    await router.replace(goToDashboard
      ? { name: RouteNames.Dashboard, query, hash: route.hash }
      : { path: route.path, query, hash: route.hash })
  }

  async function runSetup() {
    error.value = null
    try {
      await session.load()
    } catch (cause) {
      error.value = parseApiError(cause, '暂时无法确认登录状态，请重试。')
      return
    }

    if (!session.can('sync')) {
      await removeSetupQuery()
      return
    }

    if (session.isCquUnbound) {
      redirect.fn(authCquBindUrl(window.location.origin + route.fullPath))
      return
    }

    preparing.value = true
    startedThisVisit.value = true
    try {
      const result = await api.ensureDefaultSubscriptions()
      await subscriptions.load(true)
      const newAddSetup = (result.status === 'created' || result.status === 'resumed')
        && route.name === RouteNames.Add
      await removeSetupQuery(newAddSetup)
    } catch (cause) {
      error.value = parseApiError(cause, '订阅准备未完成，请重试。')
    } finally {
      preparing.value = false
    }
  }

  function begin(): Promise<void> {
    if (route.query.setup !== '1') return Promise.resolve()
    if (inFlight) return inFlight
    const request = runSetup()
    inFlight = request
    const clear = () => {
      if (inFlight === request) inFlight = null
    }
    void request.then(clear, clear)
    return request
  }

  return {
    preparing,
    error,
    startedThisVisit,
    begin,
  }
}
