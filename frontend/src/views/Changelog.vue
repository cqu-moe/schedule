<template>
  <div class="min-h-screen bg-background">
    <Navbar />
    <div class="max-w-2xl mx-auto px-4 pt-24 pb-12">
      <div class="mb-8">
        <h1 class="text-2xl font-heading font-bold">更新日志</h1>
        <p class="text-muted-foreground mt-1">版本更新记录</p>
      </div>
      <div class="changelog-content" v-html="changelogHtml" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Navbar from '@/components/Navbar.vue'

const changelogHtml = __CHANGELOG_HTML__
  .replace(/^<h1[^>]*>.*?<\/h1>\s*/i, '')
</script>

<style scoped>
.changelog-content :deep(h2) {
  @apply text-xl font-heading font-semibold mt-8 mb-3;
}
.changelog-content :deep(h3) {
  @apply text-base font-heading font-semibold mt-6 mb-2;
}
.changelog-content :deep(p) {
  @apply text-sm text-muted-foreground mb-4;
}
.changelog-content :deep(ul) {
  @apply list-disc list-inside space-y-1.5 mb-4;
}
.changelog-content :deep(li) {
  @apply text-sm text-muted-foreground;
}
.changelog-content :deep(strong) {
  @apply text-foreground font-medium;
}
</style>
