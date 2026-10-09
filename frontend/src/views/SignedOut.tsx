import { Button, PageHeader, PageState } from '@cqu-moe/ui'
import { authLoginUrl } from '@/config/auth'

export default function SignedOut() {
  const requested = new URLSearchParams(window.location.search).get('returnTo')
  let target = new URL('/dashboard', window.location.origin)
  try {
    const value = new URL(requested || '/dashboard', window.location.origin)
    if (value.origin === window.location.origin && value.pathname !== '/signed-out') target = value
  } catch { /* Keep the local dashboard destination. */ }
  return <>
    <PageHeader title="已退出课表" />
    <PageState state="empty" title="课表会话已结束" description="其他应用的登录与后台课表同步保持运行。需要继续时，请重新登录。"
      action={<Button asChild><a href={authLoginUrl(target.href)}>重新登录</a></Button>} />
  </>
}
