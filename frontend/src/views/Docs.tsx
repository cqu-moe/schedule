import type { ReactNode } from 'react'
import {
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cqu-moe/ui'
import { useSession } from '@/providers/app'
import './docs.css'

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

function Token() {
  return <span className="docs-token">{'{令牌}'}</span>
}

function EndpointCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="docs-card">
      <h3 className="docs-card-title">
        <span className="get-badge">GET</span>
        {' '}
        {title}
      </h3>
      {children}
    </section>
  )
}

export default function Docs() {
  return (
    <div className="docs-content">
      <DocsBody />
    </div>
  )
}

function DocsBody() {
  const { publicUrl } = useSession()

  return (
    <>
      <PageHeader title="API 文档" description="以下公开端点无需认证，任何人持有链接令牌均可访问对应格式。" />

      <section className="docs-card">
        <p className="docs-card-lead">什么是链接令牌？</p>
        <p className="docs-card-text">
          在仪表盘中，每个订阅卡片都附有一个或多个链接。点击「复制」即可获取完整 URL，其中的随机字符串即为链接令牌：
        </p>
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/<strong>abc123ef</strong>/calendar.ics
        </code>
        <p className="docs-card-text">
          其中 <code className="docs-inline-code"><strong>abc123ef</strong></code> 部分就是链接令牌。将下方端点中的 <code className="docs-inline-code"><Token /></code> 替换为你的令牌即可访问。
        </p>
        <p className="docs-card-text">
          每个订阅自动拥有一个<strong>默认链接</strong>（可访问全部 5 种格式）。你也可以在仪表盘创建<strong>共享链接</strong>，限定只允许访问其中某些格式——访问未授权格式时将返回 403。
        </p>
      </section>

      <h2 className="docs-section-title">公开端点</h2>

      <EndpointCard title="ICS 日历订阅">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/<Token />/calendar.ics
        </code>
        <p className="docs-card-text">
          标准 ICS 格式。将此链接添加到 iOS 日历、Google Calendar、Outlook 等日历应用，即可订阅并自动同步课表。
        </p>
      </EndpointCard>

      <EndpointCard title="格式化事件 JSON">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/<Token />/data.json
        </code>
        <p className="docs-card-text">
          将周次展开为具体日期的事件列表，适合程序化处理或导入 Notion 等工具。
        </p>
        <Table className="docs-fields-table">
          <TableHeader>
            <TableRow>
              <TableHead className="docs-col-field">字段</TableHead>
              <TableHead className="docs-col-type">类型</TableHead>
              <TableHead>说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jsonFields.map((field) => (
              <TableRow key={field.name}>
                <TableCell className="docs-cell-mono docs-cell-name">{field.name}</TableCell>
                <TableCell className="docs-cell-mono docs-cell-type">{field.type}</TableCell>
                <TableCell className="docs-cell-desc">{field.desc}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </EndpointCard>

      <EndpointCard title="CSV 导出">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/<Token />/data.csv
        </code>
        <p className="docs-card-text">
          UTF-8 BOM 编码，Excel 可直接打开并正确显示中文。列顺序与 data.json events 字段一致。
        </p>
        <code className="docs-code">
          name, type, instructor, location, day_of_week, start_time, end_time, week
        </code>
        <p className="docs-note">
          时间列为 ISO 8601 格式含时区（如 <code className="docs-inline-code">2025-09-01T08:30:00+08:00</code>）；考试行 week 列为空。
        </p>
      </EndpointCard>

      <EndpointCard title="原始数据 JSON">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/<Token />/origin.json
        </code>
      </EndpointCard>

      <EndpointCard title="网页查看">
        <code className="docs-code">
          {publicUrl}/view/<Token />
        </code>
        <p className="docs-card-text">
          在浏览器中直接查看课表的只读日历页面，无需登录。适合分享给他人或在不支持 ICS 订阅的场景下查阅。
        </p>
      </EndpointCard>

      <h2 className="docs-section-title">刷新订阅</h2>

      <section className="docs-card">
        <p className="docs-card-text">
          在仪表盘中点击订阅卡片上的<strong>「立即刷新」</strong>按钮，即可手动触发从 CQU 教务系统重新拉取数据。刷新受每日配额限制，超出后需等待次日重置。
        </p>
        <p className="docs-card-text">
          v2 不提供需要 Bearer Token 的刷新 API——刷新操作通过登录会话（Cookie）进行，在仪表盘 UI 中完成。
        </p>
      </section>
    </>
  )
}
