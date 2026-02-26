<template>
  <div class="min-h-screen bg-background">
    <Navbar />

    <div class="max-w-2xl mx-auto px-4 pt-24 pb-12">
      <!-- Unified subscription list -->
      <section class="mb-6">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-base font-semibold">
            我的订阅
            <span v-if="subscriptions.length > 0" class="text-muted-foreground font-normal text-sm ml-1">
              ({{ subscriptions.length }}/{{ subscriptionsMax }})
            </span>
          </h3>
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              class="cursor-pointer"
              :disabled="syncing"
              @click="handleSyncAll"
            >
              <Loader2 v-if="syncing" class="h-4 w-4 mr-1.5 animate-spin" />
              <RefreshCw v-else class="h-4 w-4 mr-1.5" />
              同步所有
            </Button>
            <router-link to="/add">
              <Button variant="outline" size="sm" class="cursor-pointer">添加订阅</Button>
            </router-link>
          </div>
        </div>
        <p
          v-if="statusMessage"
          class="text-sm mb-3"
          :class="statusType === 'success' ? 'text-green-600' : 'text-destructive'"
        >
          {{ statusMessage }}
        </p>

        <!-- Loading state -->
        <div v-if="loading" class="flex items-center justify-center py-8">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>

        <!-- Subscription cards -->
        <Card v-for="sub in subscriptions" :key="sub.calendar_token" class="mb-4">
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2">
              <Badge variant="secondary" class="text-xs">{{ sourceTypeLabel(sub.source_type) }}</Badge>
              {{ sub.source_name }}
            </CardTitle>
            <div class="flex items-center gap-2 mt-1">
              <Badge v-if="sub.session_name" variant="outline" class="text-xs">
                {{ sub.session_name }}
              </Badge>
              <span v-if="sub.last_synced_at" class="text-xs text-muted-foreground">
                同步于 {{ formatDate(sub.last_synced_at) }}
              </span>
              <span v-else class="text-xs text-muted-foreground">尚未同步</span>
            </div>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="bg-muted rounded px-3 py-2 overflow-x-auto">
              <code class="text-xs text-muted-foreground break-all font-mono">{{ sub.subscription_url }}</code>
            </div>
            <div class="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                class="cursor-pointer"
                @click="copyUrl(sub.subscription_url, sub.calendar_token)"
              >
                <Check v-if="copiedToken === sub.calendar_token" class="h-4 w-4 mr-1.5" />
                <Copy v-else class="h-4 w-4 mr-1.5" />
                {{ copiedToken === sub.calendar_token ? '已复制' : '复制' }}
              </Button>
              <Button
                variant="outline"
                size="sm"
                class="cursor-pointer"
                @click="handleShowQrcode(sub.subscription_url)"
              >
                <QrCode class="h-4 w-4 mr-1.5" />
                二维码
              </Button>
              <Button
                variant="outline"
                size="sm"
                class="cursor-pointer"
                :disabled="refreshingToken === sub.calendar_token"
                @click="handleRefreshSub(sub.calendar_token)"
              >
                <Loader2 v-if="refreshingToken === sub.calendar_token" class="h-4 w-4 animate-spin mr-1.5" />
                <RefreshCw v-else class="h-4 w-4 mr-1.5" />
                同步
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="outline" size="sm" class="cursor-pointer">
                    <Download class="h-4 w-4 mr-1.5" />
                    导出
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem class="cursor-pointer" @click="downloadExport(sub.calendar_token, 'calendar.ics')">
                    ICS 日历
                  </DropdownMenuItem>
                  <DropdownMenuItem class="cursor-pointer" @click="downloadExport(sub.calendar_token, 'data.json')">
                    JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem class="cursor-pointer" @click="downloadExport(sub.calendar_token, 'origin.json')">
                    JSON（原始）
                  </DropdownMenuItem>
                  <DropdownMenuItem class="cursor-pointer" @click="downloadExport(sub.calendar_token, 'data.csv')">
                    CSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <!-- Delete button (only for non-personal subscriptions) -->
              <AlertDialog v-if="!sub.is_personal">
                <AlertDialogTrigger as-child>
                  <Button variant="outline" size="sm" class="cursor-pointer text-destructive hover:text-destructive">
                    <Trash2 class="h-4 w-4 mr-1.5" />
                    删除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认删除订阅</AlertDialogTitle>
                    <AlertDialogDescription>
                      确定要删除「{{ sub.source_name }}」的课表订阅吗？已订阅的日历客户端将不再收到更新。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel class="cursor-pointer">取消</AlertDialogCancel>
                    <AlertDialogAction
                      class="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      @click="handleDeleteSub(sub.calendar_token)"
                    >
                      删除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>

        <!-- Empty state (only when not loading) -->
        <div v-if="!loading && subscriptions.length === 0" class="text-center py-8 text-muted-foreground">
          <p class="text-sm mb-3">暂无订阅</p>
          <router-link to="/add">
            <Button variant="outline" size="sm" class="cursor-pointer">添加新订阅</Button>
          </router-link>
        </div>
      </section>

      <!-- Danger zone -->
      <section>
        <Card class="border-destructive/20 bg-destructive/5 gap-2">
          <CardHeader>
            <CardTitle class="text-base text-destructive">危险操作区</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="text-sm text-muted-foreground mb-4">
              删除账号将永久移除你的所有数据，此操作无法撤销。
            </p>

            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button variant="destructive" class="cursor-pointer">
                  删除账号
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除账号</AlertDialogTitle>
                  <AlertDialogDescription>
                    这将永久删除你的账号和所有数据，此操作无法撤销。
                    <br /><br />
                    请输入 <strong>确认删除</strong> 以继续：
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div class="py-2">
                  <Input
                    v-model="deleteConfirmText"
                    placeholder="确认删除"
                  />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel class="cursor-pointer" @click="deleteConfirmText = ''">
                    取消
                  </AlertDialogCancel>
                  <AlertDialogAction
                    class="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    :disabled="deleteConfirmText !== '确认删除' || deleting"
                    @click="handleDelete"
                  >
                    <Loader2 v-if="deleting" class="h-4 w-4 mr-2 animate-spin" />
                    删除账号
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </section>
    </div>

    <QrcodeModal v-model="showQrcode" :url="qrcodeUrl" />
    <RiskWarning v-model="showRiskWarning" />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { RefreshCw, Loader2, Copy, Check, Trash2, QrCode, Download } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useConfigStore } from '@/stores/config.js'
