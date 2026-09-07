<template>
  <div class="min-h-screen bg-background">
    <Navbar />

    <div class="max-w-2xl mx-auto px-4 pt-24 pb-12">
      <!-- Header: title + usage + add button -->
      <section class="mb-6">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h3 class="text-base font-semibold">
              我的订阅
              <span
                v-if="subStore.count > 0"
                class="text-muted-foreground font-normal text-sm ml-1"
              >
                ({{ subStore.count }}<template v-if="subLimit !== null">/{{ subLimit }}</template>)
              </span>
            </h3>
            <p
              class="mt-1 inline-flex items-center gap-1.5 text-xs"
              :class="session.can('sync') ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'"
            >
              <span
                aria-hidden="true"
                class="h-1.5 w-1.5 rounded-full"
                :class="session.can('sync') ? 'bg-emerald-500' : 'bg-muted-foreground/50'"
              />
              {{ session.can('sync') ? '自动同步已开启' : '自动同步未开通' }}
            </p>
            <div
              v-if="session.can('change_notification')"
              id="notification-settings"
              class="mt-2 flex items-center gap-2"
            >
              <button
                type="button"
                role="switch"
                aria-label="课表变更通知"
                :aria-checked="notificationEnabled"
                :disabled="notificationLoading"
                class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
                :class="notificationEnabled ? 'bg-foreground' : 'bg-muted-foreground/35'"
                @click="toggleNotification"
              >
                <span
                  aria-hidden="true"
                  class="block h-4 w-4 rounded-full bg-background shadow-sm transition-transform"
                  :class="notificationEnabled ? 'translate-x-4' : 'translate-x-0.5'"
                />
              </button>
              <span class="text-sm text-foreground">课表变更通知</span>
              <span class="text-xs text-muted-foreground">有变化时发邮件</span>
            </div>
            <p
              v-if="subStore.atLimit"
              class="text-xs text-amber-600 dark:text-amber-400 mt-0.5"
            >
              已达订阅上限
            </p>
          </div>

          <div class="flex gap-2">
            <!-- Sync-all personal button -->
            <Button
              variant="outline"
              size="sm"
              class="cursor-pointer"
              :disabled="syncAllButtonState === 'loading' || personalSubs.length === 0 || !canManualRefresh || syncAllCooldownSeconds > 0"
              :class="{
                'bg-green-600 hover:bg-green-600 text-white border-transparent':
                  syncAllButtonState === 'success',
                'bg-destructive hover:bg-destructive text-white border-transparent':
                  syncAllButtonState === 'error',
              }"
              @click="handleSyncAll"
            >
              <Loader2
                v-if="syncAllButtonState === 'loading'"
                class="h-4 w-4 mr-1.5 animate-spin"
              />
              <Check
                v-else-if="syncAllButtonState === 'success'"
                class="h-4 w-4 mr-1.5"
              />
              <X
                v-else-if="syncAllButtonState === 'error'"
                class="h-4 w-4 mr-1.5"
              />
              <RefreshCw v-else class="h-4 w-4 mr-1.5" />
              {{
                { loading: '同步中', success: '已同步', error: '失败' }[
                    syncAllButtonState
                ] || (syncAllCooldownSeconds > 0 ? cooldownLabel(syncAllCooldownSeconds) : '同步个人课表')
              }}
            </Button>

            <!-- Add subscription -->
            <router-link to="/add">
              <Button
                variant="outline"
                size="sm"
                class="cursor-pointer"
                :disabled="subStore.atLimit"
              >
                添加订阅
              </Button>
            </router-link>
          </div>
        </div>

        <!-- Loading skeleton -->
        <div v-if="loading" class="flex items-center justify-center py-8">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>

        <!-- M4: Iterate enriched list — each card derives its defaultLink once -->
        <Card v-for="item in enrichedSubs" :key="item.sub.id" class="mb-4">
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" class="text-xs">
                {{ sourceTypeLabel(item.sub.source_type) }}
              </Badge>
              {{ item.sub.source_name }}
              <Badge
                v-if="item.sub.is_personal"
                variant="outline"
                class="text-xs ml-auto shrink-0"
              >
                个人
              </Badge>
            </CardTitle>
            <div class="flex items-center gap-2 flex-wrap mt-1">
              <Badge v-if="item.sub.session_name" variant="outline" class="text-xs">
                {{ item.sub.session_name }}
              </Badge>
              <span
                v-if="syncErrorMessage(item.sub)"
                class="text-xs text-destructive"
              >
                同步失败：{{ syncErrorMessage(item.sub) }}
              </span>
              <span
                v-else-if="isSubSyncing(item.sub)"
                class="text-xs text-muted-foreground inline-flex items-center gap-1"
              >
                <Loader2 class="h-3 w-3 animate-spin" />
                {{ syncProgressLabel(item.sub) }}
              </span>
              <span v-else-if="item.sub.last_synced_at" class="text-xs text-muted-foreground">
                同步于 {{ formatDate(item.sub.last_synced_at) }}
              </span>
              <span v-else class="text-xs text-muted-foreground">
                尚未同步
              </span>
            </div>
          </CardHeader>

          <CardContent class="space-y-3">
            <!-- Primary action row -->
            <div class="flex flex-wrap gap-2">
              <!-- Manual refresh -->
              <Button
                variant="outline"
                size="sm"
                class="cursor-pointer"
                :disabled="refreshButtonState(item.sub) === 'loading' || !canManualRefresh || isRefreshCoolingDown(item.sub)"
                :class="{
                  'bg-green-600 hover:bg-green-600 text-white border-transparent':
                    refreshButtonState(item.sub) === 'success',
                  'bg-destructive hover:bg-destructive text-white border-transparent':
                    refreshButtonState(item.sub) === 'error',
                }"
                @click="handleRefreshSub(item.sub.id)"
              >
                <Loader2
                  v-if="refreshButtonState(item.sub) === 'loading'"
                  class="h-4 w-4 animate-spin mr-1.5"
                />
                <Check
                  v-else-if="refreshButtonState(item.sub) === 'success'"
                  class="h-4 w-4 mr-1.5"
                />
                <X
                  v-else-if="refreshButtonState(item.sub) === 'error'"
                  class="h-4 w-4 mr-1.5"
                />
                <RefreshCw v-else class="h-4 w-4 mr-1.5" />
                {{ refreshButtonLabel(item.sub) }}
              </Button>

              <!-- Copy subscribe URL (ICS) -->
              <template v-if="item.defaultLink">
                <Button
                  variant="outline"
                  size="sm"
                  class="cursor-pointer"
                  :class="{
                    'bg-green-600 hover:bg-green-600 text-white border-transparent':
                      copyFeedback.stateOf(item.sub.id) === 'success',
                  }"
                  @click="handleCopyIcs(item)"
                >
                  <Check
                    v-if="copyFeedback.stateOf(item.sub.id) === 'success'"
                    class="h-4 w-4 mr-1.5"
                  />
                  <Copy v-else class="h-4 w-4 mr-1.5" />
                  {{ copyFeedback.stateOf(item.sub.id) === 'success' ? '已复制' : '复制订阅链接' }}
                </Button>

                <!-- QR code modal -->
                <Button
                  variant="outline"
                  size="icon"
                  class="cursor-pointer h-8 w-8"
                  title="二维码"
                  @click="openQrModal(item)"
                >
                  <QrCode class="h-4 w-4" />
                </Button>

                <!-- Open web view -->
                <a
                  :href="buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'web')"
                  target="_blank"
                  rel="noopener"
                >
                  <Button
                    variant="outline"
                    size="icon"
                    class="cursor-pointer h-8 w-8"
                    title="网页预览"
                  >
                    <ExternalLink class="h-4 w-4" />
                  </Button>
                </a>
              </template>

              <!-- More actions menu -->
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="outline"
                    size="icon"
                    class="cursor-pointer h-8 w-8"
                    title="更多"
                  >
                    <Ellipsis class="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <!-- Download links -->
                  <template v-if="item.defaultLink">
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'ics')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载 ICS 文件
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'data_json')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载课表 JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'origin_json')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载原始 JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'csv')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载 CSV
                    </DropdownMenuItem>
                  </template>

                  <!-- FE-3: Share-link management -->
                  <DropdownMenuItem
                    class="cursor-pointer"
                    @click="openShareLinks(item.sub)"
                  >
                    <Share2 class="h-4 w-4 mr-2" />
                    管理共享链接
                  </DropdownMenuItem>

                  <!-- Delete -->
                  <DropdownMenuItem
                    class="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
                    @click="openDeleteSubDialog(item.sub)"
                  >
                    <Trash2 class="h-4 w-4 mr-2" />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardContent>
        </Card>

        <!-- Empty state -->
        <div
          v-if="!loading && subStore.subscriptions.length === 0"
          class="text-center py-8 text-muted-foreground"
        >
          <p class="text-sm mb-3">暂无订阅</p>
          <router-link to="/add">
            <Button variant="outline" size="sm" class="cursor-pointer">添加新订阅</Button>
          </router-link>
        </div>
      </section>
    </div>

    <!-- QR code modal -->
    <QrcodeModal v-model="qrModal.open" :url="qrModal.url" />

    <!-- Share links dialog (FE-3) -->
    <!-- activeShareSub is store-derived so it updates after subStore.load() replaces objects -->
    <ShareLinksDialog
      v-if="activeShareSub"
      :open="shareLinksDialog.open"
      :subscription="activeShareSub"
      @update:open="v => { if (!v) shareLinksDialog.open = false }"
      @changed="subStore.load(true).catch(() => {})"
    />

    <!-- Delete subscription confirmation dialog -->
    <AlertDialog
      :open="!!deleteSubDialog"
      @update:open="v => { if (!v) deleteSubDialog = null }"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除订阅</AlertDialogTitle>
          <AlertDialogDescription>
            确定要删除「{{ deleteSubDialog?.name }}」的课表订阅吗？
            已订阅的日历客户端将不再收到更新。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer">取消</AlertDialogCancel>
          <AlertDialogAction
            class="cursor-pointer bg-destructive text-white hover:bg-destructive/90"
            @click="deleteSubDialog && handleDeleteSub(deleteSubDialog.id)"
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, reactive } from 'vue'
import {
  RefreshCw,
  Loader2,
  Check,
  X,
  Trash2,
  Ellipsis,
  Copy,
  QrCode,
  ExternalLink,
  Download,
  Share2,
} from 'lucide-vue-next'
import { useButtonFeedback } from '@/composables/useButtonFeedback'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import { useSession } from '@/stores/session'
import { useConfigStore } from '@/stores/config'
import { toast } from 'vue-sonner'
import type { SourceType, Subscription, CalendarLink } from '@/types/api'
import api from '@/api'
import { parseApiError } from '@/utils/error'
import { buildLinkUrl } from '@/utils/links'
import Navbar from '@/components/Navbar.vue'
import QrcodeModal from '@/components/QrcodeModal.vue'
import ShareLinksDialog from '@/components/ShareLinksDialog.vue'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ── Stores ────────────────────────────────────────────────────────────────────

