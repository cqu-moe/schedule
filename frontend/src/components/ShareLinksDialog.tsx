import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  Check,
  Copy,
  CircleAlert,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react'
import {
  ActionButton,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@cqu-moe/ui'
import api from '@/api'
import { useButtonFeedback } from '@/hooks/useButtonFeedback'
import { useSession } from '@/providers/app'
import type { CalendarLink, LinkFormat, Subscription } from '@/types/api'
import { apiErrorCode, parseApiError } from '@/utils/error'
import { buildLinkUrl } from '@/utils/links'
import { captureScheduleEvent } from '@/lib/posthog'

const ALL_FORMATS: LinkFormat[] = ['ics', 'web', 'data_json', 'origin_json', 'csv']
const DEFAULT_CREATE_FORMATS: LinkFormat[] = ['ics', 'web']

const FORMAT_META: Record<LinkFormat, { label: string; headerLabel: string }> = {
  ics: { label: '日历订阅 (ICS)', headerLabel: '订阅' },
  web: { label: '日历网页查看', headerLabel: '网页' },
  data_json: { label: 'JSON', headerLabel: 'JSON' },
  origin_json: { label: '原始 JSON', headerLabel: '原始' },
  csv: { label: 'CSV', headerLabel: 'CSV' },
}

function captureCopyAction(format: LinkFormat, outcome: 'success' | 'failure'): void {
  captureScheduleEvent('schedule_action_finished', {
    actor_type: 'user',
    trigger: 'user',
    operation: 'copy_calendar_link',
    outcome,
    format,
  })
}

interface LinkFormState {
  open: boolean
  editingId: string | null
  label: string
  formats: LinkFormat[]
  submitting: boolean
}

const CLOSED_LINK_FORM: LinkFormState = {
  open: false,
  editingId: null,
  label: '',
  formats: [...DEFAULT_CREATE_FORMATS],
  submitting: false,
}

export default function ShareLinksDialog({
  open,
  subscription,
  shareLinkCount,
  atShareLimit,
  onOpenChange,
  onChanged,
  onCloseAutoFocus,
}: {
  open: boolean
  subscription: Subscription
  shareLinkCount: number
  atShareLimit: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const session = useSession()
  const [localLinks, setLocalLinks] = useState<CalendarLink[]>(() => [...subscription.links])
  const [rotateConfirm, setRotateConfirm] = useState<{ open: boolean; linkId: string | null }>({
    open: false,
    linkId: null,
  })
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; linkId: string | null }>({
    open: false,
    linkId: null,
  })
  const [linkForm, setLinkForm] = useState<LinkFormState>(CLOSED_LINK_FORM)
  const [linkFormError, setLinkFormError] = useState<string | null>(null)
  const copyFeedback = useButtonFeedback()
  const nestedTriggerRef = useRef<HTMLButtonElement | null>(null)
  const shareDialogRef = useRef<HTMLDivElement | null>(null)

  function restoreNestedFocus(event: Event) {
    if (!open || !shareDialogRef.current?.isConnected) return
    event.preventDefault()
    const trigger = nestedTriggerRef.current
    if (trigger?.isConnected && !trigger.disabled) trigger.focus()
    else shareDialogRef.current.focus()
  }

  // Re-seed local links when the store-derived subscription prop changes identity
  // (covers reloads after mutation AND reopening for a different subscription).
  useEffect(() => {
    setLocalLinks([...subscription.links])
  }, [subscription.links])

  // Reset transient inner-dialog state when the outer dialog closes.
  useEffect(() => {
    if (!open) {
      setRotateConfirm({ open: false, linkId: null })
      setDeleteConfirm({ open: false, linkId: null })
      setLinkForm((current) => ({ ...current, open: false }))
    }
  }, [open])

  const shareLimit = session.quota('share_limit')
  const customLinkCount = localLinks.filter((link) => !link.is_default).length
  const shareFooterText =
    shareLimit === null
      ? `共享链接 ${shareLinkCount} / 无限`
      : `共享链接 ${shareLinkCount} / ${shareLimit}`
  const subscriptionUnavailable = subscription.source_version === 1 && subscription.external_state !== undefined && subscription.external_state !== 'active'
  const linkUnavailable = (link: CalendarLink) => subscriptionUnavailable || link.is_active === false
  const shareFooterHint = subscriptionUnavailable
    ? '教学班已停用，全部公开链接暂不可用；日历客户端已下载的历史事件无法撤回。'
    : !session.can('share')
    ? '默认链接仍可复制使用，额外共享链接需开通后创建。'
    : atShareLimit
      ? '已达到账号共享链接上限，删除旧链接后才能新建。'
      : customLinkCount === 0
        ? '本课表还没有额外共享链接。'
        : `本课表 ${customLinkCount} 个额外共享链接；额度按账号统计。`

  async function handleCopy(link: CalendarLink, fmt: LinkFormat) {
    if (linkUnavailable(link)) return
    const url = buildLinkUrl(session.publicUrl, link.token, fmt)
    try {
      await copyFeedback.run(async () => {
        await navigator.clipboard.writeText(url)
      }, `${link.id}:${fmt}`)
      captureCopyAction(fmt, 'success')
    } catch {
      captureCopyAction(fmt, 'failure')
      toast.error('复制失败，请手动复制链接')
    }
  }

  function openCreateForm(event: MouseEvent<HTMLButtonElement>) {
    nestedTriggerRef.current = event.currentTarget
    setLinkForm({
      open: true,
      editingId: null,
      label: '',
      formats: [...DEFAULT_CREATE_FORMATS],
      submitting: false,
    })
    setLinkFormError(null)
  }

  function openEditLink(link: CalendarLink, trigger: HTMLButtonElement) {
    nestedTriggerRef.current = trigger
    setLinkForm({
      open: true,
      editingId: link.id,
      label: link.label ?? '',
      formats: [...link.formats],
      submitting: false,
    })
    setLinkFormError(null)
  }

  function toggleFormat(fmt: LinkFormat) {
    setLinkForm((current) => ({
      ...current,
      formats: current.formats.includes(fmt)
        ? current.formats.filter((f) => f !== fmt)
        : [...current.formats, fmt],
    }))
    setLinkFormError(null)
  }

  async function handleRotate() {
    const lid = rotateConfirm.linkId
    setRotateConfirm({ open: false, linkId: null })
    if (!lid) return
    try {
      const result = await api.rotateLink(subscription.id, lid)
      setLocalLinks((current) =>
        current.map((link) => (link.id === lid ? { ...link, token: result.token } : link)),
      )
      toast.success('已轮换')
      onChanged()
    } catch (error) {
      toast.error(parseApiError(error, '轮换失败'))
    }
  }

  async function handleDeleteLink() {
    // The originating row will disappear; return to the stable parent dialog.
    nestedTriggerRef.current = null
    const lid = deleteConfirm.linkId
    setDeleteConfirm({ open: false, linkId: null })
    if (!lid) return
    try {
      await api.deleteLink(subscription.id, lid)
      setLocalLinks((current) => current.filter((link) => link.id !== lid))
      toast.success('共享链接已删除')
      onChanged()
    } catch (error) {
      toast.error(parseApiError(error, '删除失败'))
    }
  }

  async function handleSubmitLinkForm() {
    if (linkForm.formats.length === 0) {
      setLinkFormError('至少选择一种格式')
      return
    }
    setLinkFormError(null)
    setLinkForm((current) => ({ ...current, submitting: true }))

    const labelValue = linkForm.label.trim() || undefined
    try {
      if (linkForm.editingId) {
        const updated = await api.patchLink(subscription.id, linkForm.editingId, {
          label: labelValue ?? null,
          formats: linkForm.formats,
        })
        setLocalLinks((current) =>
          current.map((link) => (link.id === linkForm.editingId ? updated : link)),
        )
        toast.success('共享链接已更新')
      } else {
        const created = await api.createLink(subscription.id, {
          label: labelValue,
          formats: linkForm.formats,
        })
        setLocalLinks((current) => [...current, created])
        toast.success('共享链接已创建')
      }
      setLinkForm((current) => ({ ...current, open: false }))
      onChanged()
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'QUOTA_EXCEEDED') setLinkFormError('共享链接数量已达上限')
      else if (code === 'INVALID_FORMATS') setLinkFormError('格式选择无效，请重新选择')
      else if (code === 'FEATURE_NOT_ENABLED') setLinkFormError('共享链接功能未开通')
      else setLinkFormError(parseApiError(error, '操作失败'))
    } finally {
      setLinkForm((current) => ({ ...current, submitting: false }))
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent ref={shareDialogRef} className="share-dialog" onCloseAutoFocus={onCloseAutoFocus}>
          <div className="share-dialog-body">
            <DialogHeader className="share-dialog-header">
              <DialogTitle>管理共享链接</DialogTitle>
              <DialogDescription>「{subscription.source_name}」的共享链接。</DialogDescription>
            </DialogHeader>

            <div className="share-dialog-scroll">
              <div className="share-table-wrap">
                <Table className="share-table">
                  <colgroup>
                    <col className="share-col-link" />
                    {ALL_FORMATS.map((fmt) => (
                      <col key={fmt} className="share-col-format" />
                    ))}
                    <col className="share-col-actions" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="share-sticky-left">链接</TableHead>
                      {ALL_FORMATS.map((fmt) => (
                        <TableHead key={fmt} title={FORMAT_META[fmt].label}>
                          <span aria-hidden="true">{FORMAT_META[fmt].headerLabel}</span>
                          <span className="sr-only">{FORMAT_META[fmt].label}</span>
                        </TableHead>
                      ))}
                      <TableHead className="share-sticky-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {localLinks.map((link) => (
                      <TableRow key={link.id}>
                        <TableCell className="share-sticky-left share-link-cell">
                          <div className="share-link-name">
                            <span>
                              {link.label ?? (link.is_default ? '默认链接' : '未命名')}
                            </span>
                            {link.is_default && <span className="dash-badge">默认</span>}
                          </div>
                          <p className="share-link-hint">
                            {linkUnavailable(link) ? '已停用' : link.is_default ? '不可删除 / 不可改格式' : '额外共享链接'}
                          </p>
                        </TableCell>

                        {ALL_FORMATS.map((fmt) => (
                          <TableCell key={fmt} className="share-format-cell">
                            <span className="share-format-label" aria-hidden="true">
                              {FORMAT_META[fmt].headerLabel}
                            </span>
                            {link.formats.includes(fmt) ? (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                title={`复制 ${FORMAT_META[fmt].label}`}
                                aria-label={`复制 ${FORMAT_META[fmt].label}`}
                                disabled={linkUnavailable(link)}
                                aria-busy={copyFeedback.stateOf(`${link.id}:${fmt}`) === 'loading'}
                                aria-disabled={copyFeedback.stateOf(`${link.id}:${fmt}`) === 'loading'}
                                onClick={() => void handleCopy(link, fmt)}
                              >
                                <span className="feedback-icon" aria-hidden="true">
                                  <span data-active={copyFeedback.stateOf(`${link.id}:${fmt}`) === 'idle'}>
                                    <Copy />
                                  </span>
                                  <span data-active={copyFeedback.stateOf(`${link.id}:${fmt}`) === 'loading'}>
                                    <Loader2 className="dash-icon-spin" />
                                  </span>
                                  <span data-active={copyFeedback.stateOf(`${link.id}:${fmt}`) === 'success'}>
                                    <Check />
                                  </span>
                                  <span data-active={copyFeedback.stateOf(`${link.id}:${fmt}`) === 'error'}>
                                    <CircleAlert />
                                  </span>
                                </span>
                                <span className="sr-only" role="status">
                                  {copyFeedback.stateOf(`${link.id}:${fmt}`) === 'success' ? '已复制' : ''}
                                </span>
                              </Button>
                            ) : (
                              <span
                                className="share-unavailable"
                                title={`${FORMAT_META[fmt].label}不可用`}
                              >
                                <Minus aria-hidden="true" />
                                <span className="sr-only">{FORMAT_META[fmt].label}不可用</span>
                              </span>
                            )}
                          </TableCell>
                        ))}

                        <TableCell className="share-sticky-right">
                          <div className="share-actions">
                            <Button
                              variant="outline"
                              size="icon-sm"
                              title="轮换"
                              aria-label="轮换"
                              onClick={(event) => {
                                nestedTriggerRef.current = event.currentTarget
                                setRotateConfirm({ open: true, linkId: link.id })
                              }}
                            >
                              <RotateCw />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              title="修改"
                              aria-label="修改"
                              disabled={link.is_default}
                              onClick={(event) => openEditLink(link, event.currentTarget)}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              title="删除"
                              aria-label="删除"
                              disabled={link.is_default}
                              onClick={(event) => {
                                nestedTriggerRef.current = event.currentTarget
                                setDeleteConfirm({ open: true, linkId: link.id })
                              }}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {localLinks.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="share-empty-cell">
                          暂无链接
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="share-footer">
              <div>
                <p className="share-footer-count">{shareFooterText}</p>
                <p className="share-footer-hint">{shareFooterHint}</p>
              </div>
              {session.can('share') ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={atShareLimit}
                  title={atShareLimit ? '共享链接数量已达上限' : undefined}
                  onClick={openCreateForm}
                >
                  <Plus />
                  新建共享链接
                </Button>
              ) : (
                <span className="share-footer-hint">共享链接未开通</span>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rotateConfirm.open}
        onOpenChange={(v) => {
          if (!v) setRotateConfirm({ open: false, linkId: null })
        }}
      >
        <DialogContent onCloseAutoFocus={restoreNestedFocus}>
          <DialogHeader>
            <DialogTitle>确认轮换链接 Token</DialogTitle>
            <DialogDescription>
              轮换后旧链接立即失效，日历客户端需重新订阅新链接。确定要继续吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateConfirm({ open: false, linkId: null })}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleRotate()}>
              轮换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteConfirm.open}
        onOpenChange={(v) => {
          if (!v) setDeleteConfirm({ open: false, linkId: null })
        }}
      >
        <DialogContent onCloseAutoFocus={restoreNestedFocus}>
          <DialogHeader>
            <DialogTitle>确认删除共享链接</DialogTitle>
            <DialogDescription>
              删除后该链接立即失效，使用此链接的订阅将无法访问。确定删除吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm({ open: false, linkId: null })}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteLink()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={linkForm.open}
        onOpenChange={(v) => {
          if (!v) setLinkForm((current) => ({ ...current, open: false }))
        }}
      >
        <DialogContent onCloseAutoFocus={restoreNestedFocus}>
          <DialogHeader>
            <DialogTitle>{linkForm.editingId ? '编辑共享链接' : '新建共享链接'}</DialogTitle>
            <DialogDescription>
              {linkForm.editingId ? '修改链接标签或允许的格式。' : '创建一个新的共享链接。'}
            </DialogDescription>
          </DialogHeader>

          <div className="share-form">
            <div className="share-form-fields">
              <Label htmlFor="share-link-label">标签（可选，最多 100 字符）</Label>
              <Input
                id="share-link-label"
                placeholder="例：分享给同学"
                maxLength={100}
                value={linkForm.label}
                onChange={(event) =>
                  setLinkForm((current) => ({ ...current, label: event.target.value }))
                }
              />
            </div>

            <div className="share-form-fields">
              <Label>允许的格式（至少选择一项）</Label>
              <div className="format-grid">
                {ALL_FORMATS.map((fmt) => (
                  <Button
                    variant="outline"
                    key={fmt}
                    type="button"
                    className="format-toggle"
                    aria-pressed={linkForm.formats.includes(fmt)}
                    onClick={() => toggleFormat(fmt)}
                  >
                    {FORMAT_META[fmt].label}
                  </Button>
                ))}
              </div>
              {linkFormError && (
                <p role="alert" className="share-form-error">
                  {linkFormError}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLinkForm((current) => ({ ...current, open: false }))}
            >
              取消
            </Button>
            <ActionButton
              state={linkForm.submitting ? 'loading' : linkFormError ? 'error' : 'idle'}
              labels={{
                idle: linkForm.editingId ? '保存' : '创建',
                loading: linkForm.editingId ? '保存中…' : '创建中…',
                success: linkForm.editingId ? '已保存' : '已创建',
                error: '重试',
              }}
              disabled={linkForm.formats.length === 0}
              onClick={() => void handleSubmitLinkForm()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
