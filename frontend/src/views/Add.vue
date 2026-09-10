<template>
  <div class="min-h-screen bg-background">
    <Navbar />

    <div class="max-w-2xl mx-auto px-4 pt-28 pb-12">
      <h1 class="text-2xl font-heading font-semibold mb-6">添加新订阅</h1>

      <div
        v-if="setupPreparing || session.loading"
        class="mb-4 flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 class="h-4 w-4 animate-spin" />
        正在准备订阅…
      </div>
      <Alert v-else-if="setupError" variant="destructive" class="mb-4">
        <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
          <span>{{ setupError }}</span>
          <Button variant="outline" size="sm" @click="beginPersonalSetup">重试</Button>
        </AlertDescription>
      </Alert>

      <!-- ── Personal subscriptions ─────────────────────────────────────────── -->
      <section v-if="!setupPreparing && !session.loading" class="mb-6">
        <h2 class="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          个人课表
        </h2>
        <!-- No sync entitlement: explain instead of hiding the section outright,
             so an authenticated-but-unprovisioned user is not left with an empty page. -->
        <div
          v-if="!session.can('sync')"
          class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          个人课表订阅需要开通「日历同步」权限（内测阶段由管理员开通）。
        </div>
        <!-- Known-unbound: subscribing now would only fail at sync time, so
             point at the binding step first. Unknown (older auth) falls through
             to the normal options below. -->
        <div
          v-else-if="session.isCquUnbound"
          class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          尚未绑定重庆大学统一认证账号，绑定后即可订阅并自动同步个人课表。请先
          <a
            :href="bindHref"
            class="text-foreground underline underline-offset-2"
          >绑定重庆大学统一认证账号</a>
          完成绑定。
        </div>
        <Card v-else>
          <CardContent class="pt-4 space-y-2">
            <div
              v-for="opt in personalOptions"
              :key="opt.sourceType"
              class="flex items-center justify-between py-2"
            >
              <div>
                <p class="font-medium text-sm">{{ opt.label }}</p>
                <p class="text-xs text-muted-foreground">{{ opt.description }}</p>
              </div>
              <Button
                v-if="isPersonalSubscribed(opt.sourceType)"
                variant="outline"
                size="sm"
                disabled
              >
                <Check class="h-4 w-4 mr-1" />
                已订阅
              </Button>
              <Button
                v-else
                size="sm"
                class="cursor-pointer shrink-0"
                :disabled="
                  personalFeedback.stateOf(opt.sourceType) === 'loading' ||
                  subStore.atLimit
                "
                :class="{
                  'bg-green-600 hover:bg-green-600 text-white':
                    personalFeedback.stateOf(opt.sourceType) === 'success',
                  'bg-destructive hover:bg-destructive text-white':
                    personalFeedback.stateOf(opt.sourceType) === 'error',
                }"
                @click="handlePersonalSubscribe(opt)"
              >
                <Loader2
                  v-if="personalFeedback.stateOf(opt.sourceType) === 'loading'"
                  class="h-4 w-4 animate-spin mr-1"
                />
                <Check
                  v-else-if="personalFeedback.stateOf(opt.sourceType) === 'success'"
                  class="h-4 w-4 mr-1"
                />
                <X
                  v-else-if="personalFeedback.stateOf(opt.sourceType) === 'error'"
                  class="h-4 w-4 mr-1"
                />
                <Plus v-else class="h-4 w-4 mr-1" />
                {{
                  { loading: '订阅中', success: '已订阅', error: '失败' }[
                    personalFeedback.stateOf(opt.sourceType)
                  ] || '订阅'
                }}
              </Button>
            </div>

            <p v-if="subStore.atLimit" class="text-xs text-amber-600 dark:text-amber-400 pt-1">
              已达订阅上限，请先删除不需要的订阅
            </p>

            <p v-if="session.cquBindStatus === undefined" class="text-xs text-muted-foreground pt-1">
              首次使用？请先在
              <a
                :href="bindHref"
                class="underline underline-offset-2"
              >绑定重庆大学统一认证账号</a>
              ，否则课表无法同步。
            </p>
          </CardContent>
        </Card>
      </section>

      <!-- ── External subscriptions ─────────────────────────────────────────── -->
      <section class="mb-6">
        <h2 class="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          外部订阅
          <span
            v-if="EXTERNAL_DISABLED"
            class="ml-2 text-xs font-normal normal-case tracking-normal bg-muted text-muted-foreground px-1.5 py-0.5 rounded"
          >
            暂不可用
          </span>
          <span
            v-else-if="!session.can('external')"
            class="ml-2 text-xs font-normal normal-case tracking-normal bg-muted text-muted-foreground px-1.5 py-0.5 rounded"
          >
            未开通
          </span>
        </h2>

        <!-- Soft-disabled: external timetables temporarily unavailable -->
        <div
          v-if="EXTERNAL_DISABLED"
          class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          外部订阅（教师、教室、课程、行政班等）功能暂不可用。
        </div>

        <!-- Not enabled hint -->
        <div
          v-else-if="!session.can('external')"
          class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          外部订阅（教师、教室、课程、行政班等）功能尚未开通。
        </div>

        <!-- External search UI -->
        <Card v-else>
          <CardContent class="pt-6 space-y-4">
            <!-- Source type tabs -->
            <Tabs v-model="sourceType" @update:model-value="handleTypeChange">
              <TabsList class="grid w-full grid-cols-5">
                <TabsTrigger value="instructor">教师</TabsTrigger>
                <TabsTrigger value="room">教室</TabsTrigger>
                <TabsTrigger value="laboratory">实验室</TabsTrigger>
                <TabsTrigger value="course">课程</TabsTrigger>
                <TabsTrigger value="admin_class">行政班</TabsTrigger>
              </TabsList>
            </Tabs>

            <!-- Department tree + grade filter (admin_class only) -->
            <div v-if="sourceType === 'admin_class'" class="space-y-3">
              <div class="space-y-2">
                <Label>选择学院</Label>
                <DepartmentTreeSelect
                  v-model="selectedDepartment"
                  :departments="departments"
                  @update:model-value="handleDepartmentChange"
                />
              </div>
              <div class="space-y-2">
                <Label>年级</Label>
                <Select v-model="selectedGrade" @update:model-value="handleGradeChange">
                  <SelectTrigger>
                    <SelectValue placeholder="全部年级" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    <SelectItem v-for="y in gradeOptions" :key="y" :value="y">
                      {{ y }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <!-- keyword for admin_class -->
              <div class="relative">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  v-model="keyword"
                  placeholder="输入班级名称关键词（可选）"
                  class="pl-9"
                  @input="debouncedSearch"
                />
              </div>
            </div>

            <!-- Search input for non-admin_class -->
            <div v-if="sourceType !== 'admin_class'" class="relative">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                v-model="keyword"
                :placeholder="searchPlaceholder"
                class="pl-9"
                @input="debouncedSearch"
              />
            </div>

            <!-- Loading -->
            <div v-if="searching" class="flex items-center justify-center py-4">
              <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
              <span class="ml-2 text-sm text-muted-foreground">搜索中...</span>
            </div>

            <!-- Results -->
            <div
              v-if="searchResults.length > 0"
              class="space-y-2 max-h-80 overflow-y-auto"
            >
              <div
                v-for="item in searchResults"
                :key="item.id"
                class="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div class="min-w-0 flex-1">
                  <p class="font-medium text-sm truncate">{{ item.name }}</p>
                  <p
                    v-if="item.extra"
                    class="text-xs text-muted-foreground truncate"
                  >
                    {{ item.extra }}
                  </p>
                </div>
                <Button
                  v-if="isExternalSubscribed(item.id)"
                  variant="outline"
                  size="sm"
                  disabled
                  class="ml-3 shrink-0"
                >
                  <Check class="h-4 w-4 mr-1" />
                  已订阅
                </Button>
                <Button
                  v-else
                  size="sm"
                  class="ml-3 shrink-0 cursor-pointer"
                  :disabled="
                    subscribeFeedback.stateOf(item.id) === 'loading' ||
                    subStore.atLimit
                  "
                  :class="{
                    'bg-green-600 hover:bg-green-600 text-white':
                      subscribeFeedback.stateOf(item.id) === 'success',
                    'bg-destructive hover:bg-destructive text-white':
                      subscribeFeedback.stateOf(item.id) === 'error',
                  }"
                  @click="handleExternalSubscribe(item)"
                >
                  <Loader2
                    v-if="subscribeFeedback.stateOf(item.id) === 'loading'"
                    class="h-4 w-4 animate-spin mr-1"
                  />
                  <Check
                    v-else-if="subscribeFeedback.stateOf(item.id) === 'success'"
                    class="h-4 w-4 mr-1"
                  />
                  <X
                    v-else-if="subscribeFeedback.stateOf(item.id) === 'error'"
                    class="h-4 w-4 mr-1"
                  />
                  <Plus v-else class="h-4 w-4 mr-1" />
                  {{
                    { loading: '订阅中', success: '已订阅', error: '失败' }[
                      subscribeFeedback.stateOf(item.id)
                    ] || '订阅'
                  }}
                </Button>
              </div>
            </div>

            <!-- No results -->
            <p
              v-if="searched && searchResults.length === 0 && !searching"
              class="text-sm text-muted-foreground text-center py-4"
            >
              未找到结果
            </p>

            <!-- Limit warning -->
            <p
              v-if="subStore.atLimit"
              class="text-sm text-amber-600 dark:text-amber-400"
            >
              已达最大订阅数，请先删除不需要的订阅
            </p>
          </CardContent>
        </Card>
      </section>

      <!-- Error message -->
      <div v-if="errorMessage" class="mt-4">
        <Alert variant="destructive">
          <AlertDescription>
            {{ errorMessage }}
            <a
              v-if="needsRepair"
              :href="repairBindHref"
              class="ml-1 underline underline-offset-2"
            >重新绑定重庆大学统一认证账号</a>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Search, Plus, Check, X, Loader2 } from 'lucide-vue-next'