const subStore = useSubscriptionsStore()
const session = useSession()
const configStore = useConfigStore()

// ── M4: Enriched subscription list ────────────────────────────────────────────

/**
 * Each entry pairs a subscription with its pre-computed defaultLink so the
 * template never calls subStore.defaultLink(sub) more than once per card.
 */
interface EnrichedSub {
  sub: Subscription
  defaultLink: CalendarLink | undefined
}

const enrichedSubs = computed<EnrichedSub[]>(() =>
  subStore.subscriptions.map(sub => ({
    sub,
    defaultLink: subStore.defaultLink(sub),
  })),
)

// ── State ─────────────────────────────────────────────────────────────────────

const loading = ref(true)
const notificationEnabled = ref(false)
const notificationLoading = ref(false)
const deleteSubDialog = ref<{ id: string; name: string } | null>(null)
const qrModal = ref<{ open: boolean; url: string }>({ open: false, url: '' })
const shareLinksDialog = reactive<{ open: boolean; subId: string | null }>({
  open: false,
  subId: null,
})

/**
 * Store-derived computed so the reference updates after subStore.load() replaces
 * subscription objects. ShareLinksDialog receives the fresh object and its watch
 * re-seeds localLinks from the reloaded links.
 */
const activeShareSub = computed(() =>
  shareLinksDialog.subId
    ? subStore.subscriptions.find(s => s.id === shareLinksDialog.subId) ?? null
    : null,
)

