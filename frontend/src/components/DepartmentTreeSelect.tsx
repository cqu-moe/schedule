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
} from '@cqu-moe/ui'
import { Check, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react'
import type { DepartmentNode } from '@/types/api'

export interface DepartmentTreeSelectProps {
  departments?: DepartmentNode[]
  value?: string
  onChange: (id: string) => void
  id?: string
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
  return { ...baseRowStyle(level), width: '2.25rem', justifyContent: 'center' }
}

function selectStyle(): CSSProperties {
  return { ...baseRowStyle(0), flex: 1, paddingLeft: 'var(--space-2)', paddingRight: 'var(--space-2)' }
}

interface NodeRowProps {
  node: DepartmentNode
  level: number
  value: string
  filtering: boolean
  onSelect: (node: DepartmentNode) => void
}

function DepartmentNodeRow({ node, level, value, filtering, onSelect }: NodeRowProps) {
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
        <button
          type="button"
          style={toggleRowStyle(level)}
          aria-expanded={expanded}
          onClick={() => setOpen((current) => !current)}
        >
          {expanded ? (
            <ChevronDown style={mutedIconStyle} aria-hidden />
          ) : (
            <ChevronRight style={mutedIconStyle} aria-hidden />
          )}
          <span className="truncate" style={{ fontWeight: 500 }}>
            {node.name}
          </span>
        </button>
      ) : (
        <div className="flex w-full items-center">
          {hasChildren && (
            <button
              type="button"
              style={chevronStyle(level)}
              aria-label={`${expanded ? '收起' : '展开'}${node.name}`}
              aria-expanded={expanded}
              onClick={() => setOpen((current) => !current)}
            >
              {expanded ? (
                <ChevronDown style={mutedIconStyle} aria-hidden />
              ) : (
                <ChevronRight style={mutedIconStyle} aria-hidden />
              )}
            </button>
          )}
          <button
            type="button"
            style={selectStyle()}
            role="treeitem"
            aria-selected={selected}
            onClick={() => onSelect(node)}
          >
            <Check style={iconStyle} aria-hidden className={selected ? undefined : 'invisible'} />
            <span className="truncate">{node.name}</span>
          </button>
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
}: DepartmentTreeSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const allDepartments = useMemo(() => flatten(departments), [departments])
  const selectedLabel = allDepartments.find((node) => node.id === value)?.name ?? ''
  const visible = useMemo(() => filterTree(departments, query), [departments, query])
  const filtering = query.trim().length > 0

  function select(node: DepartmentNode) {
    onChange(node.id)
    setOpen(false)
    setQuery('')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
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
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{selectedLabel || '请选择学院'}</span>
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
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible.length === 0 ? (
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
          <ul role="tree" aria-label="学院列表" className="m-0 max-h-72 list-none overflow-y-auto p-0">
            {visible.map((node) => (
              <DepartmentNodeRow
                key={node.id}
                node={node}
                level={0}
                value={value}
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
