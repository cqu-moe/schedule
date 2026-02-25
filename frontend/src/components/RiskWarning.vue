<template>
  <AlertDialog :open="modelValue">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>使用本服务前请注意</AlertDialogTitle>
        <AlertDialogDescription>
          本服务需要你提供重庆大学统一身份认证账号和密码，用于自动获取课表和考试信息。
        </AlertDialogDescription>
      </AlertDialogHeader>

      <ul class="text-sm text-muted-foreground list-disc pl-5 space-y-1">
        <li>你的密码会被加密存储在服务器上</li>
        <li>尽管我们采取了加密措施，但任何线上存储都存在一定风险</li>
        <li>如果 Token 泄露，他人可能获取你的课表和考试信息</li>
        <li>请勿在公共场所设备上使用</li>
        <li>妥善保管你的 Token，不要分享给他人</li>
      </ul>

      <div class="bg-destructive/10 border border-destructive/20 rounded-md p-3">
        <p class="text-xs text-destructive">本服务为个人项目，不对因使用本服务造成的任何损失负责。</p>
      </div>

      <AlertDialogFooter class="flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" v-model="agreed" class="h-4 w-4 rounded border-border" />
          我已了解风险并同意使用
        </label>
        <div class="flex gap-2 justify-end">
          <AlertDialogCancel class="cursor-pointer" @click="handleCancel">返回首页</AlertDialogCancel>
          <AlertDialogAction :disabled="!agreed" @click="handleConfirm">确认</AlertDialogAction>
        </div>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'

const router = useRouter()

const props = defineProps({
  modelValue: {
    type: Boolean,
    required: true,
  },
})

const emit = defineEmits(['update:modelValue'])

const agreed = ref(false)

function handleCancel() {
  emit('update:modelValue', false)
  router.push('/')
}

function handleConfirm() {
  localStorage.setItem('risk_warning_acknowledged', 'true')
  emit('update:modelValue', false)
}
</script>
