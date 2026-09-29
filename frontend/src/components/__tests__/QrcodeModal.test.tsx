import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithApp } from '@/test-utils'
import { activateOPButton } from '@1password/save-button'

const { default: QrcodeModal } = await import('@/components/QrcodeModal')

describe('QrcodeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the QR code and save-in-1Password button when open', async () => {
    renderWithApp(
      <QrcodeModal
        open
        url="https://schedule.cqu.moe/api/v2/calendar/tok1/calendar.ics"
        token="tok1"
        onOpenChange={() => {}}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: '扫码订阅' })
    expect(screen.getByTestId('qrcode')).toBeInTheDocument()
    expect(screen.getByText('使用手机扫描二维码')).toBeInTheDocument()

    const opButton = document.querySelector('onepassword-save-button')
    expect(opButton?.getAttribute('value')).toBe('mock-encoded')
    expect(opButton?.getAttribute('data-onepassword-type')).toBe('login')
    expect(activateOPButton).toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()
  })

  it('renders nothing visible when closed', () => {
    renderWithApp(
      <QrcodeModal open={false} url="https://example.com/x.ics" token="tok1" onOpenChange={() => {}} />,
    )
    expect(screen.queryByTestId('qrcode')).not.toBeInTheDocument()
  })
})