import { useButtonFeedback } from '@/composables/useButtonFeedback'
import { usePersonalSetup } from '@/composables/usePersonalSetup'
import { toast } from 'vue-sonner'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import { useSession } from '@/stores/session'
import api from '@/api'
import type { SearchResult, SourceType, DepartmentNode } from '@/types/api'
import { parseApiError, apiErrorCode } from '@/utils/error'
import { authCquBindUrl } from '@/config/auth'

// 外部课表软禁用(可逆):瑞数化后外部课表无法获取,前端隐藏入口标"暂不可用"。
// 恢复只需把 EXTERNAL_DISABLED 改回 false。绝不在 UI 暴露瑞数/WAF/风控原因。
const EXTERNAL_DISABLED = true

import Navbar from '@/components/Navbar.vue'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import DepartmentTreeSelect from '@/components/DepartmentTreeSelect.vue'

// ── Stores ────────────────────────────────────────────────────────────────────

const subStore = useSubscriptionsStore()
const session = useSession()
const router = useRouter()
const route = useRoute()
const {
  preparing: setupPreparing,
  error: setupError,
  startedThisVisit: setupStartedThisVisit,
  begin: beginPersonalSetup,
} = usePersonalSetup()
const setupPromise = beginPersonalSetup()
const bindHref = computed(() => authCquBindUrl(window.location.origin + route.fullPath))
const repairBindHref = computed(() => authCquBindUrl(
  window.location.origin + route.fullPath,
  { repair: true },
))

