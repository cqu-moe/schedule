import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QrcodeModal from '@/components/QrcodeModal.vue'

describe('QrcodeModal', () => {
  const defaultProps = {
    modelValue: true,
    url: 'https://schedule.cqu.moe/api/v2/calendar/abc123/calendar.ics',
  }

  it('renders "扫码订阅" text when modelValue is true', () => {
    const wrapper = mount(QrcodeModal, { props: defaultProps })

    expect(wrapper.text()).toContain('扫码订阅')
  })

  it('does not render content when modelValue is false', () => {
    const wrapper = mount(QrcodeModal, {
      props: { ...defaultProps, modelValue: false },
    })

    // The Dialog stub uses v-if="open", so content should not be rendered
    expect(wrapper.text()).not.toContain('扫码订阅')
    expect(wrapper.find('[data-testid="qrcode"]').exists()).toBe(false)
  })
})
