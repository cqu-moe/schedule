import { useCallback, useState } from 'react'
import api from '@/api'
import type {
  CalendarLink,
  PersonalSetupSummary,
  Subscription,
} from '@/types/api'
import { useSession } from '@/providers/app'

export interface SubscriptionsState {
  subscriptions: Subscription[]
  personalSetup: PersonalSetupSummary | null
  count: number
  /** True when the user reached their subscription cap; null sub_limit = unlimited. */
  atLimit: boolean
  /** Total non-default (share) links across ALL subscriptions. */
  shareLinkCount: number
  /** True when the user reached their share link cap; null share_limit = unlimited. */
  atShareLimit: boolean
  load: (noCache?: boolean) => Promise<void>
  reset: () => void
}

/** Default CalendarLink for a subscription, or undefined if none exists. */
export function defaultLink(sub: Subscription): CalendarLink | undefined {
  return sub.links.find((l) => l.is_default)
}

export function useSubscriptions(): SubscriptionsState {
  const { quota } = useSession()
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [personalSetup, setPersonalSetup] = useState<PersonalSetupSummary | null>(null)

  const load = useCallback(async (noCache = false) => {
    const data = await api.getSubscriptions(noCache)
    setSubscriptions(data.subscriptions)
    setPersonalSetup(data.personal_setup ?? null)
  }, [])

  const reset = useCallback(() => {
    setSubscriptions([])
    setPersonalSetup(null)
  }, [])

  const count = subscriptions.length
  const creationCount = subscriptions.filter(sub => sub.source_version === 1).length
  const subLimit = quota('sub_limit')
  const shareLimit = quota('share_limit')
  const shareLinkCount = subscriptions.reduce(
    (sum, sub) => sum + sub.links.filter((l) => !l.is_default).length,
    0,
  )

  return {
    subscriptions,
    personalSetup,
    count,
    atLimit: subLimit !== null && creationCount >= subLimit,
    shareLinkCount,
    atShareLimit: shareLimit !== null && shareLinkCount >= shareLimit,
    load,
    reset,
  }
}

