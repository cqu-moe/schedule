import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@cqu-moe/ui'
import { ArrowRight, ArrowUpRight, Link2 } from 'lucide-react'
import { AUTH_BASE_URL, authCquBindUrl, authLoginUrl, scheduleSetupTarget } from '@/config/auth'
import { useSession } from '@/providers/app'
import './home.css'

const weekdays = ['一', '二', '三', '四', '五']
const exampleEvents = [
  { name: '高等数学', day: 0, time: '08:30–10:10', place: '第一教学楼 A102', tone: 'blue' },
  { name: '大学英语', day: 1, time: '10:30–12:10', place: '第二教学楼 B205', tone: 'apricot' },
  {
    name: '半导体物理与器件基础',
    day: 2,
    time: '08:30–10:10',
    place: '第一教学楼 A308',
    tone: 'blue',
  },
  { name: '大学物理', day: 3, time: '10:30–12:10', place: '第一教学楼 A204', tone: 'lilac' },
  {
    name: '线性代数 · 期中考试',
    day: 4,
    time: '10:30–12:10',
    place: '第二教学楼 B301',
    tone: 'apricot',
  },
  { name: '电路原理', day: 0, time: '14:00–15:40', place: '第三教学楼 C103', tone: 'lilac' },
  { name: '大学物理实验', day: 2, time: '14:00–15:40', place: '理科实验楼 402', tone: 'lilac' },
  { name: '电路原理', day: 3, time: '14:00–15:40', place: '第三教学楼 C103', tone: 'blue' },
]

export default function Home() {
  return (
    <div className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-intro">
          <p className="home-eyebrow">为重庆大学的每个上课日</p>
          <h1 id="home-title">
            课表之外，
            <br />
            还有
            <span className="home-life">
              生活
              <svg
                viewBox="0 0 200 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 10C55 4 123 4 195 8" strokeWidth="3.5" />
                <path d="M14 19C61 13 119 12 171 15" strokeWidth="3" />
              </svg>
            </span>
            。
          </h1>
          <p className="home-description">
            把课程和考试放进日历。
            <br />
            少一次来回查找，多一点自己的时间。
          </p>
          <HomeCta />
          <p className="home-compatibility">Apple 日历 · Google Calendar · Outlook</p>
        </div>
        <div className="home-scene">
          <div className="home-paper-back" aria-hidden="true" />
          <DayAgenda />
          <div className="home-ticket" aria-hidden="true">
            <Link2 size={24} />
            <span>
              课表 → 日历
              <br />
              <strong>连接一次，日常随行</strong>
            </span>
          </div>
        </div>
      </section>

      <section className="home-story" aria-labelledby="story-title">
        <div className="home-section-heading">
          <h2 id="story-title">
            上课不遗漏，
            <br />
            空闲也看得见。
          </h2>
          <p>
            让课程与自己的安排待在一起。
            <br />
            什么时候去图书馆，什么时候放松一下，留给你自己决定。
          </p>
        </div>
        <div
          className="home-story-strip"
          role="img"
          aria-label="日程效果示意：上午订阅的课程，午后自习和傍晚跑步由你在自己的日历中添加"
        >
          <div className="home-story-block home-tone-blue">
            <span>08:30 / 课程</span>
            <strong>高等数学</strong>
            <small>订阅里的安排</small>
          </div>
          <span className="home-story-space" aria-hidden="true">
            ＋
          </span>
          <div className="home-story-block home-tone-lilac">
            <span>15:00 / 自己的安排</span>
            <strong>图书馆自习</strong>
            <small>在你的日历中添加</small>
          </div>
          <div className="home-story-block home-tone-apricot">
            <span>18:00 / 自己的安排</span>
            <strong>操场慢跑</strong>
            <small>在你的日历中添加</small>
          </div>
        </div>
        <p className="home-story-note">日程效果示意 · 个人安排由你在日历应用中添加</p>
      </section>

      <section id="how" className="home-how" aria-labelledby="how-title">
        <div className="home-section-heading">
          <h2 id="how-title">
            三步，把这一学期
            <br />
            安排妥当。
          </h2>
          <Link className="home-text-link" to="/api-docs#subscribe">
            查看完整订阅指南
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>
        <ol className="home-steps">
          <li>
            <span aria-hidden="true">01</span>
            <div>
              <h3>连接你的账号</h3>
              <p>通过 CQU Moe 认证中心登录并绑定重庆大学统一认证账号，按页面引导完成首次同步。</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">02</span>
            <div>
              <h3>选择想订阅的安排</h3>
              <p>全部安排、仅课程或仅考试。复制对应的日历订阅链接，避免重复添加。</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">03</span>
            <div>
              <h3>放进你常用的日历</h3>
              <p>
                在 Apple 日历、Google Calendar 或 Outlook 中通过网址添加订阅，等待日历获取日程。
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section id="questions" className="home-questions" aria-labelledby="questions-title">
        <div className="home-section-heading">
          <h2 id="questions-title">你可能还想知道。</h2>
        </div>
        <div className="home-faq">
          <details>
            <summary>课表变了，日历会马上更新吗？</summary>
            <p>
              本站定时获取安排，日历应用再按自己的频率刷新订阅，因此更新并非即时。需要核对时，可以查看网页课表；手动同步受权限、配额和冷却时间限制。
            </p>
            <Link to="/api-docs#refresh">
              同步与更新说明
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </details>
          <details>
            <summary>订阅和下载 ICS 文件，有什么区别？</summary>
            <p>
              通过网址订阅，日历才会继续获取后续更新。下载 ICS
              文件后导入通常只导入一次，不会自动跟随课表变化。
            </p>
          </details>
          <details>
            <summary>我的课表链接可以发给别人吗？</summary>
            <p>
              完整链接包含访问令牌，持有链接的人可以查看相应安排。请只分享给信任的人；需要分享时，可创建权限受控的共享链接，并随时停用。
            </p>
            <Link to="/api-docs#links">
              了解链接与分享
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </details>
          <details>
            <summary>能订阅老师或教室的课表吗？</summary>
            <p>本站也支持外部课表订阅，实际开放的类型、同步权限与订阅额度以登录后的页面为准。</p>
          </details>
          <details>
            <summary>这是学校的官方服务吗？</summary>
            <p>
              CQU Schedule 是 CQU Moe
              提供的非官方课表工具。课程、考试及调课安排请以学校教务系统和正式通知为准。
            </p>
          </details>
        </div>
      </section>
      <footer className="home-footer">
        <div>
          <strong>CQU Schedule</strong>
          <p>CQU Moe · 非学校官方服务</p>
        </div>
        <nav aria-label="页脚导航">
          <Link to="/api-docs">使用指南</Link>
          <a href="https://github.com/cqu-moe/schedule">
            项目源码
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <a href="https://github.com/cqu-moe/schedule/issues">
            问题反馈
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </nav>
      </footer>
    </div>
  )
}

