import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useMatches, useNavigation } from 'react-router'
import {
  AppShell,
  Button,
  ContentContainer,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useTheme,
  Skeleton,
  PageHeader,
  PageState,
} from '@cqu-moe/ui'
import { normalizePreference } from '@cqu-moe/theme'
import {
  BookOpen,
  CalendarDays,
  House,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Sun,
  UserRound,
} from 'lucide-react'
import { useSession } from '@/providers/app'
import { AUTH_BASE_URL, authLoginUrl, signedOutUrl } from '@/config/auth'
import { captureSchedulePageview, syncPostHogReplay } from '@/lib/posthog'
import './layout.css'
import RouteSkeleton from '@/components/RouteSkeleton'

function AccountMenu() {
  const { isAuthenticated, user, sessionPending, sessionError, reloadSession } = useSession()
  const location = useLocation()
  const logoutForm = useRef<HTMLFormElement>(null)
  if (sessionPending) return <Skeleton className="size-10 rounded-full" role="status" aria-label="正在确认登录状态" />
  if (!isAuthenticated && sessionError === 'unavailable') {
    return <Button variant="outline" size="sm" onClick={() => void reloadSession().catch(() => {})}>重试登录状态</Button>
  }
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

function AppearanceMenu() {
  const { preference, setPreference } = useTheme()
  const [open, setOpen] = useState(false)
  const Icon = preference === 'system' ? Monitor : preference === 'dark' ? Moon : Sun

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="外观设置">
          <Icon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>外观</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            setPreference(normalizePreference(value))
            setOpen(false)
          }}
        >
          <DropdownMenuRadioItem value="light">浅色</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">深色</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function Layout({ children }: { children?: ReactNode }) {
  const { isAuthenticated, sessionPending, sessionError, reloadSession } = useSession()
  const location = useLocation()
  const navigation = useNavigation()
  const matches = useMatches()
  const previousPath = useRef(location.pathname)
  const retainedShell = useRef<HTMLDivElement>(null)
  const title = [...matches].reverse().find((m) => (m.handle as { title?: string })?.title)
    ?.handle as { title?: string } | undefined
  const displayPath = location.pathname.replace(/\/+$/, '') || '/'
  const matchingPath = displayPath.toLowerCase()
  const pendingPath = navigation.location?.pathname.replace(/\/+$/, '') || undefined
  const changingPage = pendingPath !== undefined && pendingPath !== displayPath

  useLayoutEffect(() => {
    if (!changingPage) return
    // AppShell owns a fixed main id; keep skip links targeting the visible shell.
    const main = retainedShell.current?.querySelector<HTMLElement>('#main-content')
    if (!main) return
    main.removeAttribute('id')
    return () => { main.id = 'main-content' }
  }, [changingPage])

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
      <AppearanceMenu />
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
  const protectedPage = matchingPath === '/dashboard' || matchingPath === '/add'
  let page = <Outlet />
  if (protectedPage && !isAuthenticated) {
    if (sessionPending) page = <RouteSkeleton />
    else if (sessionError === 'unauthenticated') {
      page = <Navigate replace to={signedOutUrl(window.location.origin + location.pathname + location.search + location.hash)} />
    } else if (sessionError === 'unavailable') {
      page = <>
        <PageHeader title={matchingPath === '/add' ? '添加新订阅' : '我的订阅'} />
        <PageState state="error" title="暂时无法确认登录状态" description="请重试本次请求。"
          action={<Button variant="outline" onClick={() => void reloadSession().catch(() => {})}>重试</Button>} />
      </>
    }
  }
  const renderShell = (path: string, content: ReactNode) => {
    const shellPath = path.toLowerCase()
    const landing = shellPath === '/'
    const calendar = shellPath.startsWith('/view/') || shellPath.startsWith('/calendar/')
    const reading = ['/api-docs', '/signed-out'].includes(shellPath)

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

  return <>
    <div ref={retainedShell} hidden={changingPage} inert={changingPage}>
      {renderShell(displayPath, children ?? page)}
    </div>
    {changingPage && renderShell(pendingPath, <RouteSkeleton pathname={pendingPath} search={navigation.location?.search} />)}
    {navigation.location && <span className="sr-only" role="status">正在打开页面…</span>}
  </>
}