/**
 * Tracks the exact backend run returned by POST /syncs. Keeping the run id
 * prevents an older queue delivery from being mistaken for this refresh.
 */
interface PendingRefresh {
  runId: string | null
  oldSyncedAt: string | null
  startedAt: number
  unconfirmedSince: number | null
}
const pendingRefresh = reactive<Record<string, PendingRefresh>>({})
const localSyncErrors = reactive<Record<string, string>>({})
const localCooldownUntil = reactive<Record<string, number>>({})
const cooldownClock = ref(Date.now())

const isPolling = computed(() => Object.keys(pendingRefresh).length > 0)

let pollTimer: ReturnType<typeof setInterval> | null = null
let cooldownTimer: ReturnType<typeof setInterval> | null = null

// ── Computed ──────────────────────────────────────────────────────────────────

const subLimit = computed(() => session.quota('sub_limit'))

const personalSubs = computed(() => subStore.subscriptions.filter(s => s.is_personal))

/**
 * `manual_refresh` quota semantics: null = unlimited, 0 = disabled, n = n/day.
 * When 0, the backend will always return 429; disable the controls proactively.
 */
const canManualRefresh = computed(() => session.quota('manual_refresh') !== 0)

const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60_000

function refreshCooldownSeconds(sub: Subscription): number {
  const persistedUntil = sub.manual_refresh_at
    ? Date.parse(sub.manual_refresh_at) + MANUAL_REFRESH_COOLDOWN_MS
    : 0
  const until = Math.max(persistedUntil, localCooldownUntil[sub.id] ?? 0)
  return Math.max(0, Math.ceil((until - cooldownClock.value) / 1000))
}

