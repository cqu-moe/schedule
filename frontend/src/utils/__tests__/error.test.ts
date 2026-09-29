import { describe, it, expect } from 'vitest'
import { parseApiError, apiErrorCode } from '@/utils/error'

describe('apiErrorCode', () => {
  it('extracts error code from nested error shape', () => {
    const err = { response: { data: { detail: { error: { code: 'CQU_SESSION_INACTIVE', message: 'inactive' } } } } }
    expect(apiErrorCode(err)).toBe('CQU_SESSION_INACTIVE')
  })

  it('returns undefined for string-detail shape (no nested error)', () => {
    const err = { response: { data: { detail: '操作过于频繁，请稍后再试' } } }
    expect(apiErrorCode(err)).toBeUndefined()
  })

  it('returns undefined when detail has no error.code', () => {
    const err = { response: { data: { detail: { error: { message: 'some message' } } } } }
    expect(apiErrorCode(err)).toBeUndefined()
  })

  it('returns undefined for non-axios error (no response)', () => {
    expect(apiErrorCode(new Error('network'))).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(apiErrorCode(null)).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(apiErrorCode(undefined)).toBeUndefined()
  })

  it('returns undefined when response has no data', () => {
    expect(apiErrorCode({ response: {} })).toBeUndefined()
  })
})

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
