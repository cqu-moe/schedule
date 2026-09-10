import { describe, expect, it } from 'vitest'
import { authCquBindUrl, scheduleSetupTarget } from '@/config/auth'

describe('Schedule Auth continuation URLs', () => {
  it('enters Auth binding with a dashboard setup return target', () => {
    const result = new URL(authCquBindUrl('https://schedule.cqu.moe/'))
    expect(result.origin + result.pathname).toBe('https://auth.cqu.moe/cqu/bind')
    expect(result.searchParams.get('redirect')).toBe('https://schedule.cqu.moe/dashboard?setup=1')
  })

  it('preserves a protected deep link', () => {
    const result = new URL(authCquBindUrl('https://schedule.cqu.moe/add?from=menu'))
    expect(result.searchParams.get('redirect')).toBe(
      'https://schedule.cqu.moe/add?from=menu&setup=1',
    )
  })

  it('adds repair only to the Auth binding URL', () => {
    const result = new URL(authCquBindUrl('https://schedule.cqu.moe/dashboard', { repair: true }))
    expect(result.searchParams.get('repair')).toBe('1')
    expect(new URL(result.searchParams.get('redirect')!).searchParams.has('repair')).toBe(false)
  })

  it('replaces an existing setup query without dropping the hash', () => {
    expect(scheduleSetupTarget('https://schedule.cqu.moe/add?setup=0#form')).toBe(
      'https://schedule.cqu.moe/add?setup=1#form',
    )
  })
})