function DayAgenda() {
  const [day, setDay] = useState(3)
  return (
    <div className="home-agenda">
      <div className="home-agenda-heading">
        <span>我的一天</span>
        <span>日程示例</span>
      </div>
      <div className="home-agenda-date">
        <strong>{19 + day}</strong>
        <div>
          2026 年 10 月<br />
          <span>星期{weekdays[day]}</span>
        </div>
      </div>
      <div className="home-agenda-days" role="group" aria-label="选择示例日期">
        {weekdays.map((label, index) => (
          <Button
            key={label}
            variant={day === index ? 'secondary' : 'ghost'}
            aria-label={`查看周${label}安排`}
            aria-pressed={day === index}
            onClick={() => setDay(index)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="home-agenda-events" aria-label={`星期${weekdays[day]}的示例日程`}>
        {exampleEvents
          .filter((event) => event.day === day)
          .map((event) => (
            <div className="home-agenda-row" key={event.name}>
              <span className="home-agenda-time">{event.time.slice(0, 5)}</span>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" className={`home-event home-tone-${event.tone}`}>
                    <strong>{event.name}</strong>
                    <span>{event.time}</span>
                    <span>{event.place}</span>
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogTitle>{event.name}</DialogTitle>
                  <DialogDescription>日程示例，用于展示订阅效果，不是真实课表。</DialogDescription>
                  <dl className="home-event-detail">
                    <div>
                      <dt>时间</dt>
                      <dd>
                        2026 年 10 月 {19 + day} 日<br />
                        {event.time}
                      </dd>
                    </div>
                    <div>
                      <dt>地点</dt>
                      <dd>{event.place}</dd>
                    </div>
                  </dl>
                </DialogContent>
              </Dialog>
            </div>
          ))}
      </div>
    </div>
  )
}

function HomeCta() {
  const {
    isAuthenticated,
    isCquBound,
    cquBindStatus,
    sessionPending,
    sessionError,
    reloadSession,
  } = useSession()
  const location = useLocation()
  if (sessionPending)
    return (
      <div className="home-cta" aria-busy="true">
        <span className="sr-only" role="status">
          正在确认登录状态
        </span>
        <Button className="home-brand-action" size="lg" disabled aria-hidden="true">
          <span className="invisible">开始使用</span>
          <ArrowRight className="invisible" />
        </Button>
      </div>
    )
  if (!isAuthenticated && sessionError === 'unavailable')
    return (
      <div className="home-cta">
        <Button
          className="home-brand-action"
          size="lg"
          onClick={() => void reloadSession().catch(() => {})}
        >
          重试登录状态
        </Button>
        <p className="home-cta-hint" role="status">
          暂时无法确认登录状态，请重试。
        </p>
      </div>
    )
  if (cquBindStatus === 'deleting')
    return (
      <div className="home-cta">
        <Button asChild className="home-brand-action" size="lg">
          <a href={`${AUTH_BASE_URL}/settings/cqu`}>
            查看解绑进度
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
        <p className="home-cta-hint">统一认证账号正在解绑，请等待清理完成后再绑定。</p>
      </div>
    )
  if (isAuthenticated && isCquBound)
    return (
      <div className="home-cta">
        <Button asChild className="home-brand-action" size="lg">
          <Link to="/dashboard?setup=1">
            打开我的订阅
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    )
  const returnTo = window.location.origin + location.pathname + location.search + location.hash
  const bindHref = isAuthenticated
    ? authCquBindUrl(returnTo)
    : authLoginUrl(scheduleSetupTarget(returnTo))
  return (
    <div className="home-cta">
      <Button asChild className="home-brand-action" size="lg">
        <a href={bindHref}>
          {isAuthenticated ? '绑定统一认证账号' : '开始使用'}
          <ArrowRight aria-hidden="true" />
        </a>
      </Button>
      <p className="home-cta-hint">通过 auth.cqu.moe 登录并绑定重庆大学统一认证账号</p>
    </div>
  )
}
