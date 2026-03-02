import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import RiskWarning from '@/components/RiskWarning.vue'

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
}

describe('RiskWarning', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function mountRiskWarning(props = { modelValue: true }) {
    const router = createTestRouter()
    const wrapper = mount(RiskWarning, {
      props,
      global: { plugins: [router] },
    })
    return { wrapper, router }
  }

  it('renders warning content when open', () => {
    const { wrapper } = mountRiskWarning()

    expect(wrapper.text()).toContain('使用本服务前请注意')
    expect(wrapper.text()).toContain('你的密码会被加密存储在服务器上')
  })

  it('confirm button is disabled until checkbox is checked', async () => {
    const { wrapper } = mountRiskWarning()

    // Find the confirm button (AlertDialogAction stub renders as <button>)
    const confirmButton = wrapper.findAll('button').find((b) => b.text().includes('确认'))!
    expect(confirmButton).toBeTruthy()
    expect(confirmButton.attributes('disabled')).toBeDefined()

    // Check the checkbox
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)

    // Confirm button should now be enabled
    expect(confirmButton.attributes('disabled')).toBeUndefined()
  })

  it('confirm sets localStorage and emits update:modelValue(false)', async () => {
    const { wrapper } = mountRiskWarning()

    // Check the checkbox first
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)

    // Click confirm
    const confirmButton = wrapper.findAll('button').find((b) => b.text().includes('确认'))!
    await confirmButton.trigger('click')

    expect(localStorage.getItem('risk_warning_acknowledged')).toBe('true')
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([false])
  })

  it('cancel emits update:modelValue(false) and navigates to /', async () => {
    const { wrapper, router } = mountRiskWarning()

    const cancelButton = wrapper.findAll('button').find((b) => b.text().includes('返回首页'))!
    expect(cancelButton).toBeTruthy()

    await cancelButton.trigger('click')
    await router.isReady()

    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([false])
    expect(router.currentRoute.value.path).toBe('/')
  })
})
