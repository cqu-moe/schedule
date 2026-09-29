import { PageHeader, PageState } from '@cqu-moe/ui'

export default function Changelog() {
  return (
    <>
      <PageHeader title="更新日志" description="页面迁移中。" />
      <PageState state="empty" title="正在接入 CQU Moe Design" description="该页面正在从 Vue 迁移。" />
    </>
  )
}