function isRefreshCoolingDown(sub: Subscription): boolean {
  return refreshCooldownSeconds(sub) > 0
}

function cooldownLabel(seconds: number): string {
  return `${Math.ceil(seconds / 60)} 分钟后可同步`
}

function isSubSyncing(sub: Subscription): boolean {
  return sub.id in pendingRefresh || sub.sync_status === 'queued' || sub.sync_status === 'running'
}

function syncErrorMessage(sub: Subscription): string | null {
  if (sub.id in pendingRefresh) return null
  return localSyncErrors[sub.id] ?? (sub.sync_status === 'error' ? sub.sync_error_message : null)
}

function syncProgressLabel(sub: Subscription): string {
  return sub.sync_status === 'queued' && Boolean(sub.sync_error_code)
    ? '同步遇到临时故障，正在自动重试...'
    : '同步中...'
}

// ── Button feedback ───────────────────────────────────────────────────────────

const refreshFeedback = useButtonFeedback()
const syncFeedback = useButtonFeedback()
const copyFeedback = useButtonFeedback()

function refreshButtonState(sub: Subscription) {
  if (syncErrorMessage(sub)) return 'error'
  if (isSubSyncing(sub)) return 'loading'
  return refreshFeedback.stateOf(sub.id)
}

function refreshButtonLabel(sub: Subscription): string {
  const state = refreshButtonState(sub)
  if (state === 'loading') return '同步中'
  if (state === 'success') return '已刷新'
  if (state === 'error') return '失败'
  const remaining = refreshCooldownSeconds(sub)
  return remaining > 0 ? cooldownLabel(remaining) : '同步'
}

