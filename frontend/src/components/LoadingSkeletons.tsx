import type { ReactNode } from 'react'
import { Button, PageHeader, Skeleton } from '@cqu-moe/ui'
import { ArrowRight, BookOpen, CalendarDays, Plus } from 'lucide-react'
import './loading.css'
import '@/views/dashboard.css'
import '@/views/add.css'
import '@/views/calendar.css'

/** Keep the content's geometry; only unknown values are masked. */
export function LoadingRegion({ label, children, className, id }: {
  label: string
  children: ReactNode
  className?: string
  id?: string
}) {
  return <div className={className} id={id} aria-busy="true">
    <span className="sr-only" role="status">{label}</span>
    <div aria-hidden="true" inert>{children}</div>
  </div>
}

export function DashboardMetaSkeleton() {
  return <LoadingRegion label="正在读取订阅状态">
    <div className="dash-meta">
      <div className="dash-count"><Skeleton><span className="invisible">0 个订阅</span></Skeleton></div>
      {['外部订阅额度 0 / 无限', '自动同步已开启', '外部订阅已开通', '外部自动同步每 300 分钟', '外部手动刷新剩余无限'].map((label, index) =>
        <div className="dash-sync-status" key={label}>
          {index > 0 && <span className="dash-status-dot invisible" />}
          <Skeleton><span className="invisible">{label}</span></Skeleton>
        </div>,
      )}
    </div>
  </LoadingRegion>
}

export function SubscriptionListSkeleton() {
  return <LoadingRegion label="正在加载订阅">
    <div className="dash-section-heading">
      <h2>课表订阅</h2>
      <span className="loading-subscribe-help"><BookOpen size={16} />如何订阅到日历</span>
    </div>
    <ul className="dash-list">
      {[0, 1, 2].map(index => <li className="dash-card" key={index}>
        <div className="dash-card-info">
          <div className="dash-card-title">
            <CalendarDays size={20} />
            <Skeleton className="loading-line" style={{ width: index ? '5rem' : '8rem' }} />
            <span className="dash-badge"><Skeleton><span className="invisible">全部</span></Skeleton></span>
          </div>
          <div className="dash-card-sub loading-card-meta"><Skeleton className="loading-line" style={{ width: '15rem' }} /></div>
        </div>
        <div className="dash-card-actions">
          <div className="dash-main-actions">
            <Button disabled><ArrowRight className="invisible" /><Skeleton><span className="invisible">查看课表</span></Skeleton></Button>
            <Button variant="outline" disabled><Skeleton><span className="invisible inline-flex items-center gap-2"><ArrowRight />复制链接</span></Skeleton></Button>
          </div>
          <div className="dash-secondary-actions">
            <Button variant="outline" disabled><Skeleton><span className="invisible inline-flex items-center gap-2"><ArrowRight />同步</span></Skeleton></Button>
            <Button variant="outline" size="icon" disabled><Skeleton className="size-4" /></Button>
            <Button variant="outline" size="icon" disabled><Skeleton className="size-4" /></Button>
          </div>
        </div>
      </li>)}
    </ul>
  </LoadingRegion>
}

export function DashboardRouteSkeleton() {
  return <>
    <PageHeader title="我的订阅" description="管理课程与考试订阅，让日历跟上你的安排。" actions={
      <div className="dash-header-actions" aria-hidden="true">
        <Button variant="outline" disabled><ArrowRight />同步个人课表</Button>
        <Button disabled><Plus />添加订阅</Button>
      </div>
    } />
    <DashboardMetaSkeleton />
    <SubscriptionListSkeleton />
  </>
}

export function ExternalFormSkeleton({ reselect = false }: { reselect?: boolean }) {
  return <LoadingRegion label="正在确认外部订阅可用性">
    <div className="add-card">
      <div className="add-external-tabs">
        {!reselect && <div className="add-source-tabs loading-source-tabs">
          {[0, 1, 2, 3, 4].map(index => <Skeleton key={index} className="loading-tab" />)}
        </div>}
        <div className="add-external-panel">
          <p className="add-result-extra">仅查询学校当前学期。</p>
          <div className="add-field">
            <Skeleton className="loading-line" style={{ width: '5rem' }} />
            <Skeleton className="loading-input" />
          </div>
          <p className="add-hint">请输入至少两个字符，可按 Enter 搜索。</p>
          <Button className="add-touch-control" variant="outline" disabled>搜索</Button>
        </div>
      </div>
    </div>
  </LoadingRegion>
}

export function AddContentSkeleton({ reselect = false }: { reselect?: boolean }) {
  return <>
    {!reselect && <section className="add-section">
      <h2 className="add-section-title">个人课表</h2>
      <LoadingRegion label="正在准备订阅">
        <div className="add-card">
          {[
            ['我的全部课表', '包含课程和考试'],
            ['我的课程', '仅包含课程安排'],
            ['我的考试', '仅包含考试安排'],
          ].map(([name, description]) => <div className="add-option" key={name}>
            <div className="min-w-0"><p className="add-option-name">{name}</p><p className="add-option-desc">{description}</p></div>
            <Button variant="outline" size="sm" disabled><Skeleton><span className="invisible inline-flex items-center gap-2"><ArrowRight />已订阅</span></Skeleton></Button>
          </div>)}
        </div>
      </LoadingRegion>
    </section>}
    <section className="add-section">
      <h2 className="add-section-title">外部订阅</h2>
      <ExternalFormSkeleton reselect={reselect} />
    </section>
  </>
}

export function AddRouteSkeleton({ reselect = false }: { reselect?: boolean }) {
  return <>
    <PageHeader title={reselect ? '重新选择教学班' : '添加新订阅'}
      description={reselect ? '原订阅和全部链接地址保持不变；新教学班同步成功前，公共链接保持停用。' : '选择个人课表或外部课表，添加后可返回「我的订阅」查看日历链接。'}
      actions={<Button variant="outline" size="sm" disabled>我的订阅</Button>} />
    <AddContentSkeleton reselect={reselect} />
  </>
}

export function SearchResultsSkeleton() {
  return <ul className="add-results">
    {[0, 1, 2].map(index => <li className="add-result" key={index}>
      <div className="add-result-info loading-result-info">
        <Skeleton className="loading-line" style={{ width: '8rem' }} />
        <Skeleton className="loading-line" style={{ width: '12rem' }} />
      </div>
      <Button disabled className="add-touch-control"><Skeleton><span className="invisible">失败，重试</span></Skeleton></Button>
    </li>)}
  </ul>
}

export function CalendarSkeleton() {
  return <LoadingRegion label="正在加载课表" className="cal-loading">
    <div className="cal-loading-toolbar">
      <div className="cal-loading-actions"><Skeleton className="loading-input w-20" /><Skeleton className="loading-input w-16" /></div>
      <Skeleton className="loading-line w-48" />
      <Skeleton className="loading-input w-32" />
    </div>
    <div className="cal-loading-grid">
      <div className="cal-loading-week"><span />{Array.from({ length: 7 }, (_, day) => <div key={day}><Skeleton className="loading-line w-16" /></div>)}</div>
      {Array.from({ length: 28 }, (_, row) => <div className="cal-loading-slots" key={row}>
        <div>{row % 2 === 0 && <Skeleton className="loading-time" />}</div>
        {Array.from({ length: 7 }, (_, day) => <div key={day} />)}
      </div>)}
    </div>
  </LoadingRegion>
}

export function CalendarRouteSkeleton() {
  return <>
    <header className="cal-heading"><h1>课表日历</h1><Skeleton className="loading-line w-48" aria-hidden="true" /></header>
    <CalendarSkeleton />
  </>
}
