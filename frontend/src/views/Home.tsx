import { Link, useLocation } from 'react-router'
import { Button, PageHeader } from '@cqu-moe/ui'
import { Calendar, Lock, RefreshCw } from 'lucide-react'
import { authCquBindUrl } from '@/config/auth'
import { useSession } from '@/providers/app'
import './home.css'

const features = [
  {
    icon: RefreshCw,
    title: '自动同步',
    description: '定时同步课表数据，日历始终保持最新',
  },
  {
    icon: Calendar,
    title: '标准格式',
    description: 'ICS 标准格式，支持所有主流日历应用',
  },
  {
    icon: Lock,
    title: '安全加密',
    description: '通过 CQU 统一身份认证登录，链接令牌控制访问',
  },
]

export default function Home() {
  const { isAuthenticated, isCquBound } = useSession()
  const location = useLocation()

  return (
    <div>
      <PageHeader
        title="重庆大学课表日历订阅"
        description="自动同步课表到你的日历应用，随时随地查看课程安排"
        actions={
          <HomeCta
            isAuthenticated={isAuthenticated}
            isCquBound={isCquBound}
            location={location}
          />
        }
      />
      <section className="home-features" aria-label="功能特性">
        {features.map(({ icon: Icon, title, description }) => (
          <div key={title} className="home-feature">
            <Icon aria-hidden="true" />
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        ))}
      </section>
      <footer className="home-footer">
        <p>
          CQU Schedule ·{' '}
          <Link to="/changelog" className="home-version">
            v{__APP_VERSION__}
          </Link>
        </p>
      </footer>
    </div>
  )
}

function HomeCta({
  isAuthenticated,
  isCquBound,
  location,
}: {
  isAuthenticated: boolean
  isCquBound: boolean
  location: { pathname: string; search: string; hash: string }
}) {
  if (isAuthenticated && isCquBound) {
    return (
      <Button asChild size="lg">
        <Link to="/dashboard?setup=1">开始使用</Link>
      </Button>
    )
  }

  const bindHref = authCquBindUrl(
    window.location.origin + location.pathname + location.search + location.hash,
  )
  return (
    <div className="home-cta">
      <Button asChild size="lg">
        <a href={bindHref}>开始使用</a>
      </Button>
      <p className="home-cta-hint">将前往统一认证中心 auth.cqu.moe，完成后自动返回本站</p>
    </div>
  )
}
