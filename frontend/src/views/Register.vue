<template>
  <div>
    <Navbar />
    <div class="min-h-screen flex items-center justify-center pt-24 pb-12 px-4">
      <Card class="w-full max-w-sm">
        <CardHeader class="text-center">
          <CardTitle class="text-2xl font-heading">
            {{ phase === 'form' ? '注册' : '正在注册' }}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <VueHcaptcha
            v-if="captchaEnabled"
            ref="hcaptchaRef"
            :sitekey="captchaSitekey"
            size="invisible"
          />

          <!-- Phase: Form -->
          <form v-if="phase === 'form'" @submit.prevent="handleRegister" class="space-y-4">
            <div class="space-y-2">
              <Label for="studentId">统一身份认证号</Label>
              <Input id="studentId" v-model="form.studentId" placeholder="请输入统一身份认证号" />
            </div>
            <div class="space-y-2">
              <Label for="password">密码</Label>
              <Input id="password" v-model="form.password" type="password" placeholder="请输入密码" />
            </div>
            <Alert v-if="errorMessage" variant="destructive">
              <AlertDescription>{{ errorMessage }}</AlertDescription>
            </Alert>
            <Button type="submit" class="w-full cursor-pointer" :disabled="authStore.loading">
              注册
            </Button>
            <p class="text-center text-xs text-muted-foreground">
              已有 Token？
              <router-link to="/login" class="underline hover:text-foreground">去登录</router-link>
            </p>
          </form>

          <!-- Phase: Progress -->
          <div v-else-if="phase === 'progress'" class="space-y-4">
            <ul class="space-y-3">
              <li v-for="(step, i) in steps" :key="i" class="flex items-center gap-3">
                <CircleCheck v-if="currentStep > i" class="h-5 w-5 text-green-500 shrink-0" />
                <Loader2 v-else-if="currentStep === i" class="h-5 w-5 animate-spin text-muted-foreground shrink-0" />
                <Circle v-else class="h-5 w-5 text-muted-foreground/40 shrink-0" />
                <span
                  class="text-sm"
                  :class="currentStep === i ? 'text-foreground' : currentStep > i ? 'text-muted-foreground' : 'text-muted-foreground/40'"
                >
                  {{ step }}
                </span>
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Token Dialog -->
    <Dialog :open="showTokenDialog">
      <DialogContent class="max-w-md" @interactOutside.prevent>
        <DialogHeader>
          <DialogTitle>注册成功</DialogTitle>
          <DialogDescription>请妥善保存你的 Token，以后用它登录</DialogDescription>
        </DialogHeader>
        <div class="bg-muted rounded-md p-3 flex items-center gap-3">
          <code class="flex-1 text-sm font-mono break-all">{{ displayToken }}</code>
          <Button variant="outline" size="sm" @click="copyToken" class="cursor-pointer shrink-0">
            <Check v-if="copied" class="h-4 w-4 text-green-500" />
            <Copy v-else class="h-4 w-4" />
          </Button>
        </div>
        <div v-if="opSaveValue">
          <onepassword-save-button
            data-onepassword-type="login"
            :value="opSaveValue"
            lang="zh-CN"
            padding="none"
          />
        </div>
        <DialogFooter>
          <Button @click="closeTokenDialog" class="cursor-pointer">我已保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <RiskWarning v-model="showRiskWarning" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { Copy, Check, Loader2, Circle, CircleCheck } from 'lucide-vue-next'
import VueHcaptcha from '@hcaptcha/vue3-hcaptcha'
import { encodeOPSaveRequest, activateOPButton } from '@1password/save-button'
import { toast } from 'vue-sonner'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import Navbar from '@/components/Navbar.vue'
import RiskWarning from '@/components/RiskWarning.vue'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()
const authStore = useAuthStore()

const phase = ref('form')
const currentStep = ref(0)
const steps = ['验证凭据', '连接教务系统', '获取 Token']

const form = reactive({ studentId: '', password: '' })
const errorMessage = ref('')
const showTokenDialog = ref(false)
const showRiskWarning = ref(false)
const displayToken = ref('')
const copied = ref(false)
const opSaveValue = ref('')
const captchaEnabled = ref(false)
const captchaSitekey = ref('')
const hcaptchaRef = ref(null)

let stepTimers = []

onMounted(async () => {
  if (!localStorage.getItem('risk_warning_acknowledged')) {
    showRiskWarning.value = true
  }
  try {
    const config = await api.getCaptchaConfig()
    captchaEnabled.value = config.enabled
    captchaSitekey.value = config.sitekey
  } catch {
    // Proceed without captcha — graceful degradation
  }
})

onBeforeUnmount(() => {
  stepTimers.forEach(clearTimeout)
})

function startProgressSteps() {
  phase.value = 'progress'
  currentStep.value = 0
  stepTimers.push(setTimeout(() => { currentStep.value = 1 }, 3000))
  stepTimers.push(setTimeout(() => { currentStep.value = 2 }, 11000))
}

async function handleRegister() {
  errorMessage.value = ''

  if (!form.studentId) { errorMessage.value = '请输入统一身份认证号'; return }
  if (!form.password) { errorMessage.value = '请输入密码'; return }

  let captchaToken = null
  if (captchaEnabled.value && hcaptchaRef.value) {
    try {
      const { response } = await hcaptchaRef.value.executeAsync()
      captchaToken = response
    } catch {
      errorMessage.value = '验证码加载失败，请刷新页面重试'
      return
    }
  }

  startProgressSteps()

  const result = await authStore.register(form.studentId, form.password, captchaToken)

  if (!result.success) {
    phase.value = 'form'
    errorMessage.value = result.error
    stepTimers.forEach(clearTimeout)
    hcaptchaRef.value?.reset()
    return
  }

  currentStep.value = 3
  await authStore.fetchUserInfo()

  displayToken.value = result.token
  opSaveValue.value = encodeOPSaveRequest({
    title: 'CQU Schedule',
    fields: [{ autocomplete: 'current-password', value: result.token }],
    urls: ['https://schedule.cqu.moe'],
  })
  toast.success('注册成功')
  showTokenDialog.value = true
  nextTick(() => activateOPButton())
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(displayToken.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { toast.error('复制失败') }
}

function closeTokenDialog() {
  showTokenDialog.value = false
  router.push('/dashboard')
}
</script>