import api from '@/api'
import Navbar from '@/components/Navbar.vue'
import QrcodeModal from '@/components/QrcodeModal.vue'
import RiskWarning from '@/components/RiskWarning.vue'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const router = useRouter()
const authStore = useAuthStore()
const configStore = useConfigStore()

// State
const loading = ref(true)
const syncing = ref(false)
const deleting = ref(false)
const showRiskWarning = ref(false)
const deleteConfirmText = ref('')
const showQrcode = ref(false)
const qrcodeUrl = ref('')
const statusMessage = ref('')
const statusType = ref('success')
const subscriptions = ref([])
const subscriptionsMax = ref(5)
const copiedToken = ref(null)
const refreshingToken = ref(null)

let copiedTimer = null

const SOURCE_TYPE_LABELS = {
  personal_all: '全部',
  personal_courses: '课程',
  personal_exams: '考试',
  instructor: '教师',
  room: '教室',
  laboratory: '实验室',
  course: '课程',
  admin_class: '行政班',
}

function sourceTypeLabel(type) {
  return SOURCE_TYPE_LABELS[type] || type
}

function handleShowQrcode(url) {
  qrcodeUrl.value = url
  showQrcode.value = true
}

function downloadExport(calendarToken, filename) {
  const url = `${configStore.publicUrl}/api/v1/subscriptions/${calendarToken}/${filename}`
  window.open(url, '_blank', 'noopener,noreferrer')
}

function formatDate(isoString) {
  const date = new Date(isoString)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

async function loadSubscriptions() {
  try {
    const data = await api.getSubscriptions(authStore.token)
    subscriptions.value = data.subscriptions
    subscriptionsMax.value = data.max
  } catch {
    // Silent fail on load
  } finally {
    loading.value = false
  }
}

async function copyUrl(url, token) {
  try {
    await navigator.clipboard.writeText(url)
    copiedToken.value = token
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedToken.value = null }, 1500)
  } catch {
    // Silent fail
  }
}

async function handleRefreshSub(subToken) {
  refreshingToken.value = subToken
  try {
    await api.refreshSubscription(authStore.token, subToken)
    await loadSubscriptions()
    await authStore.fetchUserInfo()
  } catch (error) {
    statusMessage.value = error.response?.data?.detail || '刷新失败'
    statusType.value = 'error'
  } finally {
    refreshingToken.value = null
  }
}

async function handleDeleteSub(subToken) {
  try {
    await api.deleteSubscription(authStore.token, subToken)
    await loadSubscriptions()
  } catch {
    // Silent fail
  }
}

async function handleSyncAll() {
  syncing.value = true
  statusMessage.value = ''
  try {
    const personalSubs = subscriptions.value.filter(s => s.is_personal)
    for (const sub of personalSubs) {
      await api.refreshSubscription(authStore.token, sub.calendar_token)
    }
    await loadSubscriptions()
    await authStore.fetchUserInfo()
    statusMessage.value = '同步成功'
    statusType.value = 'success'
  } catch (error) {
    statusMessage.value = error.response?.data?.detail || '同步失败'
    statusType.value = 'error'
  } finally {
    syncing.value = false
  }
}

async function handleDelete() {
  deleting.value = true
  try {
    await api.deleteUser(authStore.token)
    authStore.logout()
    router.push('/')
  } catch {
    statusMessage.value = '删除失败'
    statusType.value = 'error'
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  const acknowledged = localStorage.getItem('risk_warning_acknowledged')
  if (!acknowledged) {
    showRiskWarning.value = true
  }
  loadSubscriptions()
})

onBeforeUnmount(() => {
  clearTimeout(copiedTimer)
})
</script>
