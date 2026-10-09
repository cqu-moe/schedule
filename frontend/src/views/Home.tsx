import { Link, useLocation } from 'react-router'
import { Button } from '@cqu-moe/ui'
import { Calendar, Lock, RefreshCw } from 'lucide-react'
import { AUTH_BASE_URL, authCquBindUrl, authLoginUrl, scheduleSetupTarget } from '@/config/auth'
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
  const { isAuthenticated, isCquBound, cquBindStatus } = useSession()
  const location = useLocation()

  return (
    <div>
      <section className="home-hero">
        <h1>重庆大学课表日历订阅</h1>
        <p>自动同步课表到你的日历应用，随时随地查看课程安排</p>
        <HomeCta
          isAuthenticated={isAuthenticated}
          isCquBound={isCquBound}
          isDeleting={cquBindStatus === 'deleting'}
          location={location}
        />
      </section>
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
    return <div className="home-cta">
      <p className="home-cta-hint">统一认证账号正在解绑，请等待清理完成后再绑定。</p>
      <Button asChild size="lg"><a href={`${AUTH_BASE_URL}/settings/cqu`}>查看解绑进度</a></Button>
    </div>
  }
  if (isAuthenticated && isCquBound) {
    return (
      <div className="home-cta">
        <Button asChild size="lg">
          <Link to="/dashboard?setup=1">开始使用</Link>
        </Button>
      </div>
    )
  } else {
    const returnTo = window.location.origin + location.pathname + location.search + location.hash
    const bindHref = isAuthenticated ? authCquBindUrl(returnTo) : authLoginUrl(scheduleSetupTarget(returnTo))
    return (
      <div className="home-cta">
        <Button asChild size="lg">
          <a href={bindHref}>开始使用</a>
        </Button>
        <p className="home-cta-hint">将前往统一认证中心 auth.cqu.moe，完成后自动返回本站</p>
      </div>
    )
  }
}
