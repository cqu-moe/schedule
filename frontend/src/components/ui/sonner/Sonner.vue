<script lang="ts" setup>
import { Toaster as Sonner, type ToasterProps } from 'vue-sonner'
import { computed } from 'vue'
import { useColorMode } from '@vueuse/core'

const props = defineProps<ToasterProps>()

const { store: mode } = useColorMode()

const theme = computed(() => (mode.value === 'dark' ? 'dark' : 'light'))
</script>

<template>
  <Sonner :theme="theme" class="toaster group" v-bind="props" />
</template>
