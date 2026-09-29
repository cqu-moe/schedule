import { describe, it, expect } from 'vitest'
import { mountWithContext } from '@/test-utils'
import Changelog from '@/views/Changelog.vue'

describe('Changelog view', () => {
  it('renders page title', async () => {
    const { wrapper } = await mountWithContext(Changelog)
    expect(wrapper.text()).toContain('更新日志')
  })

  it('renders changelog HTML content with h1 stripped', async () => {
    const { wrapper } = await mountWithContext(Changelog)
    const content = wrapper.find('.changelog-content')
    expect(content.exists()).toBe(true)
    expect(content.html()).not.toContain('Changelog</h1>')
    expect(content.find('p').text()).toBe('Test content')
  })
})
