const CODE_MESSAGES: Record<string, string> = {
  CAPTCHA_REQUIRED: '验证码验证失败，请刷新页面重试',
  CAPTCHA_FAILED: '验证码验证失败，请刷新页面重试',
  USER_EXISTS: '该账号已注册，请使用 Token 登录',
}

export function parseApiError(error: unknown, fallback = '操作失败'): string {
  const resp = (error as any)?.response
  if (!resp?.data) return fallback

  const detail = resp.data.detail
  if (!detail) return fallback

  // detail is string (including 429 interceptor result)
  if (typeof detail === 'string') {
    return CODE_MESSAGES[detail] || detail
  }

  // detail.error.code special mapping
  const code = detail?.error?.code
  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code]
  }

  // detail.error.message
  if (detail?.error?.message) {
    return detail.error.message
  }

  return fallback
}
