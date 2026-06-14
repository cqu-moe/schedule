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
              :disabled="syncFeedback.stateOf() === 'loading' || personalSubs.length === 0"
              :class="{
                'bg-green-600 hover:bg-green-600 text-white border-transparent':
                  syncFeedback.stateOf() === 'success',
                'bg-destructive hover:bg-destructive text-white border-transparent':
                  syncFeedback.stateOf() === 'error',
              }"
              @click="handleSyncAll"
            >
              <Loader2
                v-if="syncFeedback.stateOf() === 'loading'"
                class="h-4 w-4 mr-1.5 animate-spin"
              />
              <Check
                v-else-if="syncFeedback.stateOf() === 'success'"
                class="h-4 w-4 mr-1.5"
              />
              <X
                v-else-if="syncFeedback.stateOf() === 'error'"
                class="h-4 w-4 mr-1.5"
              />
              <RefreshCw v-else class="h-4 w-4 mr-1.5" />
              {{
                { loading: '同步中', success: '已同步', error: '失败' }[
                  syncFeedback.stateOf()
                ] || '同步个人课表'
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

        <!-- Subscription cards -->
        <Card v-for="sub in subStore.subscriptions" :key="sub.id" class="mb-4">
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" class="text-xs">
                {{ sourceTypeLabel(sub.source_type) }}
              </Badge>
              {{ sub.source_name }}
              <Badge
                v-if="sub.is_personal"
                variant="outline"
                class="text-xs ml-auto shrink-0"
              >
                个人
              </Badge>
            </CardTitle>
            <div class="flex items-center gap-2 flex-wrap mt-1">
              <Badge v-if="sub.session_name" variant="outline" class="text-xs">
                {{ sub.session_name }}
              </Badge>
              <span
                v-if="sub.id in pendingRefresh"
                class="text-xs text-muted-foreground inline-flex items-center gap-1"
              >
                <Loader2 class="h-3 w-3 animate-spin" />
                同步中...
              </span>
              <span v-else-if="sub.last_synced_at" class="text-xs text-muted-foreground">
                同步于 {{ formatDate(sub.last_synced_at) }}
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
                :disabled="refreshFeedback.stateOf(sub.id) === 'loading'"
                :class="{
                  'bg-green-600 hover:bg-green-600 text-white border-transparent':
                    refreshFeedback.stateOf(sub.id) === 'success',
                  'bg-destructive hover:bg-destructive text-white border-transparent':
                    refreshFeedback.stateOf(sub.id) === 'error',
                }"
                @click="handleRefreshSub(sub.id)"
              >
                <Loader2
                  v-if="refreshFeedback.stateOf(sub.id) === 'loading'"
                  class="h-4 w-4 animate-spin mr-1.5"
                />
                <Check
                  v-else-if="refreshFeedback.stateOf(sub.id) === 'success'"
                  class="h-4 w-4 mr-1.5"
                />
                <X
                  v-else-if="refreshFeedback.stateOf(sub.id) === 'error'"
                  class="h-4 w-4 mr-1.5"
                />
                <RefreshCw v-else class="h-4 w-4 mr-1.5" />
                {{
                  { loading: '同步中', success: '已刷新', error: '失败' }[
                    refreshFeedback.stateOf(sub.id)
                  ] || '同步'
                }}
              </Button>

              <!-- Copy subscribe URL (ICS) -->
              <template v-if="subStore.defaultLink(sub)">
                <Button
                  variant="outline"
                  size="sm"
                  class="cursor-pointer"
                  :class="{
                    'bg-green-600 hover:bg-green-600 text-white border-transparent':
                      copyFeedback.stateOf(sub.id) === 'success',
                  }"
                  @click="handleCopyIcs(sub)"
                >
                  <Check
                    v-if="copyFeedback.stateOf(sub.id) === 'success'"
                    class="h-4 w-4 mr-1.5"
                  />
                  <Copy v-else class="h-4 w-4 mr-1.5" />
                  {{ copyFeedback.stateOf(sub.id) === 'success' ? '已复制' : '复制订阅链接' }}
                </Button>

                <!-- QR code modal -->
                <Button
                  variant="outline"
                  size="icon"
                  class="cursor-pointer h-8 w-8"
                  title="二维码"
                  @click="openQrModal(sub)"
                >
                  <QrCode class="h-4 w-4" />
                </Button>

                <!-- Open web view -->
                <a
                  :href="buildLinkUrl(configStore.publicUrl, subStore.defaultLink(sub)!.token, 'web')"
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
                  <template v-if="subStore.defaultLink(sub)">
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, subStore.defaultLink(sub)!.token, 'ics')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载 ICS 文件
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, subStore.defaultLink(sub)!.token, 'data_json')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载课表 JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, subStore.defaultLink(sub)!.token, 'origin_json')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载原始 JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      as="a"
                      :href="buildLinkUrl(configStore.publicUrl, subStore.defaultLink(sub)!.token, 'csv')"
                      download
                      class="cursor-pointer"
                    >
                      <Download class="h-4 w-4 mr-2" />
                      下载 CSV
                    </DropdownMenuItem>
                  </template>

                  <!-- TODO(FE-3): share-link management -->
                  <!-- Seam: FE-3 will add a "管理共享链接" item here that opens
                       a ShareLinksDialog (which handles create/patch/delete/rotate
                       on non-default CalendarLink objects). The sub.id and
                       sub.links are already available in this scope. -->
                  <DropdownMenuItem
                    disabled
                    class="cursor-not-allowed opacity-50"
                    title="即将推出"
                  >
                    <Share2 class="h-4 w-4 mr-2" />
                    管理共享链接
                  </DropdownMenuItem>

                  <!-- Delete (non-personal only) -->
                  <template v-if="!sub.is_personal">
                    <DropdownMenuItem
                      class="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
                      @click="openDeleteSubDialog(sub)"
                    >
                      <Trash2 class="h-4 w-4 mr-2" />
                      删除
                    </DropdownMenuItem>
                  </template>
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
import type { SourceType, Subscription } from '@/types/api'
import api from '@/api'
import { parseApiError } from '@/utils/error'
import { buildLinkUrl } from '@/utils/links'
import Navbar from '@/components/Navbar.vue'
import QrcodeModal from '@/components/QrcodeModal.vue'
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

