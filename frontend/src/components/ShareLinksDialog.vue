<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="max-w-lg max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>管理共享链接</DialogTitle>
        <DialogDescription>
          为「{{ subscription.source_name }}」配置共享链接，允许他人访问此课表。
        </DialogDescription>
      </DialogHeader>

      <!-- Link list -->
      <div class="space-y-3 mt-2">
        <div
          v-for="link in localLinks"
          :key="link.id"
          class="border rounded-md p-3 space-y-2"
        >
          <!-- Link header: label + badges -->
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium">
              {{ link.label ?? (link.is_default ? '默认链接' : '未命名') }}
            </span>
            <Badge v-if="link.is_default" variant="secondary" class="text-xs">默认</Badge>
            <Badge
              v-for="fmt in link.formats"
              :key="fmt"
              variant="outline"
              class="text-xs"
            >
              {{ FORMAT_LABELS[fmt] }}
            </Badge>
          </div>

          <!-- Copy buttons: one per format -->
          <div class="flex flex-wrap gap-1.5">
            <Button
              v-for="fmt in link.formats"
              :key="fmt"
              variant="outline"
              size="sm"
              class="cursor-pointer h-7 text-xs px-2"
              :class="{
                'bg-green-600 hover:bg-green-600 text-white border-transparent':
                  copyFeedback.stateOf(`${link.id}:${fmt}`) === 'success',
              }"
              @click="handleCopy(link, fmt)"
            >
              <Check
                v-if="copyFeedback.stateOf(`${link.id}:${fmt}`) === 'success'"
                class="h-3 w-3 mr-1"
              />
              <Copy v-else class="h-3 w-3 mr-1" />
              {{ FORMAT_SHORT_LABELS[fmt] }}
            </Button>
          </div>

          <!-- Actions row -->
          <div class="flex items-center gap-1.5 pt-1">
            <!-- Rotate token -->
            <Button
              variant="outline"
              size="sm"
              class="cursor-pointer h-7 text-xs px-2"
              @click="openRotateConfirm(link)"
            >
              <RotateCw class="h-3 w-3 mr-1" />
              轮换
            </Button>

            <!-- Edit (share links only) -->
            <Button
              v-if="!link.is_default"
              variant="outline"
              size="sm"
              class="cursor-pointer h-7 text-xs px-2"
              @click="openEditLink(link)"
            >
              <Pencil class="h-3 w-3 mr-1" />
              编辑
            </Button>

            <!-- Delete (share links only) -->
            <Button
              v-if="!link.is_default"
              variant="outline"
              size="sm"
              class="cursor-pointer h-7 text-xs px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
              @click="openDeleteConfirm(link)"
            >
              <Trash2 class="h-3 w-3 mr-1" />
              删除
            </Button>

            <!-- Default link note -->
            <span
              v-if="link.is_default"
              class="text-xs text-muted-foreground ml-1"
            >
              默认链接 · 不可删除 / 不可改格式
            </span>
          </div>
        </div>

        <!-- Empty state (no links at all, shouldn't normally happen) -->
        <p v-if="localLinks.length === 0" class="text-sm text-muted-foreground text-center py-4">
          暂无链接
        </p>
      </div>

      <!-- Share limit usage + create button -->
      <div class="flex items-center justify-between mt-4 pt-3 border-t">
        <span class="text-xs text-muted-foreground">
          共享链接
          <template v-if="session.quota('share_limit') !== null">
            {{ subStore.shareLinkCount }} / {{ session.quota('share_limit') }}
          </template>
          <template v-else>
            {{ subStore.shareLinkCount }} / 无限
          </template>
        </span>

        <Button
          v-if="session.can('share')"
          variant="outline"
          size="sm"
          class="cursor-pointer"
          :disabled="subStore.atShareLimit"
          :title="subStore.atShareLimit ? '共享链接数量已达上限' : undefined"
          @click="openCreateForm"
        >
          <Plus class="h-4 w-4 mr-1.5" />
          新建共享链接
        </Button>
        <span
          v-else
          class="text-xs text-muted-foreground"
        >
          共享链接未开通
        </span>
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
    <DialogContent class="max-w-sm">
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
              class="cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors"
              :class="
                linkForm.formats.includes(fmt)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-foreground border-input hover:bg-accent'
              "
              :aria-pressed="linkForm.formats.includes(fmt)"
              @click="toggleFormat(fmt)"
            >
              {{ FORMAT_LABELS[fmt] }}
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
import { ref, reactive, watch } from 'vue'
import {
  Copy,
  Check,
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

const FORMAT_LABELS: Record<LinkFormat, string> = {
  ics: '日历订阅 (ICS)',
  web: '网页查看',
  data_json: '格式化 JSON',
  origin_json: '原始 JSON',
  csv: 'CSV',
}

const FORMAT_SHORT_LABELS: Record<LinkFormat, string> = {
  ics: 'ICS',
  web: '网页',
  data_json: '课表 JSON',
  origin_json: '原始 JSON',
  csv: 'CSV',
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

// Sync when the subscription prop changes (e.g., store reloads)
watch(
  () => props.subscription.links,
  (links) => {
    localLinks.value = [...links]
  },
)

// ── Button feedback ───────────────────────────────────────────────────────────

const copyFeedback = useButtonFeedback()

// ── Copy ──────────────────────────────────────────────────────────────────────

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
  formats: ['ics', 'web'],
  submitting: false,
})

const linkFormError = ref<string | null>(null)

function openCreateForm() {
  linkForm.editingId = null
  linkForm.label = ''
  linkForm.formats = ['ics', 'web']
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

// ── Dialog open/close ─────────────────────────────────────────────────────────

function handleOpenChange(v: boolean) {
  emit('update:open', v)
}
</script>
