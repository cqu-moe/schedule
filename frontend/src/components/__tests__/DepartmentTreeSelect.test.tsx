import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DepartmentTreeSelect from '@/components/DepartmentTreeSelect'
import type { DepartmentNode } from '@/types/api'

const tree: DepartmentNode[] = [
  {
    id: 'd1',
    name: '计算机学院',
    children: [
      {
        id: 'd1-1',
        name: '计算机科学与技术系',
        children: [{ id: 'd1-1-1', name: '人工智能系' }],
      },
      { id: 'd1-2', name: '软件工程系' },
    ],
  },
  { id: 'd2', name: '数学与统计学院' },
]

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'))
  return screen.findByRole('dialog')
}

describe('DepartmentTreeSelect', () => {
  it('shows the selected department name on the trigger', () => {
    render(<DepartmentTreeSelect departments={tree} value="d1-2" onChange={vi.fn()} />)
    expect(screen.getByRole('combobox')).toHaveTextContent('软件工程系')
  })

  it('expands levels step by step and selects a department', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<DepartmentTreeSelect departments={tree} value="" onChange={onChange} />)
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: '计算机学院' }))
    expect(within(dialog).getByText('软件工程系')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '展开计算机科学与技术系' }))
    expect(within(dialog).getByText('人工智能系')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('treeitem', { name: '计算机科学与技术系' }))
    expect(onChange).toHaveBeenCalledWith('d1-1')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('filters departments and auto-expands matching branches', async () => {
    const user = userEvent.setup()
    render(<DepartmentTreeSelect departments={tree} value="" onChange={vi.fn()} />)
    const dialog = await openDialog(user)
    await user.type(within(dialog).getByLabelText('搜索学院'), '人工')
    expect(within(dialog).getByText('人工智能系')).toBeInTheDocument()
    expect(within(dialog).getByText('计算机学院')).toBeInTheDocument()
    expect(within(dialog).queryByText('软件工程系')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('数学与统计学院')).not.toBeInTheDocument()
  })

  it('keeps the dialog layout while loading and retains known choices during refresh', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const view = render(<DepartmentTreeSelect loading onChange={onChange} />)
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-busy', 'true')
    const dialog = await openDialog(user)
    expect(within(dialog).getByRole('searchbox', { name: '搜索学院' })).toBeInTheDocument()
    expect(within(dialog).getByText('正在加载学院')).toBeInTheDocument()
    expect(within(dialog).queryByText('未找到匹配的学院')).not.toBeInTheDocument()
    view.rerender(<DepartmentTreeSelect departments={tree} value="d2" onChange={onChange} />)
    const option = within(dialog).getByRole('treeitem', { name: '数学与统计学院' })
    view.rerender(<DepartmentTreeSelect departments={tree} value="d2" loading onChange={onChange} />)
    expect(within(dialog).getByRole('treeitem', { name: '数学与统计学院' })).toBe(option)
    expect(within(dialog).getByRole('tree')).toHaveAttribute('aria-busy', 'true')
    expect(option).toHaveAttribute('aria-selected', 'true')
    await user.click(option)
    expect(onChange).toHaveBeenCalledWith('d2')
  })

  it('disables an already open picker when a subscription is submitting', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const view = render(<DepartmentTreeSelect departments={tree} onChange={onChange} />)
    const dialog = await openDialog(user)
    view.rerender(<DepartmentTreeSelect departments={tree} disabled onChange={onChange} />)
    expect(within(dialog).getByRole('searchbox', { name: '搜索学院' })).toBeDisabled()
    const option = within(dialog).getByRole('treeitem', { name: '数学与统计学院' })
    expect(option).toBeDisabled()
    await user.click(option)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports no matches', async () => {
    const user = userEvent.setup()
    render(<DepartmentTreeSelect departments={tree} value="" onChange={vi.fn()} />)
    const dialog = await openDialog(user)
    await user.type(within(dialog).getByLabelText('搜索学院'), '不存在')
    expect(await within(dialog).findByText('未找到匹配的学院')).toBeInTheDocument()
  })
})
