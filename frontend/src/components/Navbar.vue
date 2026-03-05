<template>
  <header class="fixed top-4 left-4 right-4 z-50">
    <div class="max-w-7xl mx-auto rounded-lg border border-border backdrop-blur-md bg-background/80 px-4 sm:px-6 py-3">
      <div class="flex items-center justify-between">
        <!-- Logo -->
        <router-link to="/" class="font-heading font-semibold text-lg cursor-pointer transition-colors hover:text-foreground/80">
          CQU Schedule
        </router-link>

        <!-- Nav Links + Theme Toggle -->
        <nav class="flex items-center gap-4 sm:gap-6">
          <!-- Authenticated: Dashboard + Add + Logout -->
          <template v-if="authStore.isAuthenticated">
            <router-link
              to="/dashboard"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              仪表盘
            </router-link>
            <router-link
              to="/add"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              添加新订阅
            </router-link>
            <button
              @click="handleLogout"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              退出登录
            </button>
          </template>

          <!-- Not authenticated: Register + Login -->
          <template v-else>
            <router-link
              to="/register"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              注册
            </router-link>
            <router-link
              to="/login"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              登录
            </router-link>
          </template>

          <!-- API Docs Link (always visible) -->
          <router-link
            to="/api-docs"
            class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            API 文档
          </router-link>

          <!-- Theme Toggle Button -->
          <Button
            variant="ghost"
            size="icon"
            @click="cycleTheme"
            class="cursor-pointer"
            aria-label="切换主题"
          >
            <Monitor v-if="storedMode === 'auto'" class="h-[1.2rem] w-[1.2rem]" />
            <Sun v-else-if="storedMode === 'light'" class="h-[1.2rem] w-[1.2rem]" />
            <Moon v-else class="h-[1.2rem] w-[1.2rem]" />
          </Button>
        </nav>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import { useRouter } from 'vue-router'
import { Monitor, Sun, Moon } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const colorMode = useColorMode()
const storedMode = colorMode.store

function handleLogout(): void {
  authStore.logout()
  router.push('/')
}

function cycleTheme(): void {
  const modes: Array<'auto' | 'light' | 'dark'> = ['auto', 'light', 'dark']
  const currentIndex = modes.indexOf(storedMode.value as 'auto' | 'light' | 'dark')
  const nextIndex = (currentIndex + 1) % modes.length
  storedMode.value = modes[nextIndex]
}
</script>
