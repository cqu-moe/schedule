import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithContext, mockSubscription, mockCalendarCaps } from '@/test-utils'
import type { CalendarLink } from '@/types/api'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn() }
  const mockApi = {
    getMe: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], count: 0 }),
    getLinks: vi.fn(),
    createLink: vi.fn(),
    patchLink: vi.fn(),
    deleteLink: vi.fn(),
    rotateLink: vi.fn(),
    refreshSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    searchExternal: vi.fn(),
    getDepartments: vi.fn(),
    getViewData: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))
vi.mock('vue-sonner', () => ({ toast: mockToast }))

const { default: ShareLinksDialog } = await import('@/components/ShareLinksDialog.vue')

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDefaultLink(overrides: Partial<CalendarLink> = {}): CalendarLink {
  return {
    id: 'link-default-001',
    token: 'default-token-abc',
    label: null,
    formats: ['ics', 'origin_json', 'data_json', 'csv', 'web'],
    is_default: true,
    ...overrides,
  }
}

function makeShareLink(overrides: Partial<CalendarLink> = {}): CalendarLink {
  return {
    id: 'link-share-001',
    token: 'share-token-xyz',
    label: '同学链接',
    formats: ['ics', 'web'],
    is_default: false,
    ...overrides,
  }
}

/** Default session: share enabled, share_limit=10 */
const DEFAULT_SESSION = {
  user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
  caps: mockCalendarCaps({ share: true, share_limit: 10 }),
  loaded: true,
  loading: false,
}

