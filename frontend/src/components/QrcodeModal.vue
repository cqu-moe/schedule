<template>
  <Dialog :open="modelValue" @update:open="$emit('update:modelValue', $event)">
    <DialogContent class="max-w-xs">
      <DialogHeader>
        <DialogTitle>扫码订阅</DialogTitle>
        <DialogDescription class="sr-only">使用手机扫描二维码订阅日历</DialogDescription>
      </DialogHeader>
      <div class="flex flex-col items-center py-4">
        <QrcodeVue :value="url" :size="240" level="M" />
        <p class="text-sm text-muted-foreground mt-4">使用手机扫描二维码</p>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import QrcodeVue from 'qrcode.vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'

defineProps<{
  modelValue?: boolean
  url: string
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>
