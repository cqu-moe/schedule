import { Link, useLocation } from 'react-router'
import { Button, Skeleton } from '@cqu-moe/ui'
import { ArrowRight, Calendar, Lock, RefreshCw } from 'lucide-react'
import { AUTH_BASE_URL, authCquBindUrl, authLoginUrl, scheduleSetupTarget } from '@/config/auth'
import { useSession } from '@/providers/app'
import './home.css'

const features = [
  {
    icon: RefreshCw,
    title: '自动同步',
    description: '定时获取课程与考试安排，减少手动维护。',
  },
  {
    icon: Calendar,
    title: '标准格式',
    description: '一条 ICS 链接，连接你习惯使用的日历。',
  },
  {
    icon: Lock,
    title: '分享可控',
    description: '按需选择共享格式，也可以随时停用共享链接。',
  },
]

export default function Home() {
  const { isAuthenticated, isCquBound, cquBindStatus, sessionPending, sessionError, reloadSession } = useSession()
  const location = useLocation()

  return (
    <div className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-intro">
          <p className="home-eyebrow">重庆大学课表日历订阅</p>
          <h1 id="home-title">
            课表，放进
            <br />
            你常用的日历。
          </h1>
          <p className="home-description">
            课程、考试，一处安排。订阅一次，在手机和电脑上随时查看，让下一节课更从容。
          </p>
          {sessionPending ? <div className="home-cta" aria-busy="true">
            <span className="sr-only" role="status">正在确认登录状态</span>
            <Button size="lg" disabled aria-hidden="true"><Skeleton><span className="invisible inline-flex items-center gap-2">开始使用<ArrowRight /></span></Skeleton></Button>
          </div> : !isAuthenticated && sessionError === 'unavailable' ? <div className="home-cta">
            <p className="home-cta-hint" role="status">暂时无法确认登录状态，请重试。</p>
            <Button size="lg" onClick={() => void reloadSession().catch(() => {})}>重试登录状态</Button>
          </div> : <HomeCta
            isAuthenticated={isAuthenticated}
            isCquBound={isCquBound}
            isDeleting={cquBindStatus === 'deleting'}
            location={location}
          />}
          <p className="home-compatibility">Apple 日历 · Google Calendar · Outlook</p>
        </div>
        <aside className="home-guide" aria-labelledby="home-guide-title">
          <div className="home-guide-heading">
            <Calendar size={24} aria-hidden="true" />
            <div>
              <h2 id="home-guide-title">从课表到日历，只需三步</h2>
              <p>使用你已有的日历应用</p>
            </div>
          </div>
          <ol className="home-steps">
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>登录并绑定账号</h3>
                <p>通过认证中心连接重庆大学统一认证账号。</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div>
                <h3>选择你的课表</h3>
                <p>全部安排、仅课程或仅考试，按需订阅。</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">03</span>
              <div>
                <h3>添加到日历应用</h3>
                <p>复制订阅链接，粘贴到日历的订阅入口。</p>
              </div>
            </li>
          </ol>
          <Link to="/api-docs#subscribe" className="home-guide-link">
            查看订阅指南
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </aside>
      </section>
      <section className="home-features" aria-label="功能特性">
        {features.map(({ icon: Icon, title, description }) => (
          <div key={title} className="home-feature">
            <Icon size={20} aria-hidden="true" />
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </div>
        ))}
      </section>
      <footer className="home-footer">
        <p>CQU Schedule · 让课表随行</p>
      </footer>
    </div>
  )
}

function HomeCta({
  isDeleting,
  isAuthenticated,
  isCquBound,
  location,
}: {
  isDeleting: boolean
  isAuthenticated: boolean
  isCquBound: boolean
  location: { pathname: string; search: string; hash: string }
}) {
  if (isDeleting) {
    return (
      <div className="home-cta">
        <p className="home-cta-hint">统一认证账号正在解绑，请等待清理完成后再绑定。</p>
        <Button asChild size="lg">
          <a href={`${AUTH_BASE_URL}/settings/cqu`}>查看解绑进度</a>
        </Button>
      </div>
    )
  }
  if (isAuthenticated && isCquBound) {
    return (
      <div className="home-cta">
        <Button asChild size="lg">
          <Link to="/dashboard?setup=1">
            开始使用
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    )
  } else {
    const returnTo = window.location.origin + location.pathname + location.search + location.hash
    const bindHref = isAuthenticated
      ? authCquBindUrl(returnTo)
      : authLoginUrl(scheduleSetupTarget(returnTo))
    return (
      <div className="home-cta">
        <Button asChild size="lg">
          <a href={bindHref}>
            开始使用
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
        <p className="home-cta-hint">将前往统一认证中心 auth.cqu.moe，完成后自动返回本站</p>
      </div>
    )
  }
}
