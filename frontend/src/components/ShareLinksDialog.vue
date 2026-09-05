<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="max-h-[90vh] overflow-hidden p-0 sm:max-w-[96vw] lg:max-w-6xl">
      <div class="flex max-h-[90vh] flex-col">
        <DialogHeader class="border-b px-5 py-4 sm:px-6">
          <DialogTitle>管理共享链接</DialogTitle>
          <DialogDescription>
            「{{ subscription.source_name }}」的共享链接。
          </DialogDescription>
        </DialogHeader>

        <div class="overflow-y-auto px-5 py-5 sm:px-6">
          <div class="overflow-x-auto rounded-md border">
            <table class="w-full min-w-[720px] table-fixed border-collapse text-sm">
              <colgroup>
                <col class="w-[150px] sm:w-[180px]">
                <col v-for="fmt in TABLE_FORMATS" :key="fmt" class="w-[74px]">
                <col class="w-[164px]">
              </colgroup>
              <thead class="bg-muted/60 text-muted-foreground">
                <tr class="border-b">
                  <th class="sticky left-0 z-20 border-r bg-muted px-4 py-3 text-left font-medium">链接</th>
                  <th
                    v-for="fmt in TABLE_FORMATS"
                    :key="fmt"
                    class="px-2 py-3 text-center font-medium"
                    :title="FORMAT_META[fmt].label"
                  >
                    <span aria-hidden="true">{{ FORMAT_META[fmt].headerLabel }}</span>
                    <span class="sr-only">{{ FORMAT_META[fmt].label }}</span>
                  </th>
                  <th class="sticky right-0 z-20 border-l bg-muted px-4 py-3 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="link in localLinks"
                  :key="link.id"
                  class="border-b last:border-b-0"
                >
                  <td class="sticky left-0 z-10 border-r bg-background px-4 py-3 align-middle">
                    <div class="flex min-w-0 items-center gap-2">
                      <span class="truncate font-medium">
                        {{ link.label ?? (link.is_default ? '默认链接' : '未命名') }}
                      </span>
                      <Badge v-if="link.is_default" variant="secondary" class="shrink-0 text-xs">默认</Badge>
                    </div>
                    <p class="mt-1 text-xs text-muted-foreground">
                      {{ link.is_default ? '不可删除 / 不可改格式' : '额外共享链接' }}
                    </p>
                  </td>

                  <td
                    v-for="fmt in TABLE_FORMATS"
                    :key="fmt"
                    class="px-2 py-3 text-center align-middle"
                  >
                    <Button
                      v-if="hasFormat(link, fmt)"
                      variant="outline"
                      size="icon"
                      class="h-11 w-11 cursor-pointer"
                      :class="{
                        'border-transparent bg-green-600 text-white hover:bg-green-600 hover:text-white':
                          copyFeedback.stateOf(`${link.id}:${fmt}`) === 'success',
                      }"
                      :title="`复制 ${FORMAT_META[fmt].label}`"
                      :aria-label="`复制 ${FORMAT_META[fmt].label}`"
                      @click="handleCopy(link, fmt)"
                    >
                      <Check
                        v-if="copyFeedback.stateOf(`${link.id}:${fmt}`) === 'success'"
                        class="h-4 w-4"
                      />
                      <Copy v-else class="h-4 w-4" />
                      <span class="sr-only">复制 {{ FORMAT_META[fmt].shortLabel }}</span>
                    </Button>
                    <span
                      v-else
                      class="inline-flex h-11 w-11 items-center justify-center text-muted-foreground/70"
                      :title="`${FORMAT_META[fmt].label}不可用`"
                    >
                      <Minus aria-hidden="true" class="h-4 w-4" />
                      <span class="sr-only">{{ FORMAT_META[fmt].label }}不可用</span>
                    </span>
                  </td>

                  <td class="sticky right-0 z-10 border-l bg-background px-4 py-3 align-middle">
                    <div class="flex justify-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        class="h-11 w-11 cursor-pointer"
                        title="轮换"
                        aria-label="轮换"
                        @click="openRotateConfirm(link)"
                      >
                        <RotateCw class="h-4 w-4" />
                        <span class="sr-only">轮换</span>
                      </Button>

                      <Button
                        variant="outline"
                        size="icon"
                        class="h-11 w-11 cursor-pointer disabled:border-dashed disabled:bg-muted/20 disabled:text-muted-foreground/35 disabled:opacity-100"
                        title="修改"
                        aria-label="修改"
                        :disabled="link.is_default"
                        @click="openEditLink(link)"
                      >
                        <Pencil class="h-4 w-4" />
                        <span class="sr-only">修改</span>
                      </Button>

                      <Button
                        variant="outline"
                        size="icon"
                        class="h-11 w-11 cursor-pointer disabled:border-dashed disabled:bg-muted/20 disabled:text-muted-foreground/35 disabled:opacity-100"
                        :class="{
                          'text-destructive hover:bg-destructive/10 hover:text-destructive': !link.is_default,
                        }"
                        title="删除"
                        aria-label="删除"
                        :disabled="link.is_default"
                        @click="openDeleteConfirm(link)"
                      >
                        <Trash2 class="h-4 w-4" />
                        <span class="sr-only">删除</span>
                      </Button>
                    </div>
                  </td>
                </tr>
                <tr v-if="localLinks.length === 0">
                  <td colspan="7" class="px-4 py-8 text-center text-muted-foreground">
                    暂无链接
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Share limit usage + create button -->
        <div class="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p class="text-sm font-medium tabular-nums">{{ shareFooterText }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ shareFooterHint }}</p>
          </div>

          <Button
            v-if="session.can('share')"
            variant="outline"
            size="sm"
            class="h-11 cursor-pointer"
            :disabled="subStore.atShareLimit"
            :title="subStore.atShareLimit ? '共享链接数量已达上限' : undefined"
            @click="openCreateForm"
          >
            <Plus class="h-4 w-4" />
            新建共享链接
          </Button>
          <span
            v-else
            class="text-sm text-muted-foreground"
          >
            共享链接未开通
          </span>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <!-- Rotate token confirm -->
  <AlertDialog
    :open="rotateConfirm.open"
    @update:open="v => { if (!v) rotateConfirm.open = false }"
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认轮换链接 Token</AlertDialogTitle>
        <AlertDialogDescription>
          轮换后旧链接立即失效，日历客户端需重新订阅新链接。确定要继续吗？
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel class="cursor-pointer" @click="rotateConfirm.open = false">
          取消
        </AlertDialogCancel>
        <AlertDialogAction
          class="cursor-pointer bg-destructive text-white hover:bg-destructive/90"
          @click="handleRotate"
        >
          轮换
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <!-- Delete link confirm -->
  <AlertDialog
    :open="deleteConfirm.open"
    @update:open="v => { if (!v) deleteConfirm.open = false }"
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认删除共享链接</AlertDialogTitle>
        <AlertDialogDescription>
          删除后该链接立即失效，使用此链接的订阅将无法访问。确定删除吗？
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel class="cursor-pointer" @click="deleteConfirm.open = false">
          取消
        </AlertDialogCancel>
        <AlertDialogAction
          class="cursor-pointer bg-destructive text-white hover:bg-destructive/90"
          @click="handleDeleteLink"
        >
          删除
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <!-- Create / Edit link dialog -->
  <Dialog
    :open="linkForm.open"
    @update:open="v => { if (!v) closeLinkForm() }"
  >
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ linkForm.editingId ? '编辑共享链接' : '新建共享链接' }}</DialogTitle>
        <DialogDescription>
          {{ linkForm.editingId ? '修改链接标签或允许的格式。' : '创建一个新的共享链接。' }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 mt-2">
        <!-- Label input -->
        <div class="space-y-1.5">
          <Label for="link-label">标签（可选，最多 100 字符）</Label>
          <Input
            id="link-label"
            v-model="linkForm.label"
            placeholder="例：分享给同学"
            maxlength="100"
          />
        </div>

        <!-- Format multi-select via toggle badges -->
        <div class="space-y-1.5">
          <Label>允许的格式（至少选择一项）</Label>
          <div class="flex flex-wrap gap-2 mt-1">
            <button
              v-for="fmt in ALL_FORMATS"
              :key="fmt"
              type="button"
              :data-format="fmt"
              class="min-h-11 cursor-pointer rounded-md border px-3 py-2 text-sm transition-colors"
              :class="
                linkForm.formats.includes(fmt)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-foreground border-input hover:bg-accent'
              "
              :aria-pressed="linkForm.formats.includes(fmt)"
              @click="toggleFormat(fmt)"
            >
              {{ FORMAT_META[fmt].label }}
            </button>
          </div>
          <p v-if="linkFormError" class="text-xs text-destructive">{{ linkFormError }}</p>
        </div>
      </div>

      <DialogFooter class="mt-4">
        <Button
          variant="outline"
          class="cursor-pointer"
          @click="closeLinkForm"
        >
          取消
        </Button>
        <Button
          class="cursor-pointer"
          :disabled="linkForm.submitting || linkForm.formats.length === 0"
          @click="handleSubmitLinkForm"
        >
          <Loader2 v-if="linkForm.submitting" class="h-4 w-4 mr-1.5 animate-spin" />
          {{ linkForm.editingId ? '保存' : '创建' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch } from 'vue'
import {
  Copy,
  Check,
  Minus,
  Trash2,
  RotateCw,
  Pencil,
  Plus,
  Loader2,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useButtonFeedback } from '@/composables/useButtonFeedback'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import { useSession } from '@/stores/session'
import { useConfigStore } from '@/stores/config'
import { buildLinkUrl } from '@/utils/links'
import { parseApiError, apiErrorCode } from '@/utils/error'
import type { Subscription, CalendarLink, LinkFormat } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
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
import api from '@/api'

// ── Props & emits ─────────────────────────────────────────────────────────────

const props = defineProps<{
  open: boolean
  subscription: Subscription
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** Emitted after any mutation so Dashboard can refresh the list. */
  changed: []
}>()

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_FORMATS: LinkFormat[] = ['ics', 'web', 'data_json', 'origin_json', 'csv']
const TABLE_FORMATS: LinkFormat[] = ['ics', 'web', 'data_json', 'origin_json', 'csv']

const DEFAULT_CREATE_FORMATS: LinkFormat[] = ['ics', 'web']

const FORMAT_META: Record<LinkFormat, { label: string; headerLabel: string; shortLabel: string }> = {
  ics: {
    label: '日历订阅 (ICS)',
    headerLabel: '订阅',
    shortLabel: 'ICS',
  },
  web: {
    label: '日历网页查看',
    headerLabel: '网页',
    shortLabel: '网页',
  },
  data_json: {
    label: 'JSON',
    headerLabel: 'JSON',
    shortLabel: 'JSON',
  },
  origin_json: {
    label: '原始 JSON',
    headerLabel: '原始',
    shortLabel: '原始 JSON',
  },
  csv: {
    label: 'CSV',
    headerLabel: 'CSV',
    shortLabel: 'CSV',
  },
}

// ── Stores ────────────────────────────────────────────────────────────────────

const subStore = useSubscriptionsStore()
const session = useSession()
const configStore = useConfigStore()

// ── Local link state ──────────────────────────────────────────────────────────

/**
 * A local reactive copy of the subscription's links so mutations update
 * the dialog immediately without waiting for a full store reload.
 */
const localLinks = ref<CalendarLink[]>([...props.subscription.links])

const customLinkCount = computed(() => localLinks.value.filter(link => !link.is_default).length)
const shareLimit = computed(() => session.quota('share_limit'))
const shareFooterText = computed(() => {
  if (shareLimit.value === null) return `共享链接 ${subStore.shareLinkCount} / 无限`
  return `共享链接 ${subStore.shareLinkCount} / ${shareLimit.value}`
})
const shareFooterHint = computed(() => {
  if (!session.can('share')) return '默认链接仍可复制使用，额外共享链接需开通后创建。'
  if (subStore.atShareLimit) return '已达到账号共享链接上限，删除旧链接后才能新建。'
  if (customLinkCount.value === 0) return '本课表还没有额外共享链接。'
  return `本课表 ${customLinkCount.value} 个额外共享链接；额度按账号统计。`
})

// Re-seed localLinks when the store-derived subscription prop changes identity
// (covers store reloads after mutation AND reopen for a different subscription).
// In-place localLinks mutations remain the optimistic layer; the reload reconciles.
watch(
  () => props.subscription.links,
  (links) => {
    localLinks.value = [...links]
  },
)

// ── Button feedback ───────────────────────────────────────────────────────────

const copyFeedback = useButtonFeedback()

// ── Copy ──────────────────────────────────────────────────────────────────────

function hasFormat(link: CalendarLink, fmt: LinkFormat): boolean {
  return link.formats.includes(fmt)
}

async function handleCopy(link: CalendarLink, fmt: LinkFormat) {
  const url = buildLinkUrl(configStore.publicUrl, link.token, fmt)
  try {
    await copyFeedback.run(async () => {
      await navigator.clipboard.writeText(url)
    }, `${link.id}:${fmt}`)
  } catch {
    toast.error('复制失败，请手动复制链接')
  }
}

// ── Rotate confirm ────────────────────────────────────────────────────────────

const rotateConfirm = reactive<{ open: boolean; linkId: string | null }>({
  open: false,
  linkId: null,
})

function openRotateConfirm(link: CalendarLink) {
  rotateConfirm.linkId = link.id
  rotateConfirm.open = true
}

async function handleRotate() {
  if (!rotateConfirm.linkId) return
  const lid = rotateConfirm.linkId
  rotateConfirm.open = false
  try {
    const result = await api.rotateLink(props.subscription.id, lid)
    // Update the token in place
    const idx = localLinks.value.findIndex(l => l.id === lid)
    if (idx !== -1) {
      localLinks.value[idx] = { ...localLinks.value[idx], token: result.token }
    }
    toast.success('已轮换')
    emit('changed')
    subStore.load(true).catch(() => {})
  } catch (error) {
    toast.error(parseApiError(error, '轮换失败'))
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────────

const deleteConfirm = reactive<{ open: boolean; linkId: string | null }>({
  open: false,
  linkId: null,
})

function openDeleteConfirm(link: CalendarLink) {
  deleteConfirm.linkId = link.id
  deleteConfirm.open = true
}

async function handleDeleteLink() {
  if (!deleteConfirm.linkId) return
  const lid = deleteConfirm.linkId
  deleteConfirm.open = false
  try {
    await api.deleteLink(props.subscription.id, lid)
    localLinks.value = localLinks.value.filter(l => l.id !== lid)
    toast.success('共享链接已删除')
    emit('changed')
    subStore.load(true).catch(() => {})
  } catch (error) {
    toast.error(parseApiError(error, '删除失败'))
  }
}

// ── Create / Edit form ────────────────────────────────────────────────────────

interface LinkFormState {
  open: boolean
  editingId: string | null
  label: string
  formats: LinkFormat[]
  submitting: boolean
}

const linkForm = reactive<LinkFormState>({
  open: false,
  editingId: null,
  label: '',
  formats: [...DEFAULT_CREATE_FORMATS],
  submitting: false,
})

const linkFormError = ref<string | null>(null)

function openCreateForm() {
  linkForm.editingId = null
  linkForm.label = ''
  linkForm.formats = [...DEFAULT_CREATE_FORMATS]
  linkFormError.value = null
  linkForm.open = true
}

function openEditLink(link: CalendarLink) {
  linkForm.editingId = link.id
  linkForm.label = link.label ?? ''
  linkForm.formats = [...link.formats]
  linkFormError.value = null
  linkForm.open = true
}

function closeLinkForm() {
  linkForm.open = false
}

function toggleFormat(fmt: LinkFormat) {
  const idx = linkForm.formats.indexOf(fmt)
  if (idx === -1) {
    linkForm.formats.push(fmt)
  } else {
    linkForm.formats.splice(idx, 1)
  }
  linkFormError.value = null
}

async function handleSubmitLinkForm() {
  if (linkForm.formats.length === 0) {
    linkFormError.value = '至少选择一种格式'
    return
  }
  linkFormError.value = null
  linkForm.submitting = true

  const labelValue = linkForm.label.trim() || undefined

  try {
    if (linkForm.editingId) {
      // PATCH
      const updated = await api.patchLink(props.subscription.id, linkForm.editingId, {
        label: labelValue ?? null,
        formats: linkForm.formats,
      })
      const idx = localLinks.value.findIndex(l => l.id === linkForm.editingId)
      if (idx !== -1) {
        localLinks.value[idx] = updated
      }
      toast.success('共享链接已更新')
    } else {
      // POST
      const created = await api.createLink(props.subscription.id, {
        label: labelValue,
        formats: linkForm.formats,
      })
      localLinks.value.push(created)
      toast.success('共享链接已创建')
    }
    closeLinkForm()
    emit('changed')
    subStore.load(true).catch(() => {})
  } catch (error) {
    const code = apiErrorCode(error)
    if (code === 'QUOTA_EXCEEDED') {
      linkFormError.value = '共享链接数量已达上限'
    } else if (code === 'INVALID_FORMATS') {
      linkFormError.value = '格式选择无效，请重新选择'
    } else if (code === 'FEATURE_NOT_ENABLED') {
      linkFormError.value = '共享链接功能未开通'
    } else {
      linkFormError.value = parseApiError(error, '操作失败')
    }
  } finally {
    linkForm.submitting = false
  }
}

// ── Close-reset ───────────────────────────────────────────────────────────────

// Reset transient inner-dialog open flags when the outer dialog closes so they
// don't linger and reappear the next time the outer dialog is opened.
watch(
  () => props.open,
  (open) => {
    if (!open) {
      rotateConfirm.open = false
      deleteConfirm.open = false
      linkForm.open = false
    }
  },
)

// ── Dialog open/close ─────────────────────────────────────────────────────────

function handleOpenChange(v: boolean) {
  emit('update:open', v)
}
</script>
