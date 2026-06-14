import { describe, it, expect } from 'vitest'
import { parseApiError } from '@/utils/error'

describe('parseApiError', () => {
  it('returns error message from structured error', () => {
    const error = { response: { data: { detail: { error: { code: 'BAD_REQUEST', message: '自定义错误' } } } } }
    expect(parseApiError(error)).toBe('自定义错误')
  })

  it('maps RATE_LIMITED code to message', () => {
    const error = { response: { data: { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } } } }
    expect(parseApiError(error)).toBe('操作过于频繁，请稍后再试')
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
