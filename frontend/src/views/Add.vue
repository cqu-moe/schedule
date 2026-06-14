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
          <!-- TODO(FE-2): wire up getDepartments() using v2 API (no auth token param) -->
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
                :disabled="subscribeFeedback.stateOf(item.id) === 'loading'"
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
          <p v-if="atLimit" class="text-sm text-amber-600 dark:text-amber-400">
            已达最大订阅数，请先删除不需要的订阅
          </p>
        </CardContent>
      </Card>

      <!-- Error message -->
      <div v-if="errorMessage" class="mt-4">
        <Alert variant="destructive">
          <AlertDescription>
            {{ errorMessage }}
          </AlertDescription>
        </Alert>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// TODO(FE-2): full rewrite — this is a minimal shim that wires up the v2 API
// (searchExternal / getDepartments / createSubscription). Captcha is removed.
// The session caps gating (external flag, sub_limit) is deferred to FE-2.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Search, Plus, Check, X, Loader2 } from 'lucide-vue-next'
import { useButtonFeedback } from '@/composables/useButtonFeedback'
import { toast } from 'vue-sonner'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import api from '@/api'
import type { SearchResult, SourceType } from '@/types/api'
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

const subStore = useSubscriptionsStore()

const sourceType = ref<SourceType>('instructor')
const keyword = ref('')
const selectedDepartment = ref('')
const selectedGrade = ref('all')
const departments = ref<SearchResult[]>([])
const searchResults = ref<SearchResult[]>([])
const searching = ref(false)
const searched = ref(false)
const subscribeFeedback = useButtonFeedback()
const errorMessage = ref('')

// TODO(FE-2): derive atLimit from session.quota('sub_limit')
const atLimit = computed(() => false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

const searchPlaceholder = computed(() => {
  const map: Record<string, string> = {
    instructor: '输入教师姓名或工号',
    room: '输入教室编号',
    laboratory: '输入实验室名称',
    course: '输入课程名称或代码',
    admin_class: '',
  }
  return map[sourceType.value] || '搜索...'
})

function isSubscribed(sourceId: string) {
  return subStore.subscriptions.some(
    s => s.source_id === sourceId && s.source_type === sourceType.value
  )
}

function clearError() {
  errorMessage.value = ''
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
    // TODO(FE-2): DepartmentNode is a tree; DepartmentTreeSelect currently
    // accepts SearchResult[] — update it to DepartmentNode[] in FE-2
    const data = await api.getDepartments()
    departments.value = data.departments as unknown as SearchResult[]
  } catch (err: unknown) {
    toast.error(parseApiError(err, '加载院系列表失败'))
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

async function handleDepartmentChange(deptId: string) {
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
    const data = await api.searchExternal({
      source_type: sourceType.value,
      keyword: sourceType.value === 'admin_class' ? '' : keyword.value,
      department_id: sourceType.value === 'admin_class' ? selectedDepartment.value : undefined,
      grade: gradeParam || undefined,
    })
    searchResults.value = data.results
  } catch (err: unknown) {
    errorMessage.value = parseApiError(err, '搜索失败')
    searchResults.value = []
  } finally {
    searching.value = false
    searched.value = true
  }
}

async function handleSubscribe(item: SearchResult) {
  clearError()
  try {
    await subscribeFeedback.run(async () => {
      await api.createSubscription({
        sourceType: sourceType.value,
        sourceId: item.id,
        sourceName: item.name,
      })
      await subStore.load().catch(() => {})
    }, item.id)
  } catch (err: unknown) {
    toast.error(parseApiError(err, '订阅失败'))
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
