<template>
  <div class="min-h-screen bg-background">
    <Navbar />

    <div class="max-w-2xl mx-auto px-4 pt-24 pb-12">
      <div class="mb-8">
        <h1 class="text-2xl font-heading font-bold">API 文档</h1>
        <p class="text-muted-foreground mt-1">
          以下公开端点无需认证，任何人持有链接令牌均可访问对应格式。
        </p>
      </div>

      <!-- 令牌说明 -->
      <Card class="mb-6">
        <CardContent class="py-2">
          <p class="font-semibold mb-2">什么是链接令牌？</p>
          <p class="text-sm text-muted-foreground mb-3">
            在仪表盘中，每个订阅卡片都附有一个或多个链接。点击「复制」即可获取完整 URL，其中的随机字符串即为链接令牌：
          </p>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono break-all mb-3">
            {{ publicUrl }}/api/v2/calendar/<strong class="text-foreground">abc123ef</strong>/calendar.ics
          </code>
          <p class="text-sm text-muted-foreground mb-2">
            其中 <code class="bg-muted px-1 rounded text-xs"><strong>abc123ef</strong></code> 部分就是链接令牌。将下方端点中的 <code class="bg-muted px-1 rounded text-xs">{令牌}</code> 替换为你的令牌即可访问。
          </p>
          <p class="text-sm text-muted-foreground">
            每个订阅自动拥有一个<strong>默认链接</strong>（可访问全部 5 种格式）。你也可以在仪表盘创建<strong>共享链接</strong>，限定只允许访问其中某些格式——访问未授权格式时将返回 403。
          </p>
        </CardContent>
      </Card>

      <!-- 公开端点 -->
      <h2 class="text-base font-semibold mb-3">公开端点</h2>

      <!-- calendar.ics -->
      <Card class="mb-4">
        <CardHeader>
          <CardTitle class="text-base flex items-center gap-2">
            <Badge variant="secondary" class="font-mono text-xs">GET</Badge>
            ICS 日历订阅
          </CardTitle>
        </CardHeader>
        <CardContent>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono break-all mb-3">
            {{ publicUrl }}/api/v2/calendar/<span class="text-muted-foreground">{令牌}</span>/calendar.ics
          </code>
          <p class="text-sm text-muted-foreground">
            标准 ICS 格式。将此链接添加到 iOS 日历、Google Calendar、Outlook 等日历应用，即可订阅并自动同步课表。
          </p>
        </CardContent>
      </Card>

      <!-- data.json -->
      <Card class="mb-4">
        <CardHeader>
          <CardTitle class="text-base flex items-center gap-2">
            <Badge variant="secondary" class="font-mono text-xs">GET</Badge>
            格式化事件 JSON
          </CardTitle>
        </CardHeader>
        <CardContent>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono break-all mb-3">
            {{ publicUrl }}/api/v2/calendar/<span class="text-muted-foreground">{令牌}</span>/data.json
          </code>
          <p class="text-sm text-muted-foreground mb-4">
            将周次展开为具体日期的事件列表，适合程序化处理或导入 Notion 等工具。
          </p>

          <!-- 字段表格 -->
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-border">
                  <th class="text-left py-2 pr-4 font-medium text-muted-foreground w-40">字段</th>
                  <th class="text-left py-2 pr-4 font-medium text-muted-foreground w-24">类型</th>
                  <th class="text-left py-2 font-medium text-muted-foreground">说明</th>
                </tr>
              </thead>
              <tbody class="font-mono">
                <tr v-for="field in jsonFields" :key="field.name" class="border-b border-border/50">
                  <td class="py-2 pr-4 text-foreground">{{ field.name }}</td>
                  <td class="py-2 pr-4 text-muted-foreground">{{ field.type }}</td>
                  <td class="py-2 text-muted-foreground font-sans">{{ field.desc }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <!-- data.csv -->
      <Card class="mb-4">
        <CardHeader>
          <CardTitle class="text-base flex items-center gap-2">
            <Badge variant="secondary" class="font-mono text-xs">GET</Badge>
            CSV 导出
          </CardTitle>
        </CardHeader>
        <CardContent>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono break-all mb-3">
            {{ publicUrl }}/api/v2/calendar/<span class="text-muted-foreground">{令牌}</span>/data.csv
          </code>
          <p class="text-sm text-muted-foreground mb-2">
            UTF-8 BOM 编码，Excel 可直接打开并正确显示中文。列顺序与 data.json events 字段一致。
          </p>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono">
            name, type, instructor, location, day_of_week, start_time, end_time, week
          </code>
          <p class="text-xs text-muted-foreground mt-2">
            时间列为 ISO 8601 格式含时区（如 <code class="bg-muted px-1 rounded">2025-09-01T08:30:00+08:00</code>）；考试行 week 列为空。
          </p>
        </CardContent>
      </Card>

      <!-- origin.json -->
      <Card class="mb-4">
        <CardHeader>
          <CardTitle class="text-base flex items-center gap-2">
            <Badge variant="secondary" class="font-mono text-xs">GET</Badge>
            原始数据 JSON
          </CardTitle>
        </CardHeader>
        <CardContent>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono break-all">
            {{ publicUrl }}/api/v2/calendar/<span class="text-muted-foreground">{令牌}</span>/origin.json
          </code>
        </CardContent>
      </Card>

      <!-- web view -->
      <Card class="mb-6">
        <CardHeader>
          <CardTitle class="text-base flex items-center gap-2">
            <Badge variant="secondary" class="font-mono text-xs">GET</Badge>
            网页查看
          </CardTitle>
        </CardHeader>
        <CardContent>
          <code class="block bg-muted rounded px-3 py-2 text-xs font-mono break-all mb-3">
            {{ publicUrl }}/view/<span class="text-muted-foreground">{令牌}</span>
          </code>
          <p class="text-sm text-muted-foreground">
            在浏览器中直接查看课表的只读日历页面，无需登录。适合分享给他人或在不支持 ICS 订阅的场景下查阅。
          </p>
        </CardContent>
      </Card>

      <!-- 刷新说明（无 Bearer API） -->
      <h2 class="text-base font-semibold mb-3">刷新订阅</h2>

      <Card>
        <CardContent class="py-4">
          <p class="text-sm text-muted-foreground">
            在仪表盘中点击订阅卡片上的<strong>「立即刷新」</strong>按钮，即可手动触发从 CQU 教务系统重新拉取数据。刷新受每日配额限制，超出后需等待次日重置。
          </p>
          <p class="text-sm text-muted-foreground mt-2">
            v2 不提供需要 Bearer Token 的刷新 API——刷新操作通过登录会话（Cookie）进行，在仪表盘 UI 中完成。
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useConfigStore } from '@/stores/config'
import Navbar from '@/components/Navbar.vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

const configStore = useConfigStore()
const publicUrl = computed(() => configStore.publicUrl)

const jsonFields = [
  { name: 'semester', type: 'string', desc: '学期短名，如 "2025秋"' },
  { name: 'semester_start', type: 'string', desc: '学期开始日期，YYYY-MM-DD' },
  { name: 'generated_at', type: 'string', desc: '生成时间，ISO 8601 含时区' },
  { name: 'events[].name', type: 'string', desc: '课程或考试名称' },
  { name: 'events[].type', type: 'string', desc: '"course" 或 "exam"' },
  { name: 'events[].instructor', type: 'string', desc: '任课教师；考试为空字符串' },
  { name: 'events[].location', type: 'string', desc: '教室或考场' },
  { name: 'events[].day_of_week', type: 'int', desc: '1（周一）至 7（周日）' },
  { name: 'events[].start_time', type: 'string', desc: '开始时间，ISO 8601 含时区' },
  { name: 'events[].end_time', type: 'string', desc: '结束时间，ISO 8601 含时区' },
  { name: 'events[].week', type: 'int|null', desc: '教学周次；考试为 null' },
]
</script>
