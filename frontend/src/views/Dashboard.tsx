import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  ActionButton,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  PageHeader,
  PageState,
  Switch,
  toast,
} from '@cqu-moe/ui'
import {
  CalendarDays,
  BookOpen,
  Plus,
  Download,
  Ellipsis,
  ExternalLink,
  Loader2,
  QrCode,
  Share2,
  Trash2,
} from 'lucide-react'
import api from '@/api'
import { AUTH_BASE_URL, authCquBindUrl } from '@/config/auth'
import FirstSyncNotice from '@/components/FirstSyncNotice'
import SyncActionButton from '@/components/SyncActionButton'
const QrcodeModal = lazy(() => import('@/components/QrcodeModal'))
const ShareLinksDialog = lazy(() => import('@/components/ShareLinksDialog'))
import { useButtonFeedback, type ButtonState } from '@/hooks/useButtonFeedback'
import { usePersonalSetup } from '@/hooks/usePersonalSetup'
import { defaultLink } from '@/hooks/useSubscriptions'
import { deriveFirstSyncPhase } from '@/lib/first-sync-state'
import { captureScheduleEvent } from '@/lib/posthog'
import { useSession } from '@/providers/app'
import type {
  CalendarLink,
  ExternalSourceType,
  CalendarCaps,
  PersonalSetupSummary,
  SourceType,
  Subscription,
  SubscriptionList,
} from '@/types/api'
import { parseApiError } from '@/utils/error'
import { buildLinkUrl } from '@/utils/links'
import './dashboard.css'

// ── Constants & helpers ───────────────────────────────────────────────────────

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  personal_all: '全部',
  personal_courses: '课程',
  personal_exams: '考试',
  instructor: '教师',
  room: '教室',
  laboratory: '实验室',
  course: '课程',
  admin_class: '行政班',
}

const DOWNLOAD_LABELS = {
  ics: 'ICS 文件',
  data_json: '课表 JSON',
  origin_json: '原始 JSON',
  csv: 'CSV',
} as const

const POLL_INTERVAL = 3000
const RATE_LIMIT_POLL_INTERVAL = 5000
const RATE_LIMIT_BACKOFF_WINDOW = 60_000
const POLL_TIMEOUT = 30_000
const POLL_ACTIVE_TIMEOUT = 15 * 60_000
// Mirrors the backend's active-run limit, including the hourly dispatch window.
const POLL_QUEUED_TIMEOUT = 2 * 60 * 60_000
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60_000

function sourceTypeLabel(type: SourceType): string {
  return SOURCE_TYPE_LABELS[type] || type
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
}

function cooldownLabel(seconds: number): string {
  return `${Math.ceil(seconds / 60)} 分钟后可同步`
}

function externalSyncIntervalLabel(caps: CalendarCaps | null): string {
  if (!caps) return '外部自动同步状态未知'
  if (!caps.external) return '外部自动同步需先开通外部订阅'
  if (caps.external_sync_interval === undefined) return '外部自动同步未授予'
  if (caps.external_sync_interval === 0) return '外部自动同步已关闭'
  return `外部自动同步每 ${caps.external_sync_interval} 分钟`
}

function externalManualRefreshLabel(
  caps: CalendarCaps | null,
  remaining: number | null | undefined,
): string {
  if (!caps) return '外部手动刷新状态未知'
  if (!caps.external) return '外部手动刷新需先开通外部订阅'
  if (caps.external_manual_refresh === undefined) return '外部手动刷新未授予'
  if (caps.external_manual_refresh === 0) return '外部手动刷新已关闭'
  if (remaining === undefined) return '外部手动刷新剩余未知'
  if (remaining === null) return '外部手动刷新剩余无限'
  return `外部手动刷新剩余 ${remaining} 次`
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    (error as { response?: { status?: number } }).response?.status === 429
  )
}

function captureAction(
  operation: string,
  outcome: 'success' | 'failure' | 'unverified',
  properties: Record<string, unknown> = {},
): void {
  captureScheduleEvent('schedule_action_finished', {
    actor_type: 'user',
    trigger: 'user',
    operation,
    outcome,
    ...properties,
  })
}

/**
 * Tracks the exact backend run returned by POST /syncs. Keeping the run id
 * prevents an older queue delivery from being mistaken for this refresh.
 */
interface PendingRefresh {
  runId: string | null
  oldSyncedAt: string | null
  startedAt: number
  unconfirmedSince: number | null
  runningSince: number | null
  failureSince: number | null
}

interface EnrichedSub {
  sub: Subscription
  defaultLink: CalendarLink | undefined
}

interface SubscriptionsData {
  subscriptions: Subscription[]
  personalSetup: PersonalSetupSummary | null
  manualRemaining?: number | null
}

