import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import Changelog from '@/views/Changelog'
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
