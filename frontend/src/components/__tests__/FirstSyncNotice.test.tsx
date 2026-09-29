import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithApp } from '@/test-utils'

const { default: FirstSyncNotice } = await import('@/components/FirstSyncNotice')

function renderNotice(props: Partial<Parameters<typeof FirstSyncNotice>[0]> = {}) {
  const onRetry = vi.fn()
  const onDismiss = vi.fn()
  renderWithApp(
    <FirstSyncNotice
      phase="preparing"
      onRetry={onRetry}
      onDismiss={onDismiss}
      {...props}
    />,
  )
  return { onRetry, onDismiss }
}

describe('FirstSyncNotice', () => {
  it('renders the preparing phase without description', () => {
    renderNotice({ phase: 'preparing' })
    expect(screen.getByText('正在准备订阅')).toBeInTheDocument()
    expect(screen.queryByText(/首次同步可能需要几分钟/)).not.toBeInTheDocument()
  })

  it('renders the syncing phase with description and no actions', () => {
    renderNotice({ phase: 'syncing' })
    expect(screen.getByText('正在同步课表')).toBeInTheDocument()
    expect(screen.getByText('首次同步可能需要几分钟。')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders success with a dismiss control', () => {
    const { onDismiss } = renderNotice({ phase: 'success' })
    expect(screen.getByText('课表已同步')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭同步提示' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders error with retry, hint and error message', () => {
    const { onRetry } = renderNotice({
      phase: 'error',
      errorMessage: '同步服务暂时不可用',
      retryDisabled: true,
      retryHint: '今日手动刷新次数已达上限',
    })
    expect(screen.getByText('暂时无法同步')).toBeInTheDocument()
    expect(screen.getByText('同步服务暂时不可用')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: '重试' })
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute('title', '今日手动刷新次数已达上限')
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('fires retry when enabled', () => {
    const { onRetry } = renderNotice({ phase: 'error' })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the preparation-failed title over the phase title', () => {
    renderNotice({ phase: 'error', preparationFailed: true })
    expect(screen.getByText('订阅准备未完成')).toBeInTheDocument()
    expect(screen.getByText('请重试。')).toBeInTheDocument()
  })
})
