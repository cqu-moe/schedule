<template>
  <Card class="mb-4">
    <CardHeader>
      <CardTitle class="text-base">{{ title }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="bg-muted rounded px-3 py-2 overflow-x-auto">
        <code class="text-xs text-muted-foreground break-all font-mono">{{ url }}</code>
      </div>
      <div class="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          class="cursor-pointer"
          @click="copyUrl"
        >
          <Check v-if="copied" class="h-4 w-4 mr-1.5" />
          <Copy v-else class="h-4 w-4 mr-1.5" />
          {{ copied ? '已复制' : '复制' }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="cursor-pointer"
          @click="emit('show-qrcode', url)"
        >
          <QrCode class="h-4 w-4 mr-1.5" />
          二维码
        </Button>
      </div>
    </CardContent>
  </Card>
</template>

<script setup>
import { ref } from 'vue'
import { Copy, Check, QrCode } from 'lucide-vue-next'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const props = defineProps({
  title: {
    type: String,
    required: true
  },
  url: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['show-qrcode'])

const copied = ref(false)

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(props.url)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // Silently fail — user can manually copy from the URL display
  }
}
</script>