export default function Dashboard() {
  const session = useSession()
  const location = useLocation()
  const {
    preparing,
    error: preparationError,
    startedThisVisit,
    begin: beginPersonalSetup,
  } = usePersonalSetup()

  // ── Data (owned here so post-load reads are never stale) ──────────────────

  const dataRef = useRef<SubscriptionsData>({ subscriptions: [], personalSetup: null })
  const [data, setData] = useState<SubscriptionsData>(dataRef.current)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const subscriptionLoadPromiseRef = useRef<Promise<SubscriptionList> | null>(null)

  const loadSubscriptions = (noCache = false): Promise<SubscriptionList> => {
    if (subscriptionLoadPromiseRef.current) return subscriptionLoadPromiseRef.current
    const request = (async () => {
      const result = await api.getSubscriptions(noCache)
      const next: SubscriptionsData = {
        subscriptions: result.subscriptions,
        personalSetup: result.personal_setup ?? null,
        manualRemaining: result.manual_remaining,
      }
      dataRef.current = next
      setData(next)
      return result
    })()
    subscriptionLoadPromiseRef.current = request
    const clear = () => {
      if (subscriptionLoadPromiseRef.current === request) {
        subscriptionLoadPromiseRef.current = null
      }
    }
    void request.then(clear, clear)
    return request
  }

  // ── UI state ────────────────────────────────────────────────────────────────

  const [notificationEnabled, setNotificationEnabled] = useState(false)
  const [notificationLoading, setNotificationLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [qrModal, setQrModal] = useState<{ open: boolean; url: string; token: string }>({
    open: false,
    url: '',
    token: '',
  })
  const deletingRef = useRef(false)
  const [deleting, setDeleting] = useState(false)
  const qrTriggerRef = useRef<HTMLElement | null>(null)
  const menuTriggersRef = useRef(new Map<string, HTMLButtonElement>())
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareSubId, setShareSubId] = useState<string | null>(null)
  const [firstSyncDismissed, setFirstSyncDismissed] = useState(false)
  const [cooldownClock, setCooldownClock] = useState(() => Date.now())

  // Mutable sync-tracking records; forceRender re-renders after mutations.
  const pendingRefreshRef = useRef<Record<string, PendingRefresh>>({})
  const localSyncErrorsRef = useRef<Record<string, string>>({})
  const localCooldownUntilRef = useRef<Record<string, number>>({})
  const [, forceRender] = useReducer((x: number) => x + 1, 0)

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollingActiveRef = useRef(false)
  const rateLimitedUntilRef = useRef(0)
  const setupDispatchPromiseRef = useRef<Promise<void> | null>(null)
  const returnLoadPromiseRef = useRef<Promise<void> | null>(null)

  const refreshFeedback = useButtonFeedback()
  const syncFeedback = useButtonFeedback()
  const copyFeedback = useButtonFeedback()

  // ── Polling ─────────────────────────────────────────────────────────────────

  function stopPolling() {
    pollingActiveRef.current = false
    rateLimitedUntilRef.current = 0
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  function scheduleNextPoll(delay?: number) {
    if (!pollingActiveRef.current || pollTimerRef.current) return
    const nextDelay =
      delay ?? (Date.now() < rateLimitedUntilRef.current ? RATE_LIMIT_POLL_INTERVAL : POLL_INTERVAL)
    pollTimerRef.current = setTimeout(runSyncPoll, nextDelay)
  }

  function recoverPendingSetupDispatch(): Promise<void> {
    const setup = dataRef.current.personalSetup
    if (
      setup?.status !== 'created' ||
      (setup.dispatch_status !== 'pending' && setup.dispatch_status !== 'sending')
    ) {
      return Promise.resolve()
    }
    if (setupDispatchPromiseRef.current) return setupDispatchPromiseRef.current

    const request = (async () => {
      try {
        await api.ensureDefaultSubscriptions()
      } catch (error) {
        if (isRateLimitError(error)) {
          rateLimitedUntilRef.current = Math.max(
            rateLimitedUntilRef.current,
            Date.now() + RATE_LIMIT_BACKOFF_WINDOW,
          )
        }
      }
    })()
    setupDispatchPromiseRef.current = request
    const clear = () => {
      if (setupDispatchPromiseRef.current === request) setupDispatchPromiseRef.current = null
    }
    void request.then(clear, clear)
    return request
  }

  /** Fail selected pending refreshes so no subscription stays "同步中" forever. */
  function failPendingRefreshes(message: string, ids = Object.keys(pendingRefreshRef.current)) {
    for (const id of ids) {
      localSyncErrorsRef.current[id] = message
      delete pendingRefreshRef.current[id]
    }
    if (ids.length > 0) toast.error(message)
    forceRender()
  }

  async function runSyncPoll() {
    pollTimerRef.current = null
    try {
      await recoverPendingSetupDispatch()
      await loadSubscriptions(true)
    } catch (error) {
      if (pollingActiveRef.current) {
        const rateLimited = isRateLimitError(error)
        if (rateLimited) {
          rateLimitedUntilRef.current = Math.max(
            rateLimitedUntilRef.current,
            Date.now() + RATE_LIMIT_BACKOFF_WINDOW,
          )
        }
        const now = Date.now()
        const timedOutIds: string[] = []
        for (const [id, pending] of Object.entries(pendingRefreshRef.current)) {
          pending.failureSince ??= now
          if (
            now - pending.failureSince >= POLL_ACTIVE_TIMEOUT ||
            (pending.unconfirmedSince !== null && now - pending.unconfirmedSince >= POLL_TIMEOUT)
          ) {
            timedOutIds.push(id)
          }
        }
        failPendingRefreshes('同步超时，请稍后重试', timedOutIds)
        if (Object.keys(pendingRefreshRef.current).length === 0) stopPolling()
        else scheduleNextPoll(rateLimited ? undefined : RATE_LIMIT_POLL_INTERVAL)
      }
      return
    }

    if (!pollingActiveRef.current) return
    reconcilePendingRefreshes()
  }

  function reconcilePendingRefreshes() {
    const now = Date.now()
    const timedOutIds: string[] = []

    for (const [id, pending] of Object.entries(pendingRefreshRef.current)) {
      pending.failureSince = null
      const sub = dataRef.current.subscriptions.find((s) => s.id === id)
      if (!sub) {
        delete pendingRefreshRef.current[id]
        continue
      }
      const isSameRun = !pending.runId || sub.sync_run_id === pending.runId
      if (isSameRun && sub.sync_status === 'error') {
        const message = sub.sync_error_message || '同步失败，请稍后重试'
        localSyncErrorsRef.current[id] = message
        toast.error(message)
        delete pendingRefreshRef.current[id]
        continue
      }
      const legacyTimestampChanged = !pending.runId && sub.last_synced_at !== pending.oldSyncedAt
      if ((isSameRun && sub.sync_status === 'success') || legacyTimestampChanged) {
        delete localSyncErrorsRef.current[id]
        toast.success('同步完成')
        delete pendingRefreshRef.current[id]
        continue
      }

      if (isSameRun && sub.sync_status === 'queued') {
        pending.unconfirmedSince = null
        pending.runningSince = null
        const requestedAt = Date.parse(sub.sync_requested_at ?? '')
        const queuedSince =
          Number.isFinite(requestedAt) && requestedAt <= now ? requestedAt : pending.startedAt
        if (now - queuedSince >= POLL_QUEUED_TIMEOUT) timedOutIds.push(id)
        continue
      }
      if (isSameRun && sub.sync_status === 'running') {
        pending.unconfirmedSince = null
        const startedAt = Date.parse(sub.sync_started_at ?? '')
        if (Number.isFinite(startedAt) && startedAt <= now) pending.runningSince = startedAt
        else pending.runningSince ??= now
        if (now - pending.runningSince >= POLL_ACTIVE_TIMEOUT) timedOutIds.push(id)
        continue
      }

      pending.unconfirmedSince ??= now
      if (now - pending.unconfirmedSince >= POLL_TIMEOUT) timedOutIds.push(id)
    }

    failPendingRefreshes('同步超时，请稍后重试', timedOutIds)

    if (Object.keys(pendingRefreshRef.current).length === 0) stopPolling()
    else scheduleNextPoll()
    forceRender()
  }

  function startSyncPolling() {
    if (pollingActiveRef.current) return
    pollingActiveRef.current = true
    rateLimitedUntilRef.current = 0
    scheduleNextPoll()
  }

  /** Track sub ids as pending-refresh, capturing current last_synced_at values. */
  function trackRefresh(runs: Array<{ id: string; runId: string | null }>) {
    const startedAt = Date.now()
    for (const { id, runId } of runs) {
      const sub = dataRef.current.subscriptions.find((s) => s.id === id)
      delete localSyncErrorsRef.current[id]
      pendingRefreshRef.current[id] = {
        runId,
        oldSyncedAt: sub?.last_synced_at ?? null,
        startedAt,
        unconfirmedSince: null,
        runningSince: null,
        failureSince: null,
      }
    }
    forceRender()
    startSyncPolling()
  }

  function trackCurrentActiveRuns() {
    const activeRuns = dataRef.current.subscriptions
      .filter(
        (sub) =>
          (sub.sync_status === 'queued' || sub.sync_status === 'running') &&
          !(sub.id in pendingRefreshRef.current),
      )
      .map((sub) => ({ id: sub.id, runId: sub.sync_run_id }))
    if (activeRuns.length > 0) trackRefresh(activeRuns)
  }

  // ── First-sync notice ───────────────────────────────────────────────────────

  const firstSyncDismissKey = useMemo(() => {
    const userId = session.user?.id
    const runId = data.personalSetup?.run_id
    return userId && runId ? `first-sync-dismissed:${userId}:${runId}` : null
  }, [session.user?.id, data.personalSetup?.run_id])

  useEffect(() => {
    if (!firstSyncDismissKey) {
      setFirstSyncDismissed(false)
      return
    }
    try {
      setFirstSyncDismissed(sessionStorage.getItem(firstSyncDismissKey) === '1')
    } catch {
      setFirstSyncDismissed(false)
    }
  }, [firstSyncDismissKey])

  function dismissFirstSync() {
    setFirstSyncDismissed(true)
    if (!firstSyncDismissKey) return
    try {
      sessionStorage.setItem(firstSyncDismissKey, '1')
    } catch {
      // Dismissal remains page-local when storage is unavailable.
    }
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  const subscriptions = data.subscriptions
  const count = subscriptions.length
  const creationCount = subscriptions.filter(sub => sub.source_version === 1).length
  const subLimit = session.quota('sub_limit')
  const atLimit = subLimit !== null && creationCount >= subLimit
  const shareLimit = session.quota('share_limit')
  const shareLinkCount = subscriptions.reduce(
    (sum, sub) => sum + sub.links.filter((l) => !l.is_default).length,
    0,
  )
  const atShareLimit = shareLimit !== null && shareLinkCount >= shareLimit
  const personalSubs = subscriptions.filter((s) => s.is_personal)
  const canManualRefresh = session.quota('manual_refresh') !== 0
  const externalManualRemaining = data.manualRemaining
  const externalManualGrant = session.caps?.external_manual_refresh
  const canChangeNotification = session.can('change_notification')

  const firstSyncTargetIds =
    data.personalSetup?.status === 'created' ? data.personalSetup.subscription_ids : []
  const pendingIds = new Set(Object.keys(pendingRefreshRef.current))
  const hasUnfinishedFirstSync =
    firstSyncTargetIds.length > 0 &&
    subscriptions.some((sub) => firstSyncTargetIds.includes(sub.id) && !sub.last_synced_at)
  const firstSyncContext = startedThisVisit || hasUnfinishedFirstSync
  const firstSyncPhase = deriveFirstSyncPhase({
    subscriptions,
    targetIds: firstSyncTargetIds,
    pendingIds,
    localErrors: localSyncErrorsRef.current,
    preparing,
    preparationError,
  })
  const showFirstSyncNotice = !firstSyncDismissed && firstSyncContext && firstSyncPhase !== null

  function isFirstSyncCard(sub: Subscription): boolean {
    return (sub.source_version === 1 && !sub.last_synced_at) || (firstSyncContext && firstSyncTargetIds.includes(sub.id))
  }

  function firstSyncLinkUnavailable(sub: Subscription): boolean {
    return sub.is_active === false || (sub.source_version === 1 && sub.external_state !== undefined && sub.external_state !== 'active') || (isFirstSyncCard(sub) && !sub.last_synced_at)
  }

  function refreshCooldownSeconds(sub: Subscription): number {
    const persistedUntil = sub.manual_refresh_at
      ? Date.parse(sub.manual_refresh_at) + MANUAL_REFRESH_COOLDOWN_MS
      : 0
    const until = Math.max(persistedUntil, localCooldownUntilRef.current[sub.id] ?? 0)
    return Math.max(0, Math.ceil((until - cooldownClock) / 1000))
  }

  function isRefreshCoolingDown(sub: Subscription): boolean {
    return refreshCooldownSeconds(sub) > 0
  }

  const hasActiveCooldown = subscriptions.some(isRefreshCoolingDown)
  useEffect(() => {
    if (!hasActiveCooldown) return
    const timer = window.setInterval(() => setCooldownClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActiveCooldown])

  function isNewExternal(sub: Subscription): boolean {
    return !sub.is_personal && sub.source_version === 1
  }

  function canRefreshSub(sub: Subscription): boolean {
    if (sub.is_personal) return canManualRefresh
    if (!isNewExternal(sub)) return false
    return session.can('external') &&
      session.externalAvailability.create_types.includes(sub.source_type as ExternalSourceType) &&
      externalManualGrant !== undefined &&
      externalManualGrant !== 0 &&
      sub.is_active &&
      sub.external_state === 'active' &&
      externalManualRemaining !== undefined &&
      externalManualRemaining !== 0
  }

  function refreshIdleLabel(sub: Subscription): string {
    if (refreshCooldownSeconds(sub) > 0) return cooldownLabel(refreshCooldownSeconds(sub))
    if (sub.is_personal) return '同步'
    if (!isNewExternal(sub)) return '暂不可用'
    if (!session.can('external')) return '外部订阅未开通'
    if (!session.externalAvailability.create_types.includes(sub.source_type as ExternalSourceType)) return '暂不可用'
    if (externalManualGrant === undefined) return '外部手动刷新未授予'
    if (externalManualGrant === 0) return '外部手动刷新已关闭'
    if (!sub.is_active || sub.external_state !== 'active') return '暂不可用'
    if (externalManualRemaining === undefined) return '外部手动刷新剩余未知'
    if (externalManualRemaining === 0) return '今日额度已用完'
    return '同步'
  }

  function isSubSyncing(sub: Subscription): boolean {
    return (
      sub.id in pendingRefreshRef.current ||
      (!localSyncErrorsRef.current[sub.id] &&
        (sub.sync_status === 'queued' || sub.sync_status === 'running'))
    )
  }

  function syncErrorMessage(sub: Subscription): string | null {
    if (sub.id in pendingRefreshRef.current) return null
    return (
      localSyncErrorsRef.current[sub.id] ??
      (sub.sync_status === 'error' ? sub.sync_error_message : null)
    )
  }

  function syncProgressLabel(sub: Subscription): string {
    if (sub.external_state === 'reselecting') return '重新同步中…'
    if (isFirstSyncCard(sub)) return '首次同步中…'
    return sub.sync_status === 'queued' && Boolean(sub.sync_error_code)
      ? '同步遇到临时故障，正在自动重试…'
      : '同步中…'
  }

  function refreshButtonState(sub: Subscription): ButtonState {
    if (syncErrorMessage(sub)) return 'error'
    if (isSubSyncing(sub)) return 'loading'
    return refreshFeedback.stateOf(sub.id)
  }

  const syncAllCooldownSeconds = personalSubs.reduce(
    (remaining, sub) => Math.max(remaining, refreshCooldownSeconds(sub)),
    0,
  )

  const syncAllButtonState: ButtonState = (() => {
    if (personalSubs.some(isSubSyncing)) return 'loading'
    if (firstSyncContext && firstSyncPhase === 'error') return syncFeedback.stateOf()
    if (personalSubs.some((sub) => Boolean(syncErrorMessage(sub)))) return 'error'
    return syncFeedback.stateOf()
  })()

  const firstSyncRetryDisabled = preparationError
    ? preparing
    : !canManualRefresh ||
      syncAllCooldownSeconds > 0 ||
      firstSyncTargetIds.some((id) => id in pendingRefreshRef.current)

  const firstSyncRetryHint = preparationError
    ? preparing
      ? '正在重试'
      : ''
    : !canManualRefresh
      ? '今日手动刷新次数已达上限'
      : syncAllCooldownSeconds > 0
        ? cooldownLabel(syncAllCooldownSeconds)
        : firstSyncTargetIds.some((id) => id in pendingRefreshRef.current)
          ? '同步正在进行'
          : ''

  const enrichedSubs: EnrichedSub[] = subscriptions.map((sub) => ({
    sub,
    defaultLink: defaultLink(sub),
  }))

  // Store-derived so the reference updates after load() replaces objects.
  const activeShareSub = shareSubId
    ? (subscriptions.find((s) => s.id === shareSubId) ?? null)
    : null

  const currentUrl = window.location.origin + location.pathname + location.search + location.hash
  const bindHref = useMemo(() => authCquBindUrl(currentUrl), [currentUrl])
  const repairBindHref = useMemo(() => authCquBindUrl(currentUrl, { repair: true }), [currentUrl])

  // ── Actions ─────────────────────────────────────────────────────────────────

  function openDeleteSubDialog(sub: Subscription) {
    if (sub.is_personal) return
    dialogTriggerRef.current = menuTriggersRef.current.get(sub.id) ?? null
    setDeleteTarget({ id: sub.id, name: sub.source_name })
  }

  function openShareLinks(sub: Subscription) {
    dialogTriggerRef.current = menuTriggersRef.current.get(sub.id) ?? null
    setShareSubId(sub.id)
    setShareOpen(true)
  }

  function restoreDialogFocus(event: Event) {
    event.preventDefault()
    const trigger = dialogTriggerRef.current
    if (trigger?.isConnected) trigger.focus()
    else document.getElementById('main-content')?.focus()
    dialogTriggerRef.current = null
  }

  async function handleCopyIcs(item: EnrichedSub) {
    if (!item.defaultLink || firstSyncLinkUnavailable(item.sub)) return
    const url = buildLinkUrl(session.publicUrl, item.defaultLink.token, 'ics')
    try {
      await copyFeedback.run(async () => {
        await navigator.clipboard.writeText(url)
      }, item.sub.id)
      captureAction('copy_calendar_link', 'success', { format: 'ics' })
    } catch {
      captureAction('copy_calendar_link', 'failure', { format: 'ics' })
      toast.error('复制失败，请手动复制链接')
    }
  }

  function openQrModal(item: EnrichedSub) {
    if (!item.defaultLink || firstSyncLinkUnavailable(item.sub)) return
    qrTriggerRef.current = document.activeElement as HTMLElement
    setQrModal({
      open: true,
      url: buildLinkUrl(session.publicUrl, item.defaultLink.token, 'ics'),
      token: item.defaultLink.token,
    })
    captureAction('show_calendar_qr_code', 'success', { format: 'ics' })
  }

  async function handleRefreshSub(sid: string) {
    const sub = dataRef.current.subscriptions.find((item) => item.id === sid)
    if (!sub) return
    try {
      await refreshFeedback.run(async () => {
        const result = sub.is_personal
          ? await api.refreshPersonalSubscription()
          : await api.refreshSubscription(sid)
        toast.success('已加入刷新队列')
        if (isNewExternal(sub) && result.manual_remaining !== undefined) {
          const next = { ...dataRef.current, manualRemaining: result.manual_remaining }
          dataRef.current = next
          setData(next)
        }
        const affectedIds = result.affected_subscription_ids?.length
          ? result.affected_subscription_ids
          : [sid]
        const cooldownUntil =
          Date.parse(result.cooldown_until ?? '') || Date.now() + MANUAL_REFRESH_COOLDOWN_MS
        for (const id of affectedIds) localCooldownUntilRef.current[id] = cooldownUntil
        forceRender()
        trackRefresh(affectedIds.map((id) => ({ id, runId: result.run_id })))
      }, sid)
    } catch (error) {
      toast.error(parseApiError(error, '刷新失败'))
      if (isNewExternal(sub)) await loadSubscriptions(true).catch(() => {})
    }
  }

  async function handleDeleteSub(sid: string) {
    const sub = dataRef.current.subscriptions.find((item) => item.id === sid)
    if (!sub || sub.is_personal || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    try {
      await api.deleteSubscription(sid)
      dialogTriggerRef.current = null
      toast.success('订阅已删除')
      setDeleteTarget(null)
      await loadSubscriptions(true).catch(() => {})
    } catch (error) {
      toast.error(parseApiError(error, '删除订阅失败'))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  async function handleSyncAll() {
    const subsNow = dataRef.current.subscriptions.filter((s) => s.is_personal)
    if (subsNow.length === 0) return
    try {
      await syncFeedback.run(async () => {
        const result = await api.refreshPersonalSubscription()
        const affectedIds = result.affected_subscription_ids?.length
          ? result.affected_subscription_ids
          : subsNow.map((sub) => sub.id)
        const cooldownUntil =
          Date.parse(result.cooldown_until ?? '') || Date.now() + MANUAL_REFRESH_COOLDOWN_MS
        for (const id of affectedIds) localCooldownUntilRef.current[id] = cooldownUntil
        forceRender()
        trackRefresh(affectedIds.map((id) => ({ id, runId: result.run_id })))
        await loadSubscriptions(true).catch(() => {})
      })
    } catch (error) {
      toast.error(parseApiError(error, '同步失败'))
    }
  }

  async function retryFirstSync() {
    if (preparationError) {
      await beginPersonalSetup()
      await loadSubscriptions(true).catch(() => {})
      trackCurrentActiveRuns()
      return
    }
    await handleSyncAll()
  }

  async function toggleNotification() {
    if (notificationLoading) return
    const next = !notificationEnabled
    setNotificationLoading(true)
    try {
      const settings = await api.updateNotificationSettings(next)
      setNotificationEnabled(settings.enabled)
      captureAction('change_notification', 'success')
    } catch {
      captureAction('change_notification', 'failure')
      toast.error('保存通知设置失败')
    } finally {
      setNotificationLoading(false)
    }
  }

  async function reloadAfterError() {
    setLoadError(false)
    setLoading(true)
    try {
      await loadSubscriptions(true)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  function refreshFromReturn(): Promise<void> {
    if (returnLoadPromiseRef.current) return returnLoadPromiseRef.current
    const request = (async () => {
      await session.reloadSession()
      await loadSubscriptions(true)
      for (const sub of dataRef.current.subscriptions) {
        if (
          !(sub.id in pendingRefreshRef.current) &&
          (sub.sync_status === 'success' || sub.sync_status === 'error')
        ) {
          delete localSyncErrorsRef.current[sub.id]
        }
      }
      trackCurrentActiveRuns()
      reconcilePendingRefreshes()
    })()
    returnLoadPromiseRef.current = request
    const clear = () => {
      if (returnLoadPromiseRef.current === request) returnLoadPromiseRef.current = null
    }
    void request.then(clear, clear)
    return request
  }

  useEffect(() => {
    const handleWindowFocus = () => {
      void refreshFromReturn().catch(() => undefined)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') handleWindowFocus()
    }
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void refreshFromReturn().catch(() => undefined)
    }
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('pageshow', handlePageShow)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    void (async () => {
      try {
        const setupRequested = new URLSearchParams(location.search).get('setup') === '1'
        if (setupRequested) {
          // usePersonalSetup only ensures defaults; the page loads its own list.
          await beginPersonalSetup()
        }
        await loadSubscriptions()
      } catch {
        setLoadError(true)
      } finally {
        setLoading(false)
        trackCurrentActiveRuns()
      }
    })()

    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('pageshow', handlePageShow)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!canChangeNotification) return
    let active = true
    setNotificationLoading(true)
    api
      .getNotificationSettings()
      .then((settings) => {
        if (active) setNotificationEnabled(settings.enabled)
      })
      .catch(() => {
        // Keep the switch usable with its default value on load failure.
      })
      .finally(() => {
        if (active) setNotificationLoading(false)
      })
    return () => {
      active = false
    }
  }, [canChangeNotification, session.user?.id])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="我的订阅"
        description="管理课程与考试订阅，让日历跟上你的安排。"
        actions={
          <div className="dash-header-actions">
            <SyncActionButton
              state={syncAllButtonState}
              labels={{
                idle: syncAllCooldownSeconds > 0
                  ? cooldownLabel(syncAllCooldownSeconds)
                  : '同步个人课表',
                loading: '同步中…',
                success: '已同步',
                error: '同步失败，重试',
              }}
              disabled={
                personalSubs.length === 0 ||
                !canManualRefresh ||
                syncAllCooldownSeconds > 0
              }
              onClick={() => void handleSyncAll()}
            />
            {atLimit ? (
              <Button variant="outline" size="default" disabled title="已达外部订阅上限">
                添加订阅
              </Button>
            ) : (
              <Button asChild size="default">
                <Link to="/add">
                  <Plus aria-hidden="true" />
                  添加订阅
                </Link>
              </Button>
            )}
          </div>
        }
      />

      <div className="dash-meta">
        <p className="dash-count">
          {loading
            ? '正在读取订阅'
            : loadError
              ? '订阅状态暂不可用'
              : `${count} 个订阅`}
        </p>
        {!loading && !loadError && <p className="dash-sync-status">
          外部订阅额度 {creationCount} / {subLimit ?? '无限'}
        </p>}
        <p className={session.can('sync') ? 'dash-sync-status is-on' : 'dash-sync-status'}>
          <span className="dash-status-dot" aria-hidden="true" />
          {session.can('sync') ? '自动同步已开启' : '自动同步未开通'}
        </p>
        <p className={session.can('external') ? 'dash-sync-status is-on' : 'dash-sync-status'}>
          <span className="dash-status-dot" aria-hidden="true" />
          {session.can('external') ? '外部订阅已开通' : '外部订阅未开通'}
        </p>
        <p className="dash-sync-status">
          <span className="dash-status-dot" aria-hidden="true" />
          {externalSyncIntervalLabel(session.caps)}
        </p>
        <p className="dash-sync-status">
          <span className="dash-status-dot" aria-hidden="true" />
          {externalManualRefreshLabel(session.caps, externalManualRemaining)}
        </p>
        {atLimit && <p className="dash-limit-note">已达外部订阅上限</p>}
      </div>

      {loading ? (
        <PageState state="loading" title="正在加载订阅" description="正在获取订阅列表，请稍候。" />
      ) : loadError ? (
        <PageState
          state="error"
          title="暂时无法加载订阅"
          description="请重试；问题持续时请稍后再试。"
          action={
            <Button variant="outline" onClick={() => void reloadAfterError()}>
              重新加载
            </Button>
          }
        />
      ) : (
        <>
          {showFirstSyncNotice && firstSyncPhase && (
            <FirstSyncNotice
              phase={firstSyncPhase}
              preparationFailed={Boolean(preparationError)}
              errorMessage={preparationError ?? ''}
              retryDisabled={firstSyncRetryDisabled}
              retryHint={firstSyncRetryHint}
              onRetry={() => void retryFirstSync()}
              onDismiss={dismissFirstSync}
            />
          )}

          {!loading && session.isCquUnbound && (
            <div className="dash-card dash-bind-card">
              <p className="dash-bind-title">
                {session.cquBindStatus === 'deleting'
                  ? '统一认证账号正在解绑'
                  : '尚未绑定重庆大学统一认证账号'}
              </p>
              <p className="dash-sync-meta">
                {session.cquBindStatus === 'deleting'
                  ? '清理完成前无法同步个人课表，请在认证中心查看解绑进度。'
                  : '个人课表同步依赖你的统一认证账号，绑定后即可继续。'}
              </p>
              <Button asChild variant="outline" size="default">
                <a
                  href={
                    session.cquBindStatus === 'deleting'
                      ? `${AUTH_BASE_URL}/settings/cqu`
                      : bindHref
                  }
                >
                  {session.cquBindStatus === 'deleting'
                    ? '查看解绑进度'
                    : '绑定重庆大学统一认证账号'}
                </a>
              </Button>
            </div>
          )}

          <div className="dash-section-heading">
            <h2>课表订阅</h2>
            <Link to="/api-docs#subscribe">
              <BookOpen size={16} aria-hidden="true" />
              如何订阅到日历
            </Link>
          </div>
          <ul className="dash-list" aria-label="课表订阅">
            {enrichedSubs.map(({ sub, defaultLink: link }) => (
              <li className={sub.source_version === 1 ? 'dash-card dash-external-card' : 'dash-card'} key={sub.id}>
                <div className="dash-card-info">
                  <div className="dash-card-title">
                    <CalendarDays size={20} aria-hidden="true" />
                    <span className="dash-badge">{sourceTypeLabel(sub.source_type)}</span>
                    <h3 className="dash-card-name">{sub.source_name}</h3>
                  </div>
                  <div className="dash-card-sub">
                    {sub.session_name && (
                      <span className="dash-semester">{sub.session_name}</span>
                    )}
                    {sub.external_state === 'reselecting' && <span className="dash-sync-meta">原链接地址保留，同步成功前保持停用</span>}
                    {sub.external_state !== 'reselecting' && sub.import_quality === 'partial' && <span className="dash-sync-error">部分内容未导入（{sub.skipped_count ?? 0} 项）</span>}
                    {sub.external_state !== 'reselecting' && sub.import_quality === 'empty' && <span className="dash-sync-meta">当前学期暂无课表安排</span>}
                    {syncErrorMessage(sub) ? (
                      <>
                        <span className="dash-sync-error">
                          {sub.external_state === 'expired' ? '教学班已过期' : '同步失败'}{sub.source_version === 1 || !isFirstSyncCard(sub) ? `：${syncErrorMessage(sub)}` : ''}
                          {sub.sync_error_code === 'NEEDS_REAUTH' && (
                            <a href={repairBindHref}>重新绑定重庆大学统一认证账号</a>
                          )}
                        </span>
                        {sub.external_state !== 'reselecting' && sub.last_synced_at && (
                          <span className="dash-sync-meta">上次成功：{formatDate(sub.last_synced_at)}</span>
                        )}
                      </>
                    ) : isSubSyncing(sub) ? (
                      <span className="dash-sync-progress">
                        <Loader2 />
                        {syncProgressLabel(sub)}
                      </span>
                    ) : isFirstSyncCard(sub) &&
                      sub.sync_status === 'success' &&
                      sub.last_synced_at ? (
                      <span className="dash-sync-meta">刚刚同步</span>
                    ) : sub.external_state === 'reselecting' ? null : sub.last_synced_at ? (
                      <span className="dash-sync-meta">
                        同步于 {formatDate(sub.last_synced_at)}
                      </span>
                    ) : (
                      <span className="dash-sync-meta">尚未同步</span>
                    )}
                  </div>
                </div>
                <div className="dash-card-actions">
                  {sub.source_version === 1 && firstSyncLinkUnavailable(sub) && <p id={`external-links-${sub.id}`} className="dash-external-link-notice">
                    {sub.external_state === 'expired' ? '教学班已过期，请重新选择教学班。' : '课表暂不可用，请等待同步成功。'}全部公共链接暂时停用。
                  </p>}
                  {link && (
                    <div className="dash-main-actions" aria-describedby={sub.source_version === 1 && firstSyncLinkUnavailable(sub) ? `external-links-${sub.id}` : undefined}>
                      {!firstSyncLinkUnavailable(sub) ? (
                        <Button asChild size="default">
                          <a
                            href={buildLinkUrl(session.publicUrl, link.token, 'web')}
                            target="_blank"
                            rel="noopener"
                            title="网页预览"
                            aria-label={`查看课表：${sub.source_name}`}
                          >
                            <ExternalLink aria-hidden="true" />
                            查看课表
                          </a>
                        </Button>
                      ) : (
                        <Button
                          size="default"
                          title="网页预览"
                          aria-label={`查看课表：${sub.source_name}`}
                          disabled
                          aria-describedby={sub.source_version === 1 ? `external-links-${sub.id}` : undefined}
                        >
                          <ExternalLink aria-hidden="true" />
                          查看课表
                        </Button>
                      )}
                      <ActionButton
                        variant="outline"
                        state={copyFeedback.stateOf(sub.id)}
                        labels={{
                          idle: '复制链接',
                          loading: '复制中',
                          success: '已复制',
                          error: '复制失败',
                        }}
                        disabled={firstSyncLinkUnavailable(sub)}
                        aria-describedby={sub.source_version === 1 && firstSyncLinkUnavailable(sub) ? `external-links-${sub.id}` : undefined}
                        onClick={() => void handleCopyIcs({ sub, defaultLink: link })}
                      />
                    </div>
                  )}
                  <div className="dash-secondary-actions">
                    {sub.user_id === session.user?.id && sub.source_version === 1 && sub.source_type === 'course'
                      && !sub.is_personal && sub.sync_status !== 'queued' && sub.sync_status !== 'running'
                      && !isSubSyncing(sub) && session.can('external') && session.cquBindStatus === 'active'
                      && session.externalAvailability.create_types.includes('course')
                      && (sub.external_state === 'expired' || (sub.external_state === 'reselecting' && sub.sync_status === 'error')) && (
                        <Button asChild variant="outline">
                          <Link to={`/add?reselect=${encodeURIComponent(sub.id)}`} aria-label={`重新选择教学班：${sub.source_name}`}>
                            重新选择教学班
                          </Link>
                        </Button>
                      )}
                    <SyncActionButton
                      state={refreshButtonState(sub)}
                      labels={{
                        idle: refreshIdleLabel(sub),
                        loading: '同步中',
                        success: '已刷新',
                        error: isFirstSyncCard(sub) ? '重试同步' : '失败',
                      }}
                      disabled={!canRefreshSub(sub) || isRefreshCoolingDown(sub)}
                      onClick={() => void handleRefreshSub(sub.id)}
                    />
                    {link && (
                      <Button
                        variant="outline"
                        size="icon"
                        title="二维码"
                        aria-label={`${sub.source_name}二维码`}
                        disabled={firstSyncLinkUnavailable(sub)}
                        aria-describedby={sub.source_version === 1 && firstSyncLinkUnavailable(sub) ? `external-links-${sub.id}` : undefined}
                        onClick={() => openQrModal({ sub, defaultLink: link })}
                      >
                        <QrCode />
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          title="更多"
                          aria-label={`${sub.source_name}的更多操作`}
                          ref={(element) => {
                            if (element) menuTriggersRef.current.set(sub.id, element)
                            else menuTriggersRef.current.delete(sub.id)
                          }}
                        >
                          <Ellipsis />
                        </Button>
                      </DropdownMenuTrigger>
                      {/* A dialog takes over immediately; do not retain its source menu's exit. */}
                      {!shareOpen && !deleteTarget && (
                        <DropdownMenuContent
                          align="end"
                          onCloseAutoFocus={(event) => {
                            if (dialogTriggerRef.current) event.preventDefault()
                          }}
                        >
                          {link &&
                            (['ics', 'data_json', 'origin_json', 'csv'] as const).map((fmt) => sub.source_version === 1 && firstSyncLinkUnavailable(sub) ? (
                              <DropdownMenuItem key={fmt} disabled>
                                <Download />下载 {DOWNLOAD_LABELS[fmt]}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem key={fmt} asChild>
                                <a
                                  href={buildLinkUrl(session.publicUrl, link.token, fmt)}
                                  download
                                  onClick={() =>
                                    captureAction('export_calendar', 'unverified', { format: fmt })
                                  }
                                >
                                  <Download />
                                  下载 {DOWNLOAD_LABELS[fmt]}
                                </a>
                              </DropdownMenuItem>
                            ))}
                          <DropdownMenuItem onSelect={() => openShareLinks(sub)}>
                            <Share2 />
                            管理共享链接
                          </DropdownMenuItem>
                          {!sub.is_personal && (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => openDeleteSubDialog(sub)}
                            >
                              <Trash2 />
                              删除
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      )}
                    </DropdownMenu>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {subscriptions.length === 0 && !preparing && !preparationError && (
            <PageState
              state="empty"
              title="还没有订阅"
              description="添加课表订阅后，课表会自动同步到你的日历应用。"
              action={
                <Button asChild variant="outline" size="default">
                  <Link to="/add">添加新订阅</Link>
                </Button>
              }
            />
          )}
        </>
      )}

      {canChangeNotification && !loading && !loadError && (
        <section className="dash-settings" aria-label="通知设置">
          <div>
            <h2>课表变更通知</h2>
            <p>课表有变化时，通过邮件提醒你。</p>
          </div>

          <div className="dash-notification">
            <Switch
              id="notification-settings"
              aria-label="课表变更通知"
              checked={notificationEnabled}
              disabled={notificationLoading}
              onCheckedChange={() => void toggleNotification()}
            />
            <Label htmlFor="notification-settings" className="sr-only">
              课表变更通知
            </Label>
          </div>
        </section>
      )}
      <Suspense
        fallback={
          <p className="dash-dialog-loading" role="status">
            正在打开…
          </p>
        }
      >
        {qrModal.url && (
          <QrcodeModal
            open={qrModal.open}
            url={qrModal.url}
            token={qrModal.token}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              qrTriggerRef.current?.focus()
            }}
            onOpenChange={(v) =>
              setQrModal((current) => (v ? current : { ...current, open: false }))
            }
          />
        )}

        {activeShareSub && (
          <ShareLinksDialog
            open={shareOpen}
            subscription={activeShareSub}
            shareLinkCount={shareLinkCount}
            atShareLimit={atShareLimit}
            onCloseAutoFocus={restoreDialogFocus}
            onOpenChange={(v) => {
              if (!v) setShareOpen(false)
            }}
            onChanged={() => {
              void loadSubscriptions(true).catch(() => {})
            }}
          />
        )}
      </Suspense>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v && !deletingRef.current) setDeleteTarget(null)
        }}
      >
        <DialogContent onCloseAutoFocus={restoreDialogFocus}>
          <DialogHeader>
            <DialogTitle>确认删除订阅</DialogTitle>
            <DialogDescription>
              确定要删除「{deleteTarget?.name}」的课表订阅吗？已订阅的日历客户端将不再收到更新。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <ActionButton
              variant="destructive"
              state={deleting ? 'loading' : 'idle'}
              labels={{ idle: '删除', loading: '正在删除…', success: '已删除', error: '删除失败' }}
              onClick={() => deleteTarget && void handleDeleteSub(deleteTarget.id)}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
