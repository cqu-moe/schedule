import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FirstSyncNotice from '@/components/FirstSyncNotice.vue'

describe('FirstSyncNotice', () => {
  it('keeps a readable waiting state without a pretend percentage', () => {
    const wrapper = mount(FirstSyncNotice, { props: { phase: 'syncing' } })
    expect(wrapper.find('[role=status]').text()).toContain('正在同步课表')
    expect(wrapper.text()).toContain('首次同步可能需要几分钟。')
    expect(wrapper.text()).not.toMatch(/\d+%/)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('emits retry only when an enabled retry is chosen', async () => {
    const wrapper = mount(FirstSyncNotice, { props: { phase: 'error' } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await wrapper.setProps({ retryDisabled: true })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('lets the user dismiss the completed notice', async () => {
    const wrapper = mount(FirstSyncNotice, { props: { phase: 'success' } })
    await wrapper.find('[aria-label="关闭同步提示"]').trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('does not claim subscriptions were saved when creation failed', () => {
    const wrapper = mount(FirstSyncNotice, {
      props: { phase: 'error', preparationFailed: true },
    })
    expect(wrapper.text()).toContain('订阅准备未完成')
    expect(wrapper.text()).not.toContain('订阅已保留')
  })
})
