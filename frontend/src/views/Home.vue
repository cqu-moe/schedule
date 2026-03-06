<template>
  <div>
    <Navbar />

    <!-- Hero Section -->
    <section class="pt-32 pb-20 text-center">
      <div class="max-w-2xl mx-auto px-4">
        <h1 class="text-4xl md:text-6xl font-heading font-bold tracking-tight">
          重庆大学课表日历订阅
        </h1>
        <p class="text-lg text-muted-foreground mt-4 max-w-lg mx-auto">
          自动同步课表到你的日历应用，随时随地查看课程安排
        </p>
        <div class="mt-8">
          <router-link :to="ctaLink">
            <Button size="lg" class="cursor-pointer">开始使用</Button>
          </router-link>
        </div>
      </div>
    </section>

    <!-- Features Section -->
    <section class="py-20">
      <div class="max-w-4xl mx-auto px-4">
        <div class="grid md:grid-cols-3 gap-8">
          <div class="text-center">
            <RefreshCw class="h-8 w-8 text-muted-foreground mb-3 mx-auto" />
            <h3 class="font-heading font-semibold text-lg">自动同步</h3>
            <p class="text-sm text-muted-foreground mt-1">定时同步课表数据，日历始终保持最新</p>
          </div>
          <div class="text-center">
            <CalendarIcon class="h-8 w-8 text-muted-foreground mb-3 mx-auto" />
            <h3 class="font-heading font-semibold text-lg">标准格式</h3>
            <p class="text-sm text-muted-foreground mt-1">ICS 标准格式，支持所有主流日历应用</p>
          </div>
          <div class="text-center">
            <Lock class="h-8 w-8 text-muted-foreground mb-3 mx-auto" />
            <h3 class="font-heading font-semibold text-lg">安全加密</h3>
            <p class="text-sm text-muted-foreground mt-1">密码加密存储，Token 认证访问</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="border-t border-border py-8">
      <p class="text-center text-sm text-muted-foreground">
        CQU Schedule ·
        <router-link to="/changelog" class="hover:text-foreground transition-colors">
          v{{ appVersion }}
        </router-link>
      </p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw, Calendar as CalendarIcon, Lock } from 'lucide-vue-next'
import Navbar from '@/components/Navbar.vue'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const ctaLink = computed(() => authStore.isAuthenticated ? '/dashboard' : '/register')

const appVersion = __APP_VERSION__
</script>