// ── Personal subscription options ─────────────────────────────────────────────

interface PersonalOption {
  sourceType: SourceType
  label: string
  description: string
  sourceName: string
}

const personalOptions: PersonalOption[] = [
  {
    sourceType: 'personal_all',
    label: '我的全部课表',
    description: '包含课程和考试',
    sourceName: '我的全部课表',
  },
  {
    sourceType: 'personal_courses',
    label: '我的课程',
    description: '仅包含课程安排',
    sourceName: '我的课程',
  },
  {
    sourceType: 'personal_exams',
    label: '我的考试',
    description: '仅包含考试安排',
    sourceName: '我的考试',
  },
]

const personalFeedback = useButtonFeedback()

function isPersonalSubscribed(sourceType: SourceType): boolean {
  return subStore.subscriptions.some(s => s.source_type === sourceType && s.is_personal)
}

async function handlePersonalSubscribe(opt: PersonalOption) {
  try {
    await personalFeedback.run(async () => {
      await api.createSubscription({
        sourceType: opt.sourceType,
        sourceName: opt.sourceName,
        isPersonal: true,
        // NOTE: do NOT send sourceId — backend pins it to the auth user's id.
      })
      toast.success(`已订阅「${opt.label}」`)
      await subStore.load(true).catch(() => {})
    }, opt.sourceType)
  } catch (err: unknown) {
    toast.error(parseApiError(err, '订阅失败'))
  }
}