async function mountDialog(
  links: CalendarLink[] = [makeDefaultLink()],
  sessionOverrides: Partial<typeof DEFAULT_SESSION> = {},
  subStoreOverrides: object = {},
) {
  const sub = mockSubscription({ links })
  mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [sub], count: 1 })

  const { wrapper, pinia } = await mountWithContext(ShareLinksDialog, {
    props: {
      open: true,
      subscription: sub,
    },
    pinia: {
      initialState: {
        session: { ...DEFAULT_SESSION, ...sessionOverrides },
        config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        subscriptions: {
          subscriptions: [sub],
          ...subStoreOverrides,
        },
      },
    },
  })
  await flushPromises()
  return { wrapper, pinia, sub }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ShareLinksDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
  })

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders the dialog title', async () => {
    const { wrapper } = await mountDialog()
    expect(wrapper.text()).toContain('管理共享链接')
  })

  it('shows the subscription source_name in the description', async () => {
    const { wrapper } = await mountDialog()
    expect(wrapper.text()).toContain('张三')
  })

  it('shows "默认链接" label for the default link (null label)', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink({ label: null })])
    expect(wrapper.text()).toContain('默认链接')
  })

  it('shows "默认" badge for the default link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink()])
    expect(wrapper.text()).toContain('默认')
  })

  it('shows link label for non-default share link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink({ label: '同学链接' })])
    expect(wrapper.text()).toContain('同学链接')
  })

  it('shows "未命名" for share link with null label', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink({ label: null })])
    expect(wrapper.text()).toContain('未命名')
  })

  it('shows format badges for each format in a link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink({ formats: ['ics', 'web'] })])
    expect(wrapper.text()).toContain('日历订阅 (ICS)')
    expect(wrapper.text()).toContain('网页查看')
  })

  // ── Default link restrictions ────────────────────────────────────────────────

  it('shows a disabled "修改" button for the default link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink()])
    const editBtn = wrapper.findAll('button').find(b => b.attributes('aria-label') === '修改')
    expect(editBtn).toBeDefined()
    expect(editBtn!.attributes('disabled')).toBeDefined()
  })

  it('shows a disabled link-row "删除" button for the default link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink()])
    const deleteBtn = wrapper.findAll('button')
      .find(b => b.attributes('aria-label') === '删除')
    expect(deleteBtn).toBeDefined()
    expect(deleteBtn!.attributes('disabled')).toBeDefined()
  })

  it('shows "不可删除" note for the default link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink()])
    expect(wrapper.text()).toContain('不可删除')
  })

  it('shows "轮换" button for the default link (rotation allowed)', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink()])
    const rotateBtns = wrapper.findAll('button').filter(b => b.text().trim() === '轮换')
    expect(rotateBtns.length).toBeGreaterThanOrEqual(1)
  })

  // ── Share link actions ───────────────────────────────────────────────────────

  it('shows enabled "修改" and link-row "删除" buttons for non-default share links', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink()])
    const editBtns = wrapper.findAll('button')
      .filter(b => b.attributes('aria-label') === '修改' && b.attributes('disabled') === undefined)
    // Link-row delete button has class text-destructive
    const deleteBtns = wrapper.findAll('button.text-destructive')
      .filter(b => b.attributes('aria-label') === '删除' && b.attributes('disabled') === undefined)
    expect(editBtns.length).toBeGreaterThanOrEqual(1)
    expect(deleteBtns.length).toBeGreaterThanOrEqual(1)
  })

  // ── Copy ─────────────────────────────────────────────────────────────────────

  it('copies the correct buildLinkUrl to clipboard when a copy button is clicked', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink({ formats: ['ics'] })])
    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('ICS'))
    expect(copyBtn).toBeDefined()
    await copyBtn!.trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/api/v2/calendar/default-token-abc/calendar.ics',
    )
  })

  it('copies the correct web URL for the web format', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink({ formats: ['web'] })])
    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('网页'))
    expect(copyBtn).toBeDefined()
    await copyBtn!.trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/view/default-token-abc',
    )
  })

  // ── Rotate (AlertDialog two-step) ────────────────────────────────────────────

  it('opens rotate confirm when "轮换" button is clicked', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink()])
    const rotateBtn = wrapper.findAll('button').find(b => b.text().trim() === '轮换')
    await rotateBtn!.trigger('click')
    await flushPromises()
    // AlertDialog stub renders when open; confirm dialog title should appear
    expect(wrapper.text()).toContain('确认轮换链接 Token')
  })

  it('calls api.rotateLink and updates token on confirm', async () => {
    mockApi.rotateLink.mockResolvedValue({ token: 'new-token-rotated' })
    const { wrapper } = await mountDialog([makeDefaultLink()])

    // Step 1: click Rotate button
    const rotateBtn = wrapper.findAll('button').find(b => b.text().trim() === '轮换')
    await rotateBtn!.trigger('click')
    await flushPromises()

    // Step 2: confirm via AlertDialogAction — stub renders as <button>
    const confirmBtn = wrapper.findAll('button').find(b => b.text().trim() === '轮换' && b !== rotateBtn)
    // There are now two "轮换" buttons: the trigger and the confirm action.
    // Find the one inside AlertDialogAction (it's the last one rendered).
    const allRotateBtns = wrapper.findAll('button').filter(b => b.text().trim() === '轮换')
    const actionBtn = allRotateBtns[allRotateBtns.length - 1]
    await actionBtn.trigger('click')
    await flushPromises()

    expect(mockApi.rotateLink).toHaveBeenCalledWith('sub-uuid-123', 'link-default-001')
    expect(mockToast.success).toHaveBeenCalledWith('已轮换')
  })

  it('shows toast error when rotateLink fails', async () => {
    mockApi.rotateLink.mockRejectedValue({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '轮换失败' } } } },
    })
    const { wrapper } = await mountDialog([makeDefaultLink()])

    const rotateBtn = wrapper.findAll('button').find(b => b.text().trim() === '轮换')
    await rotateBtn!.trigger('click')
    await flushPromises()

    const allRotateBtns = wrapper.findAll('button').filter(b => b.text().trim() === '轮换')
    const actionBtn = allRotateBtns[allRotateBtns.length - 1]
    await actionBtn.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('轮换失败')
  })

  // ── Delete (AlertDialog two-step) ────────────────────────────────────────────

  it('opens delete confirm when "删除" button is clicked for a share link', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink()])
    const deleteBtn = wrapper.findAll('button.text-destructive')
      .find(b => b.attributes('aria-label') === '删除' && b.attributes('disabled') === undefined)
    await deleteBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('确认删除共享链接')
  })

  it('calls api.deleteLink and removes link from list on confirm', async () => {
    mockApi.deleteLink.mockResolvedValue(undefined)
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink()])

    // Step 1: click Delete button
    const deleteBtn = wrapper.findAll('button.text-destructive')
      .find(b => b.attributes('aria-label') === '删除' && b.attributes('disabled') === undefined)
    await deleteBtn!.trigger('click')
    await flushPromises()

    // Step 2: confirm — there are now multiple "删除" buttons (trigger + confirm).
    // The AlertDialogAction stub renders as a button. The confirm one is in the AlertDialog.
    const allDeleteBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    const confirmBtn = allDeleteBtns[allDeleteBtns.length - 1]
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(mockApi.deleteLink).toHaveBeenCalledWith('sub-uuid-123', 'link-share-001')
    expect(mockToast.success).toHaveBeenCalledWith('共享链接已删除')

    // Link should be removed from the local list
    expect(wrapper.text()).not.toContain('同学链接')
  })

  it('shows toast error when deleteLink fails', async () => {
    mockApi.deleteLink.mockRejectedValue({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '删除失败' } } } },
    })
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink()])

    const deleteBtn = wrapper.findAll('button.text-destructive')
      .find(b => b.attributes('aria-label') === '删除' && b.attributes('disabled') === undefined)
    await deleteBtn!.trigger('click')
    await flushPromises()

    const allDeleteBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    const confirmBtn = allDeleteBtns[allDeleteBtns.length - 1]
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('删除失败')
  })

  // ── Create share link ─────────────────────────────────────────────────────────

  it('shows "新建共享链接" button when session.can("share") is true', async () => {
    const { wrapper } = await mountDialog()
    expect(wrapper.text()).toContain('新建共享链接')
    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    expect(createBtn).toBeDefined()
  })

  it('hides "新建共享链接" button and shows hint when share cap is disabled', async () => {
    const { wrapper } = await mountDialog(
      [makeDefaultLink()],
      { caps: mockCalendarCaps({ share: false }) },
    )
    expect(wrapper.text()).not.toContain('新建共享链接')
    expect(wrapper.text()).toContain('共享链接未开通')
  })

  it('"新建共享链接" button is disabled when atShareLimit', async () => {
    // share_limit=2, already 2 non-default links → at limit
    const links = [
      makeDefaultLink(),
      makeShareLink({ id: 'sl-1', token: 't1' }),
      makeShareLink({ id: 'sl-2', token: 't2' }),
    ]
    const sub = mockSubscription({ links })
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [sub], count: 1 })

    const { wrapper } = await mountWithContext(ShareLinksDialog, {
      props: { open: true, subscription: sub },
      pinia: {
        initialState: {
          session: {
            ...DEFAULT_SESSION,
            caps: mockCalendarCaps({ share: true, share_limit: 2 }),
          },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
          subscriptions: { subscriptions: [sub] },
        },
      },
    })
    await flushPromises()

    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    expect(createBtn).toBeDefined()
    expect(createBtn!.attributes('disabled')).toBeDefined()
  })

  it('shows share_limit usage as "used / limit"', async () => {
    const links = [makeDefaultLink(), makeShareLink()]
    const sub = mockSubscription({ links })
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [sub], count: 1 })

    const { wrapper } = await mountWithContext(ShareLinksDialog, {
      props: { open: true, subscription: sub },
      pinia: {
        initialState: {
          session: {
            ...DEFAULT_SESSION,
            caps: mockCalendarCaps({ share: true, share_limit: 10 }),
          },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
          subscriptions: { subscriptions: [sub] },
        },
      },
    })
    await flushPromises()

    // 1 non-default link / limit 10
    expect(wrapper.text()).toContain('1 / 10')
  })

  it('shows "无限" when share_limit is null', async () => {
    const { wrapper } = await mountDialog(
      [makeDefaultLink()],
      { caps: mockCalendarCaps({ share: true, share_limit: null }) },
    )
    expect(wrapper.text()).toContain('无限')
  })

  it('opens create form when "新建共享链接" is clicked', async () => {
    const { wrapper } = await mountDialog()
    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    await createBtn!.trigger('click')
    await flushPromises()
    // The create/edit form Dialog opens
    expect(wrapper.text()).toContain('新建共享链接')
    // Should show the format toggles
    expect(wrapper.text()).toContain('日历订阅 (ICS)')
    expect(wrapper.text()).toContain('网页查看')
  })

  it('calls api.createLink with label and formats, adds link to list', async () => {
    const newLink = makeShareLink({ id: 'new-link-001', token: 'new-token-001', label: '测试链接' })
    mockApi.createLink.mockResolvedValue(newLink)

    const { wrapper } = await mountDialog()

    // Open create form
    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    await createBtn!.trigger('click')
    await flushPromises()

    // Fill in label
    const labelInput = wrapper.find('input#link-label')
    await labelInput.setValue('测试链接')

    // Click 创建
    const submitBtn = wrapper.findAll('button').find(b => b.text().trim() === '创建')
    await submitBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.createLink).toHaveBeenCalledWith(
      'sub-uuid-123',
      expect.objectContaining({ formats: expect.any(Array) }),
    )
    expect(mockToast.success).toHaveBeenCalledWith('共享链接已创建')
    // New link appears in the list
    expect(wrapper.text()).toContain('测试链接')
  })

  it('shows QUOTA_EXCEEDED error in form', async () => {
    mockApi.createLink.mockRejectedValue({
      response: {
        data: { detail: { error: { code: 'QUOTA_EXCEEDED', message: 'quota exceeded' } } },
      },
    })
    const { wrapper } = await mountDialog()

    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    await createBtn!.trigger('click')
    await flushPromises()

    const submitBtn = wrapper.findAll('button').find(b => b.text().trim() === '创建')
    await submitBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('共享链接数量已达上限')
  })

  it('shows INVALID_FORMATS error in form', async () => {
    mockApi.createLink.mockRejectedValue({
      response: {
        data: { detail: { error: { code: 'INVALID_FORMATS', message: 'invalid' } } },
      },
    })
    const { wrapper } = await mountDialog()

    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    await createBtn!.trigger('click')
    await flushPromises()

    const submitBtn = wrapper.findAll('button').find(b => b.text().trim() === '创建')
    await submitBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('格式选择无效')
  })

  it('submit button is disabled when no format is selected', async () => {
    const { wrapper } = await mountDialog()

    // Open the create form
    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    await createBtn!.trigger('click')
    await flushPromises()

    // Deselect 'ics' then 'web' (the two initially selected formats)
    await wrapper.find('button[data-format="ics"]').trigger('click')
    await flushPromises()
    await wrapper.find('button[data-format="web"]').trigger('click')
    await flushPromises()

    // formats=[] → 创建 button should have disabled attribute
    const submitBtn = wrapper.findAll('button').find(b => b.text().trim() === '创建')
    expect(submitBtn).toBeDefined()
    expect(submitBtn!.attributes('disabled')).toBeDefined()
    expect(mockApi.createLink).not.toHaveBeenCalled()
  })

  // ── Edit share link ───────────────────────────────────────────────────────────

  it('opens edit form with existing label and formats pre-filled', async () => {
    const shareLink = makeShareLink({ label: '朋友链接', formats: ['ics'] })
    const { wrapper } = await mountDialog([makeDefaultLink(), shareLink])

    const editBtn = wrapper.findAll('button')
      .find(b => b.attributes('aria-label') === '修改' && b.attributes('disabled') === undefined)
    await editBtn!.trigger('click')
    await flushPromises()

    // Form title should say 编辑共享链接
    expect(wrapper.text()).toContain('编辑共享链接')
    // Label input should be pre-filled
    const labelInput = wrapper.find('input#link-label')
    expect((labelInput.element as HTMLInputElement).value).toBe('朋友链接')
  })

  it('calls api.patchLink and updates the link in the list', async () => {
    const shareLink = makeShareLink({ label: '旧标签' })
    const updatedLink = { ...shareLink, label: '新标签' }
    mockApi.patchLink.mockResolvedValue(updatedLink)

    const { wrapper } = await mountDialog([makeDefaultLink(), shareLink])

    const editBtn = wrapper.findAll('button')
      .find(b => b.attributes('aria-label') === '修改' && b.attributes('disabled') === undefined)
    await editBtn!.trigger('click')
    await flushPromises()

    const labelInput = wrapper.find('input#link-label')
    await labelInput.setValue('新标签')

    const saveBtn = wrapper.findAll('button').find(b => b.text().trim() === '保存')
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.patchLink).toHaveBeenCalledWith(
      'sub-uuid-123',
      'link-share-001',
      expect.objectContaining({ label: '新标签' }),
    )
    expect(mockToast.success).toHaveBeenCalledWith('共享链接已更新')
    expect(wrapper.text()).toContain('新标签')
  })

  // ── Format toggle ─────────────────────────────────────────────────────────────

  it('toggles format selection on and off via format buttons', async () => {
    const { wrapper } = await mountDialog()

    const createBtn = wrapper.findAll('button').find(b => b.text().includes('新建共享链接'))
    await createBtn!.trigger('click')
    await flushPromises()

    // Initially 'ics' is selected (in defaults). Toggle 'ics' off by clicking the button.
    const icsBtn = wrapper.find('button[data-format="ics"]')
    expect(icsBtn.exists()).toBe(true)
    // Initial state: ics is in the defaults ['ics', 'web']
    expect(icsBtn.classes()).toContain('bg-primary')

    await icsBtn.trigger('click')
    await flushPromises()

    // After toggle: ics is not selected, class changes
    expect(icsBtn.classes()).not.toContain('bg-primary')
  })

  // ── I-1: store-derived prop change re-seeds localLinks ───────────────────────

  it('re-seeds localLinks when the subscription prop changes (simulating store reload via Dashboard computed)', async () => {
    // Start with one share link
    const initialLink = makeShareLink({ id: 'sl-1', token: 't1', label: '初始链接' })
    const { wrapper } = await mountDialog([makeDefaultLink(), initialLink])

    // Confirm initial link appears
    expect(wrapper.text()).toContain('初始链接')

    // Simulate what happens in Dashboard after subStore.load() replaces objects:
    // activeShareSub computed returns a new subscription object with updated links.
    // We replicate this by calling setProps with a fresh subscription object.
    const newLink = makeShareLink({ id: 'sl-2', token: 't2', label: '新增链接' })
    const updatedSub = mockSubscription({
      links: [makeDefaultLink(), initialLink, newLink],
    })
    await wrapper.setProps({ subscription: updatedSub })
    await flushPromises()

    // The watch on props.subscription.links re-seeds localLinks with the new array
    expect(wrapper.text()).toContain('初始链接')
    expect(wrapper.text()).toContain('新增链接')
  })

  // ── I-2: closing the outer dialog resets inner dialog open flags ──────────────

  it('resets inner confirm open flags when the outer dialog is closed', async () => {
    const { wrapper } = await mountDialog([makeDefaultLink(), makeShareLink()])

    // Note: the AlertDialog stub always renders its slot regardless of `open`,
    // so we verify the internal reactive state via vm.$.setupState.
    const setupState = (wrapper.vm as any).$.setupState

    // Open the rotate confirm by clicking the rotate trigger
    const rotateBtn = wrapper.findAll('button').find(b => b.text().trim() === '轮换')
    await rotateBtn!.trigger('click')
    await flushPromises()
    // rotateConfirm should now be open
    expect(setupState.rotateConfirm.open).toBe(true)

    // Close the outer dialog
    await wrapper.setProps({ open: false })
    await flushPromises()

    // The watch resets all inner open flags
    expect(setupState.rotateConfirm.open).toBe(false)
    expect(setupState.deleteConfirm.open).toBe(false)
    expect(setupState.linkForm.open).toBe(false)
  })
})
