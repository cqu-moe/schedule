<template>
  <div class="min-h-screen bg-background text-foreground antialiased">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useColorMode } from '@vueuse/core'
import { useConfigStore } from '@/stores/config.js'

// Initialize color mode (auto/light/dark), persists to localStorage
useColorMode({ attribute: 'class', modes: { dark: 'dark', light: '' } })

// Load backend config (public_url etc.) once on app startup
const configStore = useConfigStore()
onMounted(() => {
  configStore.load()
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
