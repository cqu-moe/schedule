import { useEffect, useRef } from 'react'
import { Link, NavLink, Outlet, useLocation, useMatches, useNavigation } from 'react-router'
import {
  AppShell,
  Button,
  ContentContainer,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ThemeMenu,
} from '@cqu-moe/ui'
import { BookOpen, CalendarDays, House, LogOut, Plus, UserRound } from 'lucide-react'
import { useSession } from '@/providers/app'
import { AUTH_BASE_URL, authLoginUrl } from '@/config/auth'
import { captureSchedulePageview, syncPostHogReplay } from '@/lib/posthog'
import './layout.css'

function AccountMenu() {
  const { isAuthenticated, user } = useSession()
  const location = useLocation()
  const logoutForm = useRef<HTMLFormElement>(null)
  if (!isAuthenticated) {
    return (
      <Button asChild variant="outline" size="sm">
        <a
          href={authLoginUrl(
            window.location.origin + location.pathname + location.search + location.hash,
          )}
        >
          登录
        </a>
      </Button>
    )
  }
  return (
    <>
      <form ref={logoutForm} method="post" action="/api/v2/auth/logout" hidden />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="账户菜单" title={user?.name || '账户'}>
            <UserRound aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={AUTH_BASE_URL} target="_blank" rel="noopener noreferrer">
              账户设置
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => logoutForm.current?.requestSubmit()}>
            <LogOut aria-hidden="true" />
            退出课表
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export default function Layout() {
  const { isAuthenticated } = useSession()
  const location = useLocation()
  const navigation = useNavigation()
  const matches = useMatches()
  const previousPath = useRef(location.pathname)
  const title = [...matches].reverse().find((m) => (m.handle as { title?: string })?.title)
    ?.handle as { title?: string } | undefined
  const landing = location.pathname === '/'
  const calendar = location.pathname.startsWith('/view/')
  const reading = ['/api-docs', '/signed-out'].includes(location.pathname)

  useEffect(() => {
    document.title = title?.title ?? '重庆大学课表订阅 | CQU Schedule'
    captureSchedulePageview(location.pathname)
    syncPostHogReplay(location.pathname)
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname
      document.getElementById('main-content')?.focus({ preventScroll: true })
      if (!location.hash) window.scrollTo({ top: 0, behavior: 'instant' })
    }
  }, [title?.title, location.pathname, location.hash])

  const brand = (
    <Link to="/" className="site-brand">
      <span className="brand-mark" aria-hidden="true">
        <img
          src="/brand/logo-black.svg"
          alt=""
          width={32}
          height={32}
          className="brand-logo-black"
        />
        <img
          src="/brand/logo-white.svg"
          alt=""
          width={32}
          height={32}
          className="brand-logo-white"
        />
      </span>
      <span>CQU Schedule</span>
    </Link>
  )
  const utilities = (
    <>
      <ThemeMenu />
      <AccountMenu />
    </>
  )
  const navigationItems = (
    <>
      <NavLink to="/" end>
        <House size={16} aria-hidden="true" />
        首页
      </NavLink>
      {isAuthenticated && (
        <>
          <NavLink to="/dashboard">
            <CalendarDays size={16} aria-hidden="true" />
            我的订阅
          </NavLink>
          <NavLink to="/add">
            <Plus size={16} aria-hidden="true" />
            添加订阅
          </NavLink>
        </>
      )}
      <NavLink to="/api-docs">
        <BookOpen size={16} aria-hidden="true" />
        使用与 API
      </NavLink>
    </>
  )
  const content = (
    <>
      {navigation.state !== 'idle' && (
        <div className="route-progress" role="status">
          正在打开页面…
        </div>
      )}
      <Outlet />
    </>
  )

  if (calendar)
    return (
      <div className="calendar-preview">
        <a href="#main-content" className="site-skip">
          跳至正文
        </a>
        <header className="calendar-preview-header">
          {brand}
          <div className="calendar-preview-utilities">{utilities}</div>
        </header>
        <main id="main-content" className="calendar-preview-main" tabIndex={-1}>
          {content}
        </main>
      </div>
    )

  if (landing)
    return (
      <div className="landing-root">
        <a href="#main-content" className="site-skip">
          跳至正文
        </a>
        <header className="landing-header">
          {brand}
          <nav className="landing-utilities" aria-label="主导航">
            <Button asChild variant="ghost" size="sm">
              <Link to={isAuthenticated ? '/dashboard' : '/api-docs'}>
                {isAuthenticated ? '我的订阅' : '使用指南'}
              </Link>
            </Button>
            {utilities}
          </nav>
        </header>
        <ContentContainer>
          <main id="main-content" tabIndex={-1}>
            {content}
          </main>
        </ContentContainer>
      </div>
    )

  return (
    <AppShell brand={brand} navigation={navigationItems} utilities={utilities}>
      <ContentContainer width={reading ? 'reading' : 'compact'}>
        <div className="page-body">{content}</div>
      </ContentContainer>
    </AppShell>
  )
}
