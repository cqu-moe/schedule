const CODE_MESSAGES: Record<string, string> = {
  CAPTCHA_REQUIRED: '验证码验证失败，请刷新页面重试',
  CAPTCHA_FAILED: '验证码验证失败，请刷新页面重试',
  CAPTCHA_SERVICE_UNAVAILABLE: '验证码验证失败，请刷新页面重试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
}

export function parseApiError(error: unknown, fallback = '操作失败'): string {
  const resp = (error as any)?.response
  if (!resp?.data) return fallback

  const detail = resp.data.detail
  if (!detail) return fallback

  const code = detail?.error?.code
  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code]
  }

  return detail?.error?.message ?? fallback
}
