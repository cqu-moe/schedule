import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import Changelog from '@/views/Changelog'
import { renderChangelogHtml } from '../../../vite.config'
import { renderWithApp } from '@/test-utils'

describe('Changelog', () => {
  it('renders title and markdown body without the source h1', () => {
    renderWithApp(<Changelog />)

    expect(screen.getByRole('heading', { level: 1, name: '更新日志' })).toBeInTheDocument()
    expect(screen.getByText('版本更新记录')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'v1.0.0' })).toBeInTheDocument()
    expect(screen.getByText('Test content')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Changelog' })).not.toBeInTheDocument()
  })
})

describe('renderChangelogHtml', () => {
  it('strips event handlers and scripts from rendered markdown', () => {
    const html = renderChangelogHtml(
      '<img src=x onerror="alert(1)"><script>alert(2)</script>[link](https://example.com)'
    )

    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script')
    expect(html).toContain('<a href="https://example.com">link</a>')
  })

  it('keeps normal changelog markdown rendering', () => {
    const html = renderChangelogHtml('## v1.2.0\n\n- **实验课每周内容**：标注当周项目')

    expect(html).toContain('<h2>v1.2.0</h2>')
    expect(html).toContain('<strong>实验课每周内容</strong>')
  })
})
