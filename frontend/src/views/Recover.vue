<template>
  <div>
    <Navbar />
    <div class="min-h-screen flex items-center justify-center pt-24 pb-12 px-4">
      <Card class="w-full max-w-sm">
        <CardHeader class="text-center">
          <CardTitle class="text-2xl font-heading">找回 Token</CardTitle>
        </CardHeader>
        <CardContent>
          <VueHcaptcha
            v-if="captchaEnabled"
            ref="hcaptchaRef"
            :sitekey="captchaSitekey"
            size="invisible"
          />

          <!-- Step 1: Credentials form -->
          <form v-if="step === 'form'" @submit.prevent="handleRecover" class="space-y-4">
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
            <Button type="submit" class="w-full cursor-pointer" :disabled="loading">
              <Loader2 v-if="loading" class="h-4 w-4 animate-spin mr-2" />
              找回
            </Button>
            <p class="text-center text-xs text-muted-foreground">
              想起来了？
              <router-link to="/login" class="underline hover:text-foreground">去登录</router-link>
            </p>
          </form>

          <!-- Step 2: Password mismatch — offer Worker verification -->
          <div v-else-if="step === 'mismatch'" class="space-y-4">
            <p class="text-sm text-muted-foreground">
              密码可能已更改，需要通过教务系统重新验证。
            </p>
            <Alert v-if="errorMessage" variant="destructive">
              <AlertDescription>{{ errorMessage }}</AlertDescription>
            </Alert>
            <div class="flex gap-2">
              <Button variant="outline" class="flex-1 cursor-pointer" @click="step = 'form'">
                返回
              </Button>
              <Button class="flex-1 cursor-pointer" :disabled="loading" @click="handleVerify">
                <Loader2 v-if="loading" class="h-4 w-4 animate-spin mr-2" />
                验证
              </Button>
            </div>
          </div>

          <!-- Step 3: Success -->
          <div v-else-if="step === 'success'" class="space-y-4">
            <p class="text-sm text-muted-foreground">找回成功！你的 Token：</p>
            <div class="bg-muted rounded-md p-3 flex items-center gap-3">
              <code class="flex-1 text-sm font-mono break-all">{{ recoveredToken }}</code>
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
            <Button class="w-full cursor-pointer" @click="goToDashboard">
              进入仪表盘
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
    <RiskWarning v-model="showRiskWarning" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { Loader2, Copy, Check } from 'lucide-vue-next'
import VueHcaptcha from '@hcaptcha/vue3-hcaptcha'
import { toast } from 'vue-sonner'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import Navbar from '@/components/Navbar.vue'
import RiskWarning from '@/components/RiskWarning.vue'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseApiError } from '@/utils/error'
import { encodeOPSaveRequest, activateOPButton } from '@1password/save-button'

const router = useRouter()
const authStore = useAuthStore()

const step = ref('form')
const form = reactive({ studentId: '', password: '' })
const loading = ref(false)
const errorMessage = ref('')
const recoveredToken = ref('')
const copied = ref(false)
const showRiskWarning = ref(false)
const captchaEnabled = ref(false)
const captchaSitekey = ref('')
const hcaptchaRef = ref(null)
const opSaveValue = ref('')

onMounted(async () => {
  if (!localStorage.getItem('risk_warning_acknowledged')) {
    showRiskWarning.value = true
  }
  try {
    const config = await api.getCaptchaConfig()
    captchaEnabled.value = config.enabled
    captchaSitekey.value = config.sitekey
  } catch { toast.error('验证码配置加载失败') }
})

async function getCaptchaToken() {
  if (!captchaEnabled.value || !hcaptchaRef.value) return null
  try {
    const { response } = await hcaptchaRef.value.executeAsync()
    return response
  } catch {
    errorMessage.value = '验证码加载失败，请刷新页面重试'
    return false
  }
}

async function handleRecover() {
  errorMessage.value = ''
  if (!form.studentId) { errorMessage.value = '请输入统一身份认证号'; return }
  if (!form.password) { errorMessage.value = '请输入密码'; return }

  const captchaToken = await getCaptchaToken()
  if (captchaToken === false) return

  loading.value = true
  try {
    const data = await api.recoverToken(form.studentId, form.password, captchaToken)
    recoveredToken.value = data.calendar_token
    opSaveValue.value = encodeOPSaveRequest({
      title: 'CQU Schedule',
      fields: [{ autocomplete: 'current-password', value: data.calendar_token }],
      urls: ['https://schedule.cqu.moe'],
    })
    await authStore.loginWithToken(data.calendar_token)
    step.value = 'success'
    toast.success('找回成功')
    nextTick(() => activateOPButton())
  } catch (error) {
    const detail = error.response?.data?.detail
    const code = detail?.error?.code
    if (code === 'PASSWORD_MISMATCH') {
      step.value = 'mismatch'
    } else {
      errorMessage.value = parseApiError(error, '找回失败')
    }
    hcaptchaRef.value?.reset()
  } finally {
    loading.value = false
  }
}

async function handleVerify() {
  errorMessage.value = ''

  const captchaToken = await getCaptchaToken()
  if (captchaToken === false) return

  loading.value = true
  try {
    const data = await api.recoverTokenVerify(form.studentId, form.password, captchaToken)
    recoveredToken.value = data.calendar_token
    opSaveValue.value = encodeOPSaveRequest({
      title: 'CQU Schedule',
      fields: [{ autocomplete: 'current-password', value: data.calendar_token }],
      urls: ['https://schedule.cqu.moe'],
    })
    await authStore.loginWithToken(data.calendar_token)
    step.value = 'success'
    toast.success('找回成功')
    nextTick(() => activateOPButton())
  } catch (error) {
    errorMessage.value = parseApiError(error, '验证失败')
    hcaptchaRef.value?.reset()
  } finally {
    loading.value = false
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(recoveredToken.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { toast.error('复制失败') }
}

function goToDashboard() {
  router.push('/dashboard')
}
</script>
