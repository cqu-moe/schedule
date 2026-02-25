<template>
  <div>
    <Navbar />
    <div class="min-h-screen flex items-center justify-center pt-24 pb-12 px-4">
      <Card class="w-full max-w-sm">
        <CardHeader class="text-center">
          <CardTitle class="text-2xl font-heading">登录</CardTitle>
        </CardHeader>
        <CardContent>
          <form @submit.prevent="handleLogin" class="space-y-4">
            <div class="space-y-2">
              <Label for="token">Token</Label>
              <Input id="token" v-model="tokenInput" placeholder="请输入你的 Token" />
            </div>
            <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>
            <Button type="submit" class="w-full cursor-pointer" :disabled="authStore.loading">
              <Loader2 v-if="authStore.loading" class="h-4 w-4 animate-spin mr-2" />
              登录
            </Button>
          </form>
          <div class="text-center text-xs text-muted-foreground mt-4 space-y-1">
            <p>
              没有账号？
              <router-link to="/register" class="underline hover:text-foreground">去注册</router-link>
            </p>
            <p>
              忘记 Token？
              <router-link to="/recover" class="underline hover:text-foreground">找回</router-link>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
    <RiskWarning v-model="showRiskWarning" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import Navbar from '@/components/Navbar.vue'
import RiskWarning from '@/components/RiskWarning.vue'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const tokenInput = ref('')
const errorMessage = ref('')
const showRiskWarning = ref(false)

onMounted(() => {
  if (!localStorage.getItem('risk_warning_acknowledged')) {
    showRiskWarning.value = true
  }
})

async function handleLogin() {
  errorMessage.value = ''
  if (!tokenInput.value || tokenInput.value.length < 32) {
    errorMessage.value = 'Token 格式不正确'
    return
  }

  const result = await authStore.loginWithToken(tokenInput.value)
  if (result.success) {
    const redirect = route.query.redirect || '/dashboard'
    router.push(redirect)
  } else {
    errorMessage.value = result.error
  }
}
</script>
