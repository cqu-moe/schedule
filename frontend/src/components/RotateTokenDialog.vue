<template>
  <AlertDialog v-model:open="open">
    <AlertDialogTrigger as-child>
      <slot />
    </AlertDialogTrigger>
    <AlertDialogContent>
      <!-- Loading state -->
      <template v-if="step === 'loading'">
        <AlertDialogHeader>
          <AlertDialogTitle>轮换认证 Token</AlertDialogTitle>
        </AlertDialogHeader>
        <div class="flex items-center justify-center py-8">
          <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer" @click="handleClose">取消</AlertDialogCancel>
        </AlertDialogFooter>
      </template>

      <!-- Page 1: Display new token -->
      <template v-if="step === 'display'">
        <AlertDialogHeader>
          <AlertDialogTitle>轮换认证 Token</AlertDialogTitle>
          <AlertDialogDescription>
            请妥善保存新 Token，关闭后将无法再次查看。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="space-y-3 py-2">
          <div class="bg-muted rounded px-3 py-2">
            <code class="text-sm break-all font-mono">{{ newToken }}</code>
          </div>
          <div class="flex gap-2 items-center">
            <Button
              variant="outline"
              size="sm"
              class="cursor-pointer"
              @click="copyToken"
            >
              <Check v-if="copied" class="h-4 w-4 mr-1.5" />
              <Copy v-else class="h-4 w-4 mr-1.5" />
              {{ copied ? '已复制' : '复制' }}
            </Button>
            <onepassword-save-button v-if="opSaveValue" :value="opSaveValue" />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer" @click="handleClose">取消</AlertDialogCancel>
          <Button class="cursor-pointer" @click="step = 'confirm'">我已保存，下一步</Button>
        </AlertDialogFooter>
      </template>

      <!-- Page 2: Blind confirm -->
      <template v-if="step === 'confirm'">
        <AlertDialogHeader>
          <AlertDialogTitle>确认新 Token</AlertDialogTitle>
          <AlertDialogDescription>
            请输入刚才保存的新 Token 以完成轮换。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="space-y-2 py-2">
          <Input
            v-model="confirmInput"
            placeholder="请输入新 Token"
            :class="{ 'border-destructive': confirmError }"
          />
          <p v-if="confirmError" class="text-sm text-destructive">{{ confirmError }}</p>
        </div>
        <AlertDialogFooter>
          <Button variant="outline" class="cursor-pointer" @click="step = 'display'">返回</Button>
          <Button
            class="cursor-pointer"
            :disabled="!confirmInput || confirming"
            @click="handleConfirm"
          >
            <Loader2 v-if="confirming" class="h-4 w-4 mr-1.5 animate-spin" />
            确认轮换
          </Button>
        </AlertDialogFooter>
      </template>

      <!-- Error state -->
      <template v-if="step === 'error'">
        <AlertDialogHeader>
          <AlertDialogTitle>轮换失败</AlertDialogTitle>
          <AlertDialogDescription>{{ prepareError }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer" @click="handleClose">关闭</AlertDialogCancel>
        </AlertDialogFooter>
      </template>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Copy, Check, Loader2 } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { buildOPSaveValue } from '@/utils/opSave'
import { parseApiError } from '@/utils/error'
import { toast } from 'vue-sonner'
import api from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const authStore = useAuthStore()

const open = ref(false)
const step = ref<'loading' | 'display' | 'confirm' | 'error'>('loading')
const newToken = ref('')
const opSaveValue = ref('')
const copied = ref(false)
const confirmInput = ref('')
const confirmError = ref('')
const confirming = ref(false)
const prepareError = ref('')

watch(open, async (isOpen) => {
  if (!isOpen) return
  step.value = 'loading'
  newToken.value = ''
  opSaveValue.value = ''
  copied.value = false
  confirmInput.value = ''
  confirmError.value = ''
  prepareError.value = ''

  try {
    const result = await api.rotateTokenPrepare(authStore.token)
    newToken.value = result.new_token
    opSaveValue.value = buildOPSaveValue(result.new_token)
    step.value = 'display'
  } catch (error) {
    prepareError.value = parseApiError(error, '生成新 Token 失败')
    step.value = 'error'
  }
})

async function copyToken() {
  try {
    await navigator.clipboard.writeText(newToken.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // ignore
  }
}

async function handleConfirm() {
  confirming.value = true
  confirmError.value = ''
  try {
    const result = await api.rotateTokenConfirm(authStore.token, confirmInput.value)
    authStore.token = result.calendar_token
    localStorage.setItem('calendar_token', result.calendar_token)
    await authStore.fetchUserInfo()
    toast.success('Token 已轮换')
    open.value = false
  } catch (error) {
    confirmError.value = parseApiError(error, '确认失败')
  } finally {
    confirming.value = false
  }
}

function handleClose() {
  open.value = false
}
</script>
