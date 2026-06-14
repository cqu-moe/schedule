<template>
  <!--
    Per-link token rotation confirm dialog.
    Usage: bind :open and listen @confirm + @update:open.
    The parent is responsible for calling api.rotateLink and updating state.
  -->
  <AlertDialog :open="open" @update:open="$emit('update:open', $event)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认轮换链接 Token</AlertDialogTitle>
        <AlertDialogDescription>
          轮换后旧链接立即失效，日历客户端需重新订阅新链接。确定要继续吗？
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel class="cursor-pointer" @click="$emit('update:open', false)">
          取消
        </AlertDialogCancel>
        <AlertDialogAction
          class="cursor-pointer bg-destructive text-white hover:bg-destructive/90"
          @click="$emit('confirm')"
        >
          轮换
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

defineProps<{
  open: boolean
}>()

defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()
</script>