const syncAllCooldownSeconds = computed(() =>
  personalSubs.value.reduce((remaining, sub) => Math.max(remaining, refreshCooldownSeconds(sub)), 0),
)

const syncAllButtonState = computed(() => {
  if (personalSubs.value.some(isSubSyncing)) return 'loading'
  if (personalSubs.value.some(sub => Boolean(syncErrorMessage(sub)))) return 'error'
  return syncFeedback.stateOf()
})

// ── Source type labels ────────────────────────────────────────────────────────

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

function sourceTypeLabel(type: SourceType): string {
  return SOURCE_TYPE_LABELS[type] || type
}

// ── Date formatting ───────────────────────────────────────────────────────────

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
}

// ── Polling ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 2000
const POLL_TIMEOUT = 30000
const POLL_ACTIVE_TIMEOUT = 15 * 60_000

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Fail selected pending refreshes so no subscription stays "同步中" forever.
 * Defaults to all pending entries for callers that need a global abort.
 */
function failPendingRefreshes(message: string, ids = Object.keys(pendingRefresh)) {
  for (const id of ids) {
    localSyncErrors[id] = message
    delete pendingRefresh[id]
  }
  if (ids.length > 0) toast.error(message)
}

function startSyncPolling() {
  if (pollTimer) return // already running

  pollTimer = setInterval(async () => {
    await subStore.load(true).catch(() => {})
    const now = Date.now()
    const timedOutIds: string[] = []

    for (const [id, pending] of Object.entries(pendingRefresh)) {
      const sub = subStore.subscriptions.find(s => s.id === id)
      if (!sub) {
        // Sub no longer exists — remove from tracking
        delete pendingRefresh[id]
        continue
      }
      const isSameRun = !pending.runId || sub.sync_run_id === pending.runId
      if (isSameRun && sub.sync_status === 'error') {
        const message = sub.sync_error_message || '同步失败，请稍后重试'
        localSyncErrors[id] = message
        toast.error(message)
        delete pendingRefresh[id]
        continue
      }
      if ((isSameRun && sub.sync_status === 'success') || sub.last_synced_at !== pending.oldSyncedAt) {
        delete localSyncErrors[id]
        toast.success('同步完成')
        delete pendingRefresh[id]
        continue
      }

      const backendStillWorking = isSameRun
        && (sub.sync_status === 'queued' || sub.sync_status === 'running')
      if (backendStillWorking) {
        pending.unconfirmedSince = null
        if (now - pending.startedAt >= POLL_ACTIVE_TIMEOUT) timedOutIds.push(id)
        continue
      }

      pending.unconfirmedSince ??= now
      if (now - pending.unconfirmedSince >= POLL_TIMEOUT) timedOutIds.push(id)
    }

    failPendingRefreshes('同步超时，请稍后重试', timedOutIds)

    if (Object.keys(pendingRefresh).length === 0) {
      stopPolling()
    }
  }, POLL_INTERVAL)
}

/**
 * Track a set of sub ids as pending-refresh. Captures their current
 * last_synced_at values and starts the poll if not already running.
 */
function trackRefresh(runs: Array<{ id: string; runId: string | null }>) {
  const startedAt = Date.now()
  for (const { id, runId } of runs) {
    const sub = subStore.subscriptions.find(s => s.id === id)
    delete localSyncErrors[id]
    pendingRefresh[id] = {
      runId,
      oldSyncedAt: sub?.last_synced_at ?? null,
      startedAt,
      unconfirmedSince: null,
    }
  }
  startSyncPolling()
}

// ── Actions ───────────────────────────────────────────────────────────────────

function openDeleteSubDialog(sub: Subscription) {
  deleteSubDialog.value = { id: sub.id, name: sub.source_name }
}

