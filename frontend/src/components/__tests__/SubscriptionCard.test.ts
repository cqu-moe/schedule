import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SubscriptionCard from '@/components/SubscriptionCard.vue'

describe('SubscriptionCard', () => {
  const defaultProps = {
    title: '课表订阅',
    url: 'https://schedule.cqu.moe/api/v1/subscriptions/abc123/calendar.ics',
  }

  beforeEach(() => {
    vi.mocked(navigator.clipboard.writeText).mockClear()
  })

  it('renders title and url from props', () => {
    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    expect(wrapper.text()).toContain('课表订阅')
    expect(wrapper.text()).toContain(defaultProps.url)
  })

  it('copy button calls clipboard.writeText with url', async () => {
    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    const copyButton = wrapper.findAll('button').find((b) => b.text().includes('复制'))!
    expect(copyButton).toBeTruthy()

    await copyButton.trigger('click')

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(defaultProps.url)
  })

  it('shows "已复制" after copy, reverts after 1.5s', async () => {
    vi.useFakeTimers()

    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    const copyButton = wrapper.findAll('button').find((b) => b.text().includes('复制'))!
    await copyButton.trigger('click')

    // Wait for the async clipboard call to resolve
    await flushPromises()

    expect(wrapper.text()).toContain('已复制')

    // Advance past the 1.5s timeout
    await vi.advanceTimersByTimeAsync(1500)

    expect(wrapper.text()).not.toContain('已复制')
    expect(wrapper.text()).toContain('复制')

    vi.useRealTimers()
  })

  it('QR button emits show-qrcode with url', async () => {
    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    const qrButton = wrapper.findAll('button').find((b) => b.text().includes('二维码'))!
    expect(qrButton).toBeTruthy()

    await qrButton.trigger('click')

    expect(wrapper.emitted('show-qrcode')).toBeTruthy()
    expect(wrapper.emitted('show-qrcode')![0]).toEqual([defaultProps.url])
  })
})
