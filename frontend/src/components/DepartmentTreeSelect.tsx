import { useMemo, useState, type CSSProperties } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Skeleton,
} from '@cqu-moe/ui'
import { LoadingRegion } from './LoadingSkeletons'
import { Check, ChevronRight, ChevronsUpDown } from 'lucide-react'
import type { DepartmentNode } from '@/types/api'

export interface DepartmentTreeSelectProps {
  departments?: DepartmentNode[]
  value?: string
  onChange: (id: string) => void
  id?: string
  loading?: boolean
  disabled?: boolean
}

function flatten(nodes: DepartmentNode[]): DepartmentNode[] {
  const result: DepartmentNode[] = []
  for (const node of nodes) {
    result.push(node)
    if (node.children) result.push(...flatten(node.children))
  }
  return result
}

/** 保留名称命中的节点及其祖先路径；命中父节点时保留其全部子树。 */
function filterTree(nodes: DepartmentNode[], query: string): DepartmentNode[] {
  const q = query.trim()
  if (!q) return nodes
  const result: DepartmentNode[] = []
  for (const node of nodes) {
    if (node.name.includes(q)) {
      result.push(node)
      continue
    }
    const children = node.children ? filterTree(node.children, q) : []
    if (children.length > 0) result.push({ ...node, children })
  }
  return result
}

const iconStyle: CSSProperties = { width: '1rem', height: '1rem', flexShrink: 0 }
const mutedIconStyle: CSSProperties = { ...iconStyle, color: 'var(--muted-foreground)' }

function baseRowStyle(level: number): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 'var(--space-1)',
    minHeight: '2.75rem',
    fontSize: 'var(--text-sm)',
    textAlign: 'left',
    borderRadius: 'var(--radius-sm)',
    paddingLeft: `calc(var(--space-2) + ${level} * var(--space-4))`,
  }
}

function toggleRowStyle(level: number): CSSProperties {
  return { ...baseRowStyle(level), width: '100%' }
}

function chevronStyle(level: number): CSSProperties {
  return { ...baseRowStyle(level), minWidth: '2.75rem', justifyContent: 'center' }
}

function selectStyle(): CSSProperties {
  return { ...baseRowStyle(0), flex: 1, paddingLeft: 'var(--space-2)', paddingRight: 'var(--space-2)' }
}

interface NodeRowProps {
  node: DepartmentNode
  level: number
  value: string
  filtering: boolean
  disabled: boolean
  onSelect: (node: DepartmentNode) => void
}

function DepartmentNodeRow({ node, level, value, filtering, disabled, onSelect }: NodeRowProps) {
  const [open, setOpen] = useState(false)
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const expanded = filtering || open
  const selected = value === node.id
  // 与旧版一致：带子节点的根节点只作为分组展开，不可选中。
  const rootGroup = level === 0 && hasChildren

  return (
    <li role="none">
      {rootGroup ? (
        <Button
          disabled={disabled}
          variant="ghost"
          type="button"
          style={toggleRowStyle(level)}
          aria-expanded={expanded}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight
            className="department-chevron"
            data-expanded={expanded}
            style={mutedIconStyle}
            aria-hidden
          />
          <span className="truncate" style={{ fontWeight: 500 }}>
            {node.name}
          </span>
        </Button>
      ) : (
        <div className="flex w-full items-center">
          {hasChildren && (
            <Button
              disabled={disabled}
              variant="ghost"
              type="button"
              style={chevronStyle(level)}
              aria-label={`${expanded ? '收起' : '展开'}${node.name}`}
              aria-expanded={expanded}
              onClick={() => setOpen((current) => !current)}
            >
              <ChevronRight
                className="department-chevron"
                data-expanded={expanded}
                style={mutedIconStyle}
                aria-hidden
              />
            </Button>
          )}
          <Button
            disabled={disabled}
            variant="ghost"
            type="button"
            style={selectStyle()}
            role="treeitem"
            aria-selected={selected}
            onClick={() => onSelect(node)}
          >
            <Check style={iconStyle} aria-hidden className={selected ? undefined : 'invisible'} />
            <span className="truncate">{node.name}</span>
          </Button>
        </div>
      )}
      {hasChildren && expanded && (
        <ul role="group" className="m-0 list-none p-0">
          {children.map((child) => (
            <DepartmentNodeRow
              key={child.id}
              node={child}
              level={level + 1}
              value={value}
              disabled={disabled}
              filtering={filtering}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function DepartmentTreeSelect({
  departments = [],
  value = '',
  onChange,
  id,
  loading = false,
  disabled = false,
}: DepartmentTreeSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const allDepartments = useMemo(() => flatten(departments), [departments])
  const selectedLabel = allDepartments.find((node) => node.id === value)?.name ?? ''
  const visible = useMemo(() => filterTree(departments, query), [departments, query])
  const filtering = query.trim().length > 0

  function select(node: DepartmentNode) {
    if (disabled) return
    onChange(node.id)
    setOpen(false)
    setQuery('')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <DialogTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-busy={loading}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {loading && departments.length === 0
            ? <><span className="invisible w-24" aria-hidden="true">选择学院</span><span className="sr-only">正在加载学院</span></>
            : <span className="truncate">{selectedLabel || '请选择学院'}</span>}
          <ChevronsUpDown style={mutedIconStyle} aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>选择学院</DialogTitle>
          <DialogDescription>输入名称筛选学院列表，选择后自动关闭。</DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          aria-label="搜索学院"
          placeholder="搜索学院…"
          disabled={disabled}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {loading && departments.length === 0 ? (
          <LoadingRegion label="正在加载学院">
            {[0, 1, 2, 3, 4].map(row => <div key={row} style={baseRowStyle(0)}><Skeleton className="loading-line w-40" /></div>)}
          </LoadingRegion>
        ) : visible.length === 0 ? (
          <p
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--muted-foreground)',
              margin: 0,
              padding: 'var(--space-4) 0',
              textAlign: 'center',
            }}
          >
            未找到匹配的学院
          </p>
        ) : (
          <ul role="tree" aria-label="学院列表" aria-busy={loading} className="m-0 max-h-72 list-none overflow-y-auto p-0">
            {visible.map((node) => (
              <DepartmentNodeRow
                key={node.id}
                node={node}
                level={0}
                value={value}
                disabled={disabled}
                filtering={filtering}
                onSelect={select}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