function openShareLinks(sub: Subscription) {
  shareLinksDialog.subId = sub.id
  shareLinksDialog.open = true
}

async function handleCopyIcs(item: EnrichedSub) {
  if (!item.defaultLink) return
  const url = buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'ics')
  try {
    await copyFeedback.run(async () => {
      await navigator.clipboard.writeText(url)
    }, item.sub.id)
  } catch {
    toast.error('复制失败，请手动复制链接')
  }
}

function openQrModal(item: EnrichedSub) {
  if (!item.defaultLink) return
  qrModal.value = {
    open: true,
    url: buildLinkUrl(configStore.publicUrl, item.defaultLink.token, 'ics'),
  }
}

async function handleRefreshSub(sid: string) {
  try {
    await refreshFeedback.run(async () => {
      const result = await api.refreshSubscription(sid)
      toast.success('已加入刷新队列')
      const affectedIds = result.affected_subscription_ids?.length
        ? result.affected_subscription_ids
        : [sid]
      const cooldownUntil = Date.parse(result.cooldown_until ?? '') || Date.now() + MANUAL_REFRESH_COOLDOWN_MS
      for (const id of affectedIds) localCooldownUntil[id] = cooldownUntil
      trackRefresh(affectedIds.map(id => ({ id, runId: result.run_id })))
    }, sid)
  } catch (error) {
    toast.error(parseApiError(error, '刷新失败'))
  }
}

async function handleDeleteSub(sid: string) {
  try {
    await api.deleteSubscription(sid)
    toast.success('订阅已删除')
    deleteSubDialog.value = null
    await subStore.load(true).catch(() => {})
  } catch (error) {
    toast.error(parseApiError(error, '删除订阅失败'))
  }
}

async function handleSyncAll() {
  if (personalSubs.value.length === 0) return
  try {
    await syncFeedback.run(async () => {
      const target = personalSubs.value.find(sub => sub.source_type === 'personal_all')
        ?? personalSubs.value[0]
      const result = await api.refreshSubscription(target.id)
      const affectedIds = result.affected_subscription_ids?.length
        ? result.affected_subscription_ids
        : personalSubs.value.map(sub => sub.id)
      const cooldownUntil = Date.parse(result.cooldown_until ?? '') || Date.now() + MANUAL_REFRESH_COOLDOWN_MS
      for (const id of affectedIds) localCooldownUntil[id] = cooldownUntil
      trackRefresh(affectedIds.map(id => ({ id, runId: result.run_id })))
      await subStore.load(true).catch(() => {})
    })
  } catch (error) {
    toast.error(parseApiError(error, '同步失败'))
  }
}

async function loadNotificationSettings() {
  notificationLoading.value = true
  try {
    const settings = await api.getNotificationSettings()
    notificationEnabled.value = settings.enabled
  } finally {
    notificationLoading.value = false
  }
}

async function toggleNotification() {
  if (notificationLoading.value) return
  const next = !notificationEnabled.value
  notificationLoading.value = true
  try {
    const settings = await api.updateNotificationSettings(next)
    notificationEnabled.value = settings.enabled
  } catch {
    toast.error('保存通知设置失败')
  } finally {
    notificationLoading.value = false
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  cooldownTimer = setInterval(() => {
    cooldownClock.value = Date.now()
  }, 1000)
  try {
    if (!session.loaded) await session.load()
    await Promise.all([
      subStore.load(),
      ...(session.can('change_notification') ? [loadNotificationSettings()] : []),
    ])
    const activeRuns = subStore.subscriptions
      .filter(sub => sub.sync_status === 'queued' || sub.sync_status === 'running')
      .map(sub => ({ id: sub.id, runId: sub.sync_run_id }))
    if (activeRuns.length > 0) trackRefresh(activeRuns)
  } catch {
    toast.error('加载订阅列表失败')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopPolling()
  if (cooldownTimer) clearInterval(cooldownTimer)
})
</script>
