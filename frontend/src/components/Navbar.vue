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
          <!-- Authenticated: Dashboard + Add + Account/Logout (via auth.cqu.moe) -->
          <template v-if="session.isAuthenticated">
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
            <!-- Link to auth.cqu.moe for account management and logout -->
            <a
              href="https://auth.cqu.moe"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              :title="session.user?.name || session.user?.email || '账户'"
            >
              账户
            </a>
          </template>

          <!-- Not authenticated: prompt via auth.cqu.moe -->
          <template v-else>
            <a
              href="https://auth.cqu.moe/login"
              class="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              登录
            </a>
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
import { Monitor, Sun, Moon } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useSession } from '@/stores/session'

const session = useSession()
const colorMode = useColorMode()
const storedMode = colorMode.store

function cycleTheme(): void {
  const modes: Array<'auto' | 'light' | 'dark'> = ['auto', 'light', 'dark']
  const currentIndex = modes.indexOf(storedMode.value as 'auto' | 'light' | 'dark')
  const nextIndex = (currentIndex + 1) % modes.length
  storedMode.value = modes[nextIndex]
}
</script>
