<template>
  <div class="min-h-screen bg-background text-foreground antialiased">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
    <Toaster position="bottom-right" rich-colors :duration="3000" />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useColorMode } from '@vueuse/core'
import { Sonner as Toaster } from '@/components/ui/sonner'
import { useConfigStore } from '@/stores/config'
import { useSession } from '@/stores/session'

// Initialize color mode (auto/light/dark), persists to localStorage
useColorMode({ attribute: 'class', modes: { dark: 'dark', light: '' } })

// Load backend config (public_url) and session (user/caps) once on app startup.
// getMe uses suppressAuthRedirect so 401 (unauthenticated visitors) is silently
// swallowed here — public routes remain accessible. Protected pages trigger their
// own authenticated API calls whose 401s still redirect via the interceptor.
const configStore = useConfigStore()
const session = useSession()
onMounted(() => {
  configStore.load()
  session.load().catch(() => {
    // 401 → silently ignored (suppressAuthRedirect); non-401 errors are non-fatal.
  })
})
</script>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease-out;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active {
    transition: none;
  }
}
</style>
