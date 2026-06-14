<template>
  <AlertDialog v-model:open="open">
    <AlertDialogTrigger as-child>
      <slot />
    </AlertDialogTrigger>
    <AlertDialogContent>
      <!--
        TODO(FE-2): In v2 there is no per-user calendar token to rotate.
        Token rotation is per-link (POST /api/v2/subscriptions/:sid/links/:lid/rotations).
        This dialog will be rewritten in FE-2 as per-link rotation or removed entirely.
      -->
      <AlertDialogHeader>
        <AlertDialogTitle>功能已迁移</AlertDialogTitle>
        <AlertDialogDescription>
          在 v2 中，链接轮换已迁移为每个订阅链接独立操作。请在订阅详情页面管理链接。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel class="cursor-pointer" @click="open = false">关闭</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
// TODO(FE-2): rewrite this dialog for per-link rotation via
//   POST /api/v2/subscriptions/:sid/links/:lid/rotations
//   (see api.rotateLink in frontend/src/api/index.ts)
import { ref } from 'vue'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const open = ref(false)
</script>