// ── External search ───────────────────────────────────────────────────────────

type ExternalSourceType = Extract<
  SourceType,
  'instructor' | 'room' | 'laboratory' | 'course' | 'admin_class'
>

const sourceType = ref<ExternalSourceType>('instructor')
const keyword = ref('')
const selectedDepartment = ref('')
const selectedGrade = ref('all')
const departments = ref<DepartmentNode[]>([])
const searchResults = ref<SearchResult[]>([])
const searching = ref(false)
const searched = ref(false)
const subscribeFeedback = useButtonFeedback()
const errorMessage = ref('')
const needsRepair = ref(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0

const searchPlaceholder = computed(() => {
  const map: Record<ExternalSourceType, string> = {
    instructor: '输入教师姓名或工号',
    room: '输入教室编号',
    laboratory: '输入实验室名称',
    course: '输入课程名称或代码',
    admin_class: '输入班级名称关键词',
  }
  return map[sourceType.value] || '搜索...'
})

const gradeOptions = computed(() => {
  const currentYear = new Date().getFullYear()
  return Array.from({ length: 5 }, (_, i) => String(currentYear - i))
})

function isExternalSubscribed(sourceId: string): boolean {
  return subStore.subscriptions.some(
    s => s.source_id === sourceId && s.source_type === sourceType.value,
  )
}

function clearError() {
  errorMessage.value = ''
  needsRepair.value = false
}

function handleTypeChange() {
  keyword.value = ''
  selectedGrade.value = 'all'
  selectedDepartment.value = ''
  searchResults.value = []
  searched.value = false
  clearError()
  if (sourceType.value === 'admin_class' && departments.value.length === 0) {
    loadDepartments()
  }
}

function handleGradeChange() {
  if (sourceType.value === 'admin_class') {
    doSearch()
  }
}

async function loadDepartments() {
  try {
    const data = await api.getDepartments()
    departments.value = data.departments
  } catch (err: unknown) {
    toast.error(parseApiError(err, '加载院系列表失败'))
  }
}

function debouncedSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  // For non-admin_class, require at least 2 chars
  if (sourceType.value !== 'admin_class' && keyword.value.length < 2) {
    searchResults.value = []
    searched.value = false
    return
  }
  debounceTimer = setTimeout(() => doSearch(), 300)
}

async function handleDepartmentChange(deptId: string) {
  selectedDepartment.value = deptId
  await doSearch()
}

async function doSearch() {
  const seq = ++searchSeq
  searching.value = true
  searched.value = false
  clearError()
  try {
    const gradeParam =
      sourceType.value === 'admin_class' && selectedGrade.value !== 'all'
        ? selectedGrade.value
        : undefined

    const data = await api.searchExternal({
      source_type: sourceType.value,
      keyword: keyword.value,
      department_id:
        sourceType.value === 'admin_class' && selectedDepartment.value
          ? selectedDepartment.value
          : undefined,
      grade: gradeParam,
    })
    if (seq !== searchSeq) return // superseded by a newer search
    searchResults.value = data.results
  } catch (err: unknown) {
    if (seq !== searchSeq) return // superseded — do not clobber live UI state
    const code = apiErrorCode(err)
    if (code === 'CQU_SESSION_INACTIVE') {
      errorMessage.value = '重庆大学统一认证登录状态已失效。'
      needsRepair.value = true
    } else if (code === 'FEATURE_NOT_ENABLED') {
      errorMessage.value = '外部订阅功能未开通'
    } else {
      errorMessage.value = parseApiError(err, '搜索失败')
    }
    searchResults.value = []
  } finally {
    if (seq !== searchSeq) return // superseded — do not flip UI state for a live search
    searching.value = false
    searched.value = true
  }
}

async function handleExternalSubscribe(item: SearchResult) {
  clearError()
  try {
    await subscribeFeedback.run(async () => {
      await api.createSubscription({
        sourceType: sourceType.value,
        sourceId: item.id,
        sourceName: item.name,
      })
      toast.success(`已订阅「${item.name}」`)
      await subStore.load(true).catch(() => {})
    }, item.id)
  } catch (err: unknown) {
    toast.error(parseApiError(err, '订阅失败'))
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await setupPromise
  if (setupStartedThisVisit.value || session.isCquUnbound || setupError.value) return
  try {
    await subStore.load()
  } catch {
    toast.error('加载订阅列表失败')
  }
})

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>
