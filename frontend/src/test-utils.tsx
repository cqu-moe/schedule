import { render, type RenderOptions } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactElement, ReactNode } from 'react'
import { AppContext, type AppContextValue } from '@/providers/app'
import type {
  CalendarCaps,
  MeResponse,
  SessionUser,
  Subscription,
} from '@/types/api'

export function mockSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-uuid-001',
    name: '张三',
    email: 'zhangsan@example.com',
    role: 'student',
    ...overrides,
  }
}

export function mockCalendarCaps(overrides: Partial<CalendarCaps> = {}): CalendarCaps {
  return {
    sync: true,
    external: true,
    share: true,
    change_notification: true,
    sub_limit: 5,
    share_limit: 10,
    sync_interval: 60,
    manual_refresh: 5,
    ...overrides,
  }
}

export function mockMeResponse(
  overrides: Partial<{ user: Partial<SessionUser>; caps: Partial<CalendarCaps> }> = {},
): MeResponse {
  return {
    user: mockSessionUser(overrides.user),
    caps: { calendar: mockCalendarCaps(overrides.caps) },
  }
}

export function mockSubscription(
  overrides: Partial<Subscription> = {},
): Subscription {
  return {
    id: 'sub-1',
    user_id: 'u1',
    source_type: 'personal_all',
    source_id: 'personal',
    source_name: '我的课表',
    session_id: null,
    session_name: null,
    semester_start: '2025-09-01',
    is_personal: true,
    last_synced_at: null,
    sync_status: 'idle',
    sync_run_id: null,
    sync_trigger: null,
    sync_requested_at: null,
    sync_started_at: null,
    sync_finished_at: null,
    sync_error_code: null,
    sync_error_message: null,
    manual_refresh_at: null,
    created_at: '2025-09-01T00:00:00Z',
    updated_at: '2025-09-01T00:00:00Z',
    links: [],
    ...overrides,
  }
}

export const defaultMockSession: AppContextValue = {
  user: {
    id: 'u1',
    name: '测试用户',
    email: 'test@cqu.moe',
    role: 'user',
  },
  caps: {
    sync: true,
    external: true,
    share: true,
    change_notification: true,
    sub_limit: 5,
    share_limit: 10,
    sync_interval: 3600,
    manual_refresh: 3,
  },
  cquBindStatus: 'active',
  publicUrl: 'https://schedule.cqu.moe',
  isAuthenticated: true,
  isCquBound: true,
  isCquUnbound: false,
  can: () => true,
  quota: () => null,
  reloadSession: () => Promise.resolve(mockMeResponse()),
}

export interface RenderWithAppOptions extends Omit<RenderOptions, 'wrapper'> {
  session?: Partial<AppContextValue>
  routerEntries?: string[]
}

export function renderWithApp(
  ui: ReactElement,
  { session, routerEntries = ['/'], ...options }: RenderWithAppOptions = {},
) {
  const value: AppContextValue = { ...defaultMockSession, ...session }
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppContext.Provider value={value}>
        <MemoryRouter initialEntries={routerEntries}>{children}</MemoryRouter>
      </AppContext.Provider>
    ),
    ...options,
  })
}
