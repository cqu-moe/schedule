import { describe, it, expect } from 'vitest'
import { parseApiError } from '@/utils/error'

describe('parseApiError', () => {
  it('returns string detail directly', () => {
    const error = { response: { data: { detail: '自定义错误' } } }
    expect(parseApiError(error)).toBe('自定义错误')
  })

  it('maps CAPTCHA_REQUIRED string detail to message', () => {
    const error = { response: { data: { detail: 'CAPTCHA_REQUIRED' } } }
    expect(parseApiError(error)).toBe('验证码验证失败，请刷新页面重试')
  })

  it('maps CAPTCHA_FAILED string detail to message', () => {
    const error = { response: { data: { detail: 'CAPTCHA_FAILED' } } }
    expect(parseApiError(error)).toBe('验证码验证失败，请刷新页面重试')
  })

  it('maps USER_EXISTS error code to message', () => {
    const error = { response: { data: { detail: { error: { code: 'USER_EXISTS' } } } } }
    expect(parseApiError(error)).toBe('该账号已注册，请使用 Token 登录')
  })

  it('returns error.message from structured error', () => {
    const error = { response: { data: { detail: { error: { message: '具体错误信息' } } } } }
    expect(parseApiError(error)).toBe('具体错误信息')
  })

  it('prefers code mapping over error.message', () => {
    const error = { response: { data: { detail: { error: { code: 'USER_EXISTS', message: '其他消息' } } } } }
    expect(parseApiError(error)).toBe('该账号已注册，请使用 Token 登录')
  })

  it('returns fallback when no response', () => {
    expect(parseApiError({}, '网络错误')).toBe('网络错误')
  })

  it('returns fallback when no data', () => {
    expect(parseApiError({ response: {} }, '网络错误')).toBe('网络错误')
  })

  it('returns fallback when no detail', () => {
    expect(parseApiError({ response: { data: {} } }, '请求失败')).toBe('请求失败')
  })

  it('returns default fallback "操作失败" when no fallback provided', () => {
    expect(parseApiError(null)).toBe('操作失败')
  })
})