// ── State ─────────────────────────────────────────────────────────────────────

const loading = ref(true)
const deleteSubDialog = ref<{ id: string; name: string } | null>(null)
const qrModal = ref<{ open: boolean; url: string }>({ open: false, url: '' })

/**
 * Maps sub.id → the last_synced_at value captured AT THE MOMENT of manual
 * refresh (may be null). A sub is "pending refresh" while it exists in this
 * map. Cleared when a poll sees a CHANGED last_synced_at, or on POLL_TIMEOUT.
 */
const pendingRefresh = reactive<Record<string, string | null>>({})

const isPolling = computed(() => Object.keys(pendingRefresh).length > 0)

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollStartTime = 0

// ── Computed ──────────────────────────────────────────────────────────────────

const subLimit = computed(() => session.quota('sub_limit'))

const personalSubs = computed(() => subStore.subscriptions.filter(s => s.is_personal))

// ── Button feedback ───────────────────────────────────────────────────────────

const refreshFeedback = useButtonFeedback()
const syncFeedback = useButtonFeedback()
const copyFeedback = useButtonFeedback()

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

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Clear all pending-refresh tracking (timeout guard so no sub is stuck
 * "同步中" forever).
 */
function clearPendingRefresh() {
  for (const id of Object.keys(pendingRefresh)) {
    delete pendingRefresh[id]
  }
}

function startSyncPolling() {
  if (pollTimer) return // already running
  pollStartTime = Date.now()

  pollTimer = setInterval(async () => {
    if (Date.now() - pollStartTime > POLL_TIMEOUT) {
      stopPolling()
      clearPendingRefresh()
      return
    }

    await subStore.load(true).catch(() => {})

    // For each tracked sub, check whether last_synced_at has changed.
    for (const [id, oldSyncedAt] of Object.entries(pendingRefresh)) {
      const sub = subStore.subscriptions.find(s => s.id === id)
      if (!sub) {
        // Sub no longer exists — remove from tracking
        delete pendingRefresh[id]
        continue
      }
      if (sub.last_synced_at !== oldSyncedAt) {
        // Timestamp changed (or first sync completed) — refresh done
        delete pendingRefresh[id]
      }
    }

    if (Object.keys(pendingRefresh).length === 0) {
      stopPolling()
    }
  }, POLL_INTERVAL)
}

/**
 * Track a set of sub ids as pending-refresh. Captures their current
 * last_synced_at values and starts the poll if not already running.
 */
function trackRefresh(ids: string[]) {
  for (const id of ids) {
    const sub = subStore.subscriptions.find(s => s.id === id)
    pendingRefresh[id] = sub?.last_synced_at ?? null
  }
  startSyncPolling()
}

// ── Actions ───────────────────────────────────────────────────────────────────

function openDeleteSubDialog(sub: Subscription) {
  deleteSubDialog.value = { id: sub.id, name: sub.source_name }
}

async function handleCopyIcs(sub: Subscription) {
  const link = subStore.defaultLink(sub)
  if (!link) return
  const url = buildLinkUrl(configStore.publicUrl, link.token, 'ics')
  try {
    await copyFeedback.run(async () => {
      await navigator.clipboard.writeText(url)
    }, sub.id)
  } catch {
    toast.error('复制失败，请手动复制链接')
  }
}

function openQrModal(sub: Subscription) {
  const link = subStore.defaultLink(sub)
  if (!link) return
  qrModal.value = {
    open: true,
    url: buildLinkUrl(configStore.publicUrl, link.token, 'ics'),
  }
}

async function handleRefreshSub(sid: string) {
  try {
    await refreshFeedback.run(async () => {
      await api.refreshSubscription(sid)
      toast.success('已加入刷新队列')
      trackRefresh([sid])
    }, sid)
  } catch (error) {
    toast.error(parseApiError(error, '刷新失败'))
  }
}

async function handleDeleteSub(sid: string) {
  try {
    toast.success('订阅已删除')
    deleteSubDialog.value = null
    await api.deleteSubscription(sid)
    await subStore.load(true).catch(() => {})
  } catch (error) {
    toast.error(parseApiError(error, '删除订阅失败'))
  }
}

async function handleSyncAll() {
  if (personalSubs.value.length === 0) return
  try {
    await syncFeedback.run(async () => {
      const results = await Promise.allSettled(
        personalSubs.value.map(sub => api.refreshSubscription(sub.id)),
      )
      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        throw failures.length === 1
          ? (failures[0] as PromiseRejectedResult).reason
          : new Error(`${failures.length} 个订阅同步失败`)
      }
      trackRefresh(personalSubs.value.map(s => s.id))
      await subStore.load(true).catch(() => {})
    })
  } catch (error) {
    toast.error(parseApiError(error, '同步失败'))
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await subStore.load()
  } catch {
    toast.error('加载订阅列表失败')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopPolling()
})
</script>
