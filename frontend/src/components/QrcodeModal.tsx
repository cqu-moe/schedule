import { useEffect, useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { activateOPButton } from '@1password/save-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cqu-moe/ui'
import { useSession } from '@/providers/app'
import { buildOPSaveValue } from '@/utils/opSave'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'onepassword-save-button': {
        'data-onepassword-type'?: string
        value?: string
        lang?: string
        padding?: string
      }
    }
  }
}

export default function QrcodeModal({
  open,
  url,
  token,
  onOpenChange,
}: {
  open: boolean
  url: string
  token: string
  onOpenChange: (open: boolean) => void
}) {
  const { publicUrl } = useSession()
  const opValue = useMemo(
    () => (open && token ? buildOPSaveValue(publicUrl, token) : ''),
    [open, token, publicUrl],
  )

  useEffect(() => {
    if (open && opValue) activateOPButton()
  }, [open, opValue])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>扫码订阅</DialogTitle>
          <DialogDescription>使用手机扫描二维码订阅日历。</DialogDescription>
        </DialogHeader>
        <div className="qr-body">
          <QRCodeSVG value={url} size={240} level="M" />
          <p className="qr-hint">使用手机扫描二维码</p>
          {opValue && (
            <span className="qr-op-save">
              <onepassword-save-button
                data-onepassword-type="login"
                value={opValue}
                lang="zh-CN"
                padding="none"
              />
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
