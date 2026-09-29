import { useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation, useMatches } from 'react-router'
import { ContentContainer, ThemeMenu } from '@cqu-moe/ui'
import { useSession } from '@/providers/app'
import { AUTH_BASE_URL, authCquBindUrl } from '@/config/auth'
import { captureSchedulePageview, syncPostHogReplay } from '@/lib/posthog'
import './layout.css'

function LoginLink() {
  const location = useLocation()
  const href = authCquBindUrl(
    window.location.origin + location.pathname + location.search + location.hash,
  )
  return <a href={href}>登录</a>
}

function Layout() {
  const { isAuthenticated } = useSession()
  const location = useLocation()
  const matches = useMatches()
  const titleHandle = [...matches]
    .reverse()
    .find((m) => (m.handle as { title?: string } | null)?.title)

  useEffect(() => {
    document.title =
      (titleHandle?.handle as { title?: string } | undefined)?.title ??
      '重庆大学课表订阅 | CQU Schedule'
    captureSchedulePageview(location.pathname)
    syncPostHogReplay(location.pathname)
  }, [titleHandle, location.pathname])

  return (
    <div className="app-root">
      <header className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="site-brand">
            CQU Schedule
          </Link>
          <nav className="site-nav" aria-label="主导航">
            {isAuthenticated && <NavLink to="/dashboard">仪表盘</NavLink>}
            {isAuthenticated && <NavLink to="/add">添加新订阅</NavLink>}
            {isAuthenticated ? (
              <a href={AUTH_BASE_URL} target="_blank" rel="noopener noreferrer">
                账户
              </a>
            ) : (
              <LoginLink />
            )}
            <NavLink to="/api-docs">API 文档</NavLink>
            <NavLink to="/changelog">更新日志</NavLink>
            <ThemeMenu />
          </nav>
        </div>
      </header>
      <ContentContainer>
        <main className="page-body">
          <Outlet />
        </main>
      </ContentContainer>
    </div>
  )
}

export default Layout

