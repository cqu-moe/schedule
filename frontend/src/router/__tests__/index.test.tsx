import { beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { ThemeProvider } from '@cqu-moe/ui'
import { appRoutes } from '@/router'
import { AppProvider } from '@/providers/app'
import api from '@/api'
import { mockMeResponse } from '@/test-utils'
import type { MeResponse } from '@/types/api'

vi.mock('@/api', () => ({ default: {
  getConfig: vi.fn(), getMe: vi.fn(), getSubscriptions: vi.fn(), getNotificationSettings: vi.fn(), getViewData: vi.fn(),
}, redirect: { fn: vi.fn() } }))
vi.mock('@/lib/posthog', () => ({
  captureSchedulePageview: vi.fn(), syncPostHogReplay: vi.fn(), captureScheduleEvent: vi.fn(), syncPostHogIdentity: vi.fn(),
}))

function renderRoute(path: string, delayPath?: string) {
  let resolveModule!: () => void
  const moduleReady = new Promise<void>(resolve => { resolveModule = resolve })
  const routes = appRoutes.map(root => root.index ? { ...root } : ({ ...root, children: root.children?.map(child => {
    const lazy = child.lazy
    return { ...child, ...(child.path === delayPath && typeof lazy === 'function' ? {
      lazy: async () => { await moduleReady; return lazy() },
    } : {}) }
  }) }))
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<ThemeProvider><AppProvider><RouterProvider router={router} /></AppProvider></ThemeProvider>)
  return { router, resolveModule }
}

async function expectLoadedDashboard() {
  await waitFor(() => expect(screen.queryByText('正在读取订阅状态')).not.toBeInTheDocument())
  expect(screen.getByText('自动同步已开启')).toBeInTheDocument()
}

async function navigate(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: ['/'] })
  await router.initialize()
  await router.navigate(path)
  return router
}

