import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@cqu-moe/ui'
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
        <span className="get-badge">GET</span> {title}
      </h3>
      {children}
    </section>
  )
}

export default function Docs() {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])
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
      <PageHeader title="使用指南与 API" description="将课表接入日历，或使用公开接口读取日程。" />
      <nav className="docs-toc" aria-label="本页目录">
        <a href="#subscribe">订阅到日历</a>
        <a href="#links">链接与分享</a>
        <a href="#endpoints">公开端点</a>
        <a href="#refresh">同步与更新</a>
      </nav>
      <section id="subscribe" className="docs-guide" aria-labelledby="subscribe-heading">
        <h2 id="subscribe-heading" className="docs-section-title">
          订阅到你的日历
        </h2>
        <ol className="docs-steps">
          <li>
            <h3>复制课表链接</h3>
            <p>
              进入「我的订阅」，选择需要的课表，点击「复制链接」。课程和考试都需要时，选择「我的全部课表」即可，避免重复日程。
            </p>
          </li>
          <li>
            <h3>在日历中添加订阅</h3>
            <p>
              打开 Apple 日历、Google Calendar 或 Outlook
              的日历订阅入口，粘贴链接并保存。选择通过网址订阅，才能持续接收更新。
            </p>
          </li>
          <li>
            <h3>等待日历获取日程</h3>
            <p>
              首次同步完成后，日程会显示在日历中。不同日历应用的刷新频率不同；网页课表可用于核对本站当前的数据。
            </p>
          </li>
        </ol>
        <Button asChild variant="outline">
          <Link to="/dashboard">
            前往我的订阅
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </section>
      <h2 id="links" className="docs-section-title">
        链接与分享
      </h2>

      <section className="docs-card">
        <p className="docs-card-lead">什么是链接令牌？</p>
        <p className="docs-card-text">
          在「我的订阅」中，每个订阅卡片都附有一个或多个链接。点击「复制链接」即可获取完整
          URL，其中的随机字符串即为链接令牌：
        </p>
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/<strong>abc123ef</strong>/calendar.ics
        </code>
        <p className="docs-card-text">
          其中{' '}
          <code className="docs-inline-code">
            <strong>abc123ef</strong>
          </code>{' '}
          部分就是链接令牌。将下方端点中的{' '}
          <code className="docs-inline-code">
            <Token />
          </code>{' '}
          替换为你的令牌即可访问。
        </p>
        <p className="docs-card-text">
          每个订阅自动拥有一个<strong>默认链接</strong>（可访问全部 5
          种格式）。你也可以在「管理共享链接」中创建<strong>共享链接</strong>
          ，限定只允许访问其中某些格式——访问未授权格式时将返回 403。
        </p>
      </section>

      <h2 id="endpoints" className="docs-section-title">
        公开端点
      </h2>
      <p className="docs-section-description">
        以下端点按链接令牌授权，无需登录。请妥善保管完整链接，只向信任的人分享。
      </p>

      <EndpointCard title="ICS 日历订阅">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/
          <Token />
          /calendar.ics
        </code>
        <p className="docs-card-text">
          标准 ICS 格式。将此链接添加到 iOS 日历、Google Calendar、Outlook
          等日历应用，即可订阅并自动同步课表。
        </p>
      </EndpointCard>

      <EndpointCard title="格式化事件 JSON">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/
          <Token />
          /data.json
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
          {publicUrl}/api/v2/calendar/
          <Token />
          /data.csv
        </code>
        <p className="docs-card-text">
          UTF-8 BOM 编码，Excel 可直接打开并正确显示中文。列顺序与 data.json events 字段一致。
        </p>
        <code className="docs-code">
          name, type, instructor, location, day_of_week, start_time, end_time, week
        </code>
        <p className="docs-note">
          时间列为 ISO 8601 格式含时区（如{' '}
          <code className="docs-inline-code">2025-09-01T08:30:00+08:00</code>）；考试行 week
          列为空。
        </p>
      </EndpointCard>

      <EndpointCard title="原始数据 JSON">
        <code className="docs-code">
          {publicUrl}/api/v2/calendar/
          <Token />
          /origin.json
        </code>
      </EndpointCard>

      <EndpointCard title="网页查看">
        <code className="docs-code">
          {publicUrl}/view/
          <Token />
        </code>
        <p className="docs-card-text">
          在浏览器中直接查看课表的只读日历页面，无需登录。适合分享给他人或在不支持 ICS
          订阅的场景下查阅。
        </p>
      </EndpointCard>

      <h2 id="refresh" className="docs-section-title">
        同步与更新
      </h2>

      <section className="docs-card">
        <p className="docs-card-text">
          在「我的订阅」中点击<strong>「同步个人课表」</strong>或卡片上的<strong>「同步」</strong>
          ，即可请求更新。同步受权限、配额和冷却时间限制，请以页面提示为准。
        </p>
        <p className="docs-card-text">
          同步操作需要本站登录会话（Cookie），请在「我的订阅」中完成。下载 ICS
          文件是一次性导入；需要后续更新时，请使用订阅链接。
        </p>
      </section>
    </>
  )
}
