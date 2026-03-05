<template>
  <div class="min-h-screen bg-background">
    <Navbar />

    <div class="max-w-2xl mx-auto px-4 pt-28 pb-12">
      <h1 class="text-2xl font-heading font-semibold mb-6">添加新订阅</h1>

      <!-- Search Section -->
      <Card class="mb-6">
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
          </div>

          <!-- Search input -->
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
          <div v-if="searchResults.length > 0" class="space-y-2 max-h-80 overflow-y-auto">
            <div
              v-for="item in searchResults"
              :key="item.id"
              class="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
            >
              <div class="min-w-0 flex-1">
                <p class="font-medium text-sm truncate">{{ item.name }}</p>
                <p v-if="item.extra" class="text-xs text-muted-foreground truncate">{{ item.extra }}</p>
              </div>
              <Button
                v-if="isSubscribed(item.id)"
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
                :disabled="subscribeFeedback.stateOf(item.id) === 'loading' || subStore.subscriptions.length >= subStore.max"
                :class="{
                  'bg-green-600 hover:bg-green-600 text-white': subscribeFeedback.stateOf(item.id) === 'success',
                  'bg-destructive hover:bg-destructive text-white': subscribeFeedback.stateOf(item.id) === 'error'
                }"
                @click="handleSubscribe(item)"
              >
                <Loader2 v-if="subscribeFeedback.stateOf(item.id) === 'loading'" class="h-4 w-4 animate-spin mr-1" />
                <Check v-else-if="subscribeFeedback.stateOf(item.id) === 'success'" class="h-4 w-4 mr-1" />
                <X v-else-if="subscribeFeedback.stateOf(item.id) === 'error'" class="h-4 w-4 mr-1" />
                <Plus v-else class="h-4 w-4 mr-1" />
                {{ { loading: '订阅中', success: '已订阅', error: '失败' }[subscribeFeedback.stateOf(item.id)] || '订阅' }}
              </Button>
            </div>
          </div>

          <!-- No results -->
          <p v-if="searched && searchResults.length === 0 && !searching" class="text-sm text-muted-foreground text-center py-4">
            未找到结果
          </p>

          <!-- Limit warning -->
          <p v-if="subStore.subscriptions.length >= subStore.max" class="text-sm text-amber-600 dark:text-amber-400">
            已达最大订阅数 ({{ subStore.max }})，请先删除不需要的订阅
          </p>

          <VueHcaptcha
            v-if="captchaEnabled"
            ref="hcaptchaRef"
            :sitekey="captchaSitekey"
            size="invisible"
          />
        </CardContent>
      </Card>

      <!-- Error message -->
      <div v-if="errorMessage" class="mt-4">
        <Alert variant="destructive">
          <AlertDescription>
            {{ errorMessage }}
            <Button
              v-if="isTokenExpired"
              variant="link"
              size="sm"
              class="px-0 text-destructive cursor-pointer"
              @click="$router.push('/login')"
            >
              重新登录
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Search, Plus, Check, X, Loader2 } from 'lucide-vue-next'
import { useButtonFeedback } from '@/composables/useButtonFeedback'
import { useCaptcha } from '@/composables/useCaptcha'
import { toast } from 'vue-sonner'
import VueHcaptcha from '@hcaptcha/vue3-hcaptcha'
import { useAuthStore } from '@/stores/auth'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import api from '@/api'
import Navbar from '@/components/Navbar.vue'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseApiError } from '@/utils/error'
import DepartmentTreeSelect from '@/components/DepartmentTreeSelect.vue'

const authStore = useAuthStore()
const subStore = useSubscriptionsStore()
const { hcaptchaRef, captchaEnabled, captchaSitekey, getCaptchaToken } = useCaptcha()

const sourceType = ref('instructor')
const keyword = ref('')
const selectedDepartment = ref('')
const selectedGrade = ref('all')
const departments = ref([])
const searchResults = ref([])
const searching = ref(false)
const searched = ref(false)
const subscribeFeedback = useButtonFeedback()
const errorMessage = ref('')
const isTokenExpired = ref(false)

let debounceTimer = null

const searchPlaceholder = computed(() => {
  const map = {
    instructor: '输入教师姓名或工号',
    room: '输入教室编号',
    laboratory: '输入实验室名称',
    course: '输入课程名称或代码',
    admin_class: '',
  }
  return map[sourceType.value] || '搜索...'
})

function isSubscribed(sourceId) {
  return subStore.subscriptions.some(
    s => s.source_id === sourceId && s.source_type === sourceType.value
  )
}

function handleApiError(err, fallbackMessage) {
  const msg = parseApiError(err, fallbackMessage)
  const resp = err?.response
  if (resp?.status === 401 || /token expired/i.test(msg)) {
    errorMessage.value = msg
    isTokenExpired.value = true
  } else {
    toast.error(msg)
  }
}

function clearError() {
  errorMessage.value = ''
  isTokenExpired.value = false
}

const gradeOptions = computed(() => {
  const currentYear = new Date().getFullYear()
  return Array.from({ length: 5 }, (_, i) => String(currentYear - i))
})

function handleTypeChange() {
  keyword.value = ''
  selectedGrade.value = 'all'
  searchResults.value = []
  searched.value = false
  clearError()
  if (sourceType.value === 'admin_class' && departments.value.length === 0) {
    loadDepartments()
  }
}

function handleGradeChange() {
  if (selectedDepartment.value) {
    doSearch()
  }
}

async function loadDepartments() {
  try {
    const data = await api.getDepartments(authStore.token)
    departments.value = data.departments
  } catch (err) {
    handleApiError(err, '加载院系列表失败')
  }
}

function debouncedSearch() {
  clearTimeout(debounceTimer)
  if (keyword.value.length < 2) {
    searchResults.value = []
    searched.value = false
    return
  }
  debounceTimer = setTimeout(() => doSearch(), 300)
}

async function handleDepartmentChange(deptId) {
  selectedDepartment.value = deptId
  await doSearch()
}

async function doSearch() {
  searching.value = true
  searched.value = false
  clearError()
  try {
    const gradeParam = sourceType.value === 'admin_class' && selectedGrade.value !== 'all'
      ? selectedGrade.value : ''
    const data = await api.searchSchedule(
      authStore.token,
      sourceType.value,
      sourceType.value === 'admin_class' ? '' : keyword.value,
      sourceType.value === 'admin_class' ? selectedDepartment.value : '',
      gradeParam,
    )
    searchResults.value = data.results
  } catch (err) {
    handleApiError(err, '搜索失败')
    searchResults.value = []
  } finally {
    searching.value = false
    searched.value = true
  }
}

async function handleSubscribe(item) {
  clearError()

  let captchaToken = null
  try {
    captchaToken = await getCaptchaToken()
  } catch {
    errorMessage.value = '验证码加载失败，请刷新页面重试'
    return
  }

  try {
    await subscribeFeedback.run(async () => {
      await api.createSubscription(
        authStore.token, sourceType.value, item.id, item.name, captchaToken
      )
      await subStore.load().catch(() => {})
    }, item.id)
  } catch (err) {
    handleApiError(err, '订阅失败')
  } finally {
    hcaptchaRef.value?.reset()
  }
}

onMounted(async () => {
  try {
    await subStore.load()
  } catch {
    toast.error('加载订阅列表失败')
  }
})

onBeforeUnmount(() => {
  clearTimeout(debounceTimer)
})
</script>
