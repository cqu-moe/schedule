import { useCallback, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import api, { redirect } from '@/api'
import { authCquBindUrl } from '@/config/auth'
import { parseApiError } from '@/utils/error'
import { useSession } from '@/providers/app'

export interface PersonalSetupController {
  preparing: boolean
  error: string | null
  startedThisVisit: boolean
  begin: () => Promise<void>
}

/**
 * Runs the ?setup=1 flow: confirm login/caps, ensure default subscriptions,
 * then strip the query parameter. Navigating to /dashboard reloads the page's
 * own subscription data, so no cross-page store refresh is needed.
 */
export function usePersonalSetup(): PersonalSetupController {
  const location = useLocation()
  const navigate = useNavigate()
  const session = useSession()
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [startedThisVisit, setStartedThisVisit] = useState(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const canNow = useRef(session.can)
  const unboundNow = useRef(session.isCquUnbound)
  canNow.current = session.can
  unboundNow.current = session.isCquUnbound

  const removeSetupQuery = useCallback(
    async (goToDashboard = false) => {
      const query = new URLSearchParams(location.search)
      query.delete('setup')
      const search = query.size ? `?${query.toString()}` : ''
      const target = goToDashboard
        ? `/dashboard${search}${location.hash}`
        : `${location.pathname}${search}${location.hash}`
      navigate(target, { replace: true })
    },
    [location.search, location.pathname, location.hash, navigate],
  )

  const runSetup = useCallback(async () => {
    setError(null)
    try {
      await session.reloadSession()
    } catch {
      setError('暂时无法确认登录状态，请重试。')
      return
    }

    if (!canNow.current('sync')) {
      await removeSetupQuery()
      return
    }

    if (unboundNow.current) {
      redirect.fn(
        authCquBindUrl(
          window.location.origin + location.pathname + location.search + location.hash,
        ),
      )
      return
    }

    setPreparing(true)
    setStartedThisVisit(true)
    try {
      const result = await api.ensureDefaultSubscriptions()
      const newAddSetup =
        (result.status === 'created' || result.status === 'resumed') &&
        location.pathname === '/add'
      await removeSetupQuery(newAddSetup)
    } catch (cause) {
      setError(parseApiError(cause, '订阅准备未完成，请重试。'))
    } finally {
      setPreparing(false)
    }
  }, [session, removeSetupQuery, location.pathname, location.search, location.hash])

  const begin = useCallback((): Promise<void> => {
    if (new URLSearchParams(location.search).get('setup') !== '1') {
      return Promise.resolve()
    }
    if (inFlight.current) return inFlight.current
    const request = runSetup()
    inFlight.current = request
    const clear = () => {
      if (inFlight.current === request) inFlight.current = null
    }
    void request.then(clear, clear)
    return request
  }, [location.search, runSetup])

  return { preparing, error, startedThisVisit, begin }
}
