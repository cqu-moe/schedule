<template>
  <div>
    <Navbar />
    <div class="min-h-screen flex items-center justify-center pt-24 pb-12 px-4">
      <Card class="w-full max-w-sm">
        <CardHeader class="text-center">
          <CardTitle class="text-2xl font-heading">登录</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <div v-if="loading" class="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Loader2 class="h-5 w-5 animate-spin" />
            <span>正在登录…</span>
          </div>
          <template v-else>
            <Alert variant="destructive">
              <AlertDescription>{{ errorMessage }}</AlertDescription>
            </Alert>
            <Button
              v-if="showBindLink"
              as="a"
              href="https://auth.cqu.moe"
              target="_blank"
              rel="noopener noreferrer"
              class="w-full cursor-pointer"
            >
              前往 auth.cqu.moe 绑定
            </Button>
            <Button as-child variant="outline" class="w-full cursor-pointer">
              <router-link :to="{ name: RouteNames.Login }">返回登录</router-link>
            </Button>
          </template>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { RouteNames } from '@/router'
import Navbar from '@/components/Navbar.vue'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

// Maps server-side OAuth callback error codes to friendly Chinese messages (design §9).
const ERROR_MESSAGES: Record<string, string> = {
  access_denied: '你取消了授权',
  oauth_missing_code: '授权回调参数缺失，请重试',
  oauth_state: '登录会话已过期，请重试',
  oauth_token: '授权失败，请重试',
  cqu_unbound: '你还没在 auth.cqu.moe 绑定 CQU 账号，请先去绑定后再登录',
  cqu_ticket: 'CQU 会话不可用，请去 auth.cqu.moe 检查绑定',
  cqu_login: '连接教务系统失败，请稍后重试',
  internal: '服务器开小差了，请稍后重试',
}

const router = useRouter()
const authStore = useAuthStore()

const loading = ref(true)
const errorMessage = ref('')
const showBindLink = ref(false)

function stripFragment() {
  // Remove the URL fragment so the token / error code doesn't linger in history.
  history.replaceState(null, '', location.pathname + location.search)
}

function showError(code: string) {
  errorMessage.value = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal
  showBindLink.value = code === 'cqu_unbound'
  loading.value = false
}

onMounted(async () => {
  const hash = window.location.hash.replace(/^#/, '')
  const params = new URLSearchParams(hash)
  const token = params.get('token')
  const error = params.get('error')

  // Strip the fragment immediately so the token never lingers in history / back-button.
  stripFragment()

  if (token) {
    const result = await authStore.loginWithToken(token)
    if (result.success) {
      router.replace({ name: RouteNames.Dashboard })
      return
    }
    errorMessage.value = result.error ?? '登录失败'
    loading.value = false
    return
  }

  if (error) {
    showError(error)
    return
  }

  showError('internal')
})
</script>