describe('router (v2)', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.mocked(api.getMe).mockReset().mockResolvedValue({ ...mockMeResponse(), cquBindStatus: 'active' })
    vi.mocked(api.getConfig).mockResolvedValue({ public_url: window.location.origin })
    vi.mocked(api.getSubscriptions).mockReset().mockResolvedValue({ subscriptions: [], count: 0 })
    vi.mocked(api.getNotificationSettings).mockResolvedValue({ eligible: true, enabled: false })
  })
  it.each(['/', '/dashboard', '/add', '/api-docs'])(
    '%s resolves to a matched route',
    async (path) => {
      const router = await navigate(path)
      expect(router.state.location.pathname).toBe(path)
      expect(router.state.matches.length).toBeGreaterThan(0)
    },
  )

  it('/view/:token resolves with the token param', async () => {
    const router = await navigate('/view/my-link-token')
    expect(router.state.location.pathname).toBe('/view/my-link-token')
    const leaf = router.state.matches.at(-1)
    expect(leaf?.params.token).toBe('my-link-token')
  })

  it('/calendar/:sub_token redirects to /view/:sub_token', async () => {
    const router = await navigate('/calendar/my-link-token')
    expect(router.state.location.pathname).toBe('/view/my-link-token')
    expect(router.state.matches.at(-1)?.params.token).toBe('my-link-token')
  })

  it('unknown paths fall through to the not-found route', async () => {
    const router = await navigate('/nope')
    expect(router.state.location.pathname).toBe('/nope')
    expect(router.state.matches.at(-1)?.route.path).toBe('*')
  })

  it.each(['direct', 'navigation'])('loads the guide on demand with a loading state and keeps its anchor (%s)', async entry => {
    const scrollIntoView = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    try {
      const { router, resolveModule } = renderRoute(entry === 'direct' ? '/api-docs#subscribe' : '/', 'api-docs')
      let navigation: Promise<void> | undefined
      if (entry === 'navigation') {
        await act(async () => { navigation = router.navigate('/api-docs#subscribe') })
      }
      expect(screen.getByRole('heading', { level: 1, name: '使用指南与 API' })).toBeInTheDocument()
      expect(screen.getByText('正在加载使用指南')).toHaveAttribute('role', 'status')
      expect(screen.queryByRole('heading', { name: '订阅到你的日历' })).not.toBeInTheDocument()
      await act(async () => { resolveModule(); await navigation })
      expect(await screen.findByRole('heading', { name: '订阅到你的日历' })).toBeInTheDocument()
      expect(screen.queryByText('正在加载使用指南')).not.toBeInTheDocument()
      expect(router.state.location.hash).toBe('#subscribe')
      expect(scrollIntoView.mock.instances).toContain(document.getElementById('subscribe'))
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it.each(['/dashboard', '/add/?reselect=sub-1', '/Dashboard', '/Add/?reselect=MiXeD-sub'])('keeps %s behind loading UI until both module and session are ready', async path => {
    let resolveSession!: (value: MeResponse) => void
    vi.mocked(api.getMe).mockReturnValue(new Promise(resolve => { resolveSession = resolve }))
    const { router, resolveModule } = renderRoute(path, path.toLowerCase().startsWith('/add') ? 'add' : 'dashboard')
    const heading = path.toLowerCase().startsWith('/add') ? '重新选择教学班' : '我的订阅'
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '登录' })).not.toBeInTheDocument()
    await act(async () => { resolveModule() })
    expect(api.getSubscriptions).not.toHaveBeenCalled()
    expect(screen.queryByText('自动同步未开通')).not.toBeInTheDocument()
    expect(screen.queryByText('暂时无法确认登录状态')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe(path.split('?')[0])
    await act(async () => { resolveSession({ ...mockMeResponse(), cquBindStatus: 'active' }) })
    await waitFor(() => expect(api.getSubscriptions).toHaveBeenCalled())
  })

  it('retries initial session failure without claiming missing permissions or starting protected requests', async () => {
    vi.mocked(api.getMe).mockRejectedValueOnce(new Error('network unavailable'))
    renderRoute('/dashboard')
    expect(await screen.findByText('暂时无法确认登录状态')).toBeInTheDocument()
    expect(api.getSubscriptions).not.toHaveBeenCalled()
    expect(screen.queryByText('自动同步未开通')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await expectLoadedDashboard()
  })

  it('preserves the protected pathname, query and hash after a confirmed 401', async () => {
    vi.mocked(api.getMe).mockRejectedValueOnce({ response: { status: 401 } })
    const { router } = renderRoute('/dashboard?setup=1#subscriptions')
    expect(await screen.findByText('课表会话已结束')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/signed-out')
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/dashboard?setup=1#subscriptions')
    expect(api.getSubscriptions).not.toHaveBeenCalled()
  })

  it('retains the loaded dashboard during background refresh and lazy calendar navigation, then returns', async () => {
    vi.mocked(api.getViewData).mockReturnValue(new Promise(() => {}))
    const { router, resolveModule } = renderRoute('/dashboard', 'view/:token')
    await expectLoadedDashboard()
    let rejectRefresh!: (error: unknown) => void
    vi.mocked(api.getMe).mockReturnValueOnce(new Promise((_, reject) => { rejectRefresh = reject }))
    fireEvent.focus(window)
    expect(screen.getByText('自动同步已开启')).toBeInTheDocument()
    expect(screen.queryByText('正在读取订阅状态')).not.toBeInTheDocument()
    await act(async () => { rejectRefresh(new Error('network unavailable')) })
    expect(screen.getByText('自动同步已开启')).toBeInTheDocument()
    expect(screen.queryByText('暂时无法确认登录状态')).not.toBeInTheDocument()
    let navigation!: Promise<void>
    await act(async () => { navigation = router.navigate('/View/MiXeD-token') })
    expect(screen.getByText('正在打开页面…')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('heading', { level: 1, name: '课表日历' })).toBeInTheDocument()
    expect(screen.getByText('自动同步已开启')).not.toBeVisible()
    await act(async () => { resolveModule(); await navigation })
    expect(router.state.location.pathname).toBe('/View/MiXeD-token')
    expect(api.getViewData).toHaveBeenCalledWith('MiXeD-token')
    expect(screen.getByRole('heading', { level: 1, name: '课表日历' })).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('正在加载课表')
    await act(() => router.navigate(-1))
    await expectLoadedDashboard()
  })
})
