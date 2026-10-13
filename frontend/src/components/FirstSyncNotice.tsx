import { Check, CircleAlert, Loader2, X } from 'lucide-react'
import { Button } from '@cqu-moe/ui'
import type { FirstSyncPhase } from '@/lib/first-sync-state'

const TITLES: Record<FirstSyncPhase, string> = {
  preparing: '正在准备订阅',
  syncing: '正在同步课表',
  success: '课表已同步',
  error: '暂时无法同步',
}

const DESCRIPTIONS: Record<FirstSyncPhase, string> = {
  preparing: '',
  syncing: '首次同步可能需要几分钟。',
  success: '复制订阅链接，添加到你的日历。',
  error: '订阅已保留，请稍后重试。',
}

export default function FirstSyncNotice({
  phase,
  preparationFailed = false,
  errorMessage = '',
  retryDisabled = false,
  retryHint = '',
  onRetry,
  onDismiss,
}: {
  phase: FirstSyncPhase
  preparationFailed?: boolean
  errorMessage?: string
  retryDisabled?: boolean
  retryHint?: string
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <div className="sync-notice" role="status" aria-live="polite">
      <div className="sync-notice-body">
        <span className="sync-notice-icon feedback-icon" aria-hidden="true">
          <span data-active={phase === 'syncing' || phase === 'preparing'}>
            <Loader2 className="sync-icon-spin" />
          </span>
          <span data-active={phase === 'success'}>
            <Check className="sync-icon-success" />
          </span>
          <span data-active={phase === 'error'}>
            <CircleAlert className="sync-icon-error" />
          </span>
        </span>
        <div className="sync-notice-text">
          <p className="sync-notice-title">
            {preparationFailed ? '订阅准备未完成' : TITLES[phase]}
          </p>
          {phase !== 'preparing' && (
            <p className="sync-notice-desc">
              {errorMessage || (preparationFailed ? '请重试。' : DESCRIPTIONS[phase])}
            </p>
          )}
        </div>
        {phase === 'error' && (
          <Button
            variant="outline"
            size="sm"
            disabled={retryDisabled}
            title={retryHint || undefined}
            onClick={onRetry}
          >
            重试
          </Button>
        )}
        {phase === 'success' && (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="sync-notice-close"
            aria-label="关闭同步提示"
            onClick={onDismiss}
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  )
}
