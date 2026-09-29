import { useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation, useMatches } from 'react-router'
import { AppShell, ContentContainer, ThemeMenu } from '@cqu-moe/ui'
import { useSession } from '@/providers/app'
import { AUTH_BASE_URL, authCquBindUrl } from '@/config/auth'
import { captureSchedulePageview, syncPostHogReplay } from '@/lib/posthog'

function LoginLink() {
  const location = useLocation()
  const href = authCquBindUrl(
    window.location.origin + location.pathname + location.search + location.hash,
  )
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      登录
    </a>
  )
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
    <AppShell
      brand="CQU Schedule"
      utilities={<ThemeMenu />}
      navigation={
        <>
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
        </>
      }
    >
      <ContentContainer>
        <Outlet />
      </ContentContainer>
    </AppShell>
  )
}

export default Layout
