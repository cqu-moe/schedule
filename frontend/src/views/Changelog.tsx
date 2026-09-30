import { PageHeader } from '@cqu-moe/ui'

const changelogHtml = __CHANGELOG_HTML__.replace(/^<h1[^>]*>.*?<\/h1>\s*/i, '')

export default function Changelog() {
  return (
    <div style={{ maxWidth: '48rem' }}>
      <PageHeader title="更新日志" description="版本更新记录" />
      {/* Build-time generated from CHANGELOG.md and sanitized with DOMPurify. */}
      <div className="markdown-content" dangerouslySetInnerHTML={{ __html: changelogHtml }} />
    </div>
  )
}
