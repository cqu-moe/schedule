import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import {
  ActionButton,
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  PageHeader,
  PageState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from '@cqu-moe/ui'
import { Check, Search } from 'lucide-react'
import api from '@/api'
import DepartmentTreeSelect from '@/components/DepartmentTreeSelect'
import { authCquBindUrl } from '@/config/auth'
import { useButtonFeedback } from '@/hooks/useButtonFeedback'
import { usePersonalSetup } from '@/hooks/usePersonalSetup'
import { useSubscriptions } from '@/hooks/useSubscriptions'
import { useSession } from '@/providers/app'
import type { DepartmentNode, SearchResult, SourceType } from '@/types/api'
import { apiErrorCode, parseApiError } from '@/utils/error'
import './add.css'

// 外部课表软禁用（可逆）：瑞数化后外部课表无法获取，前端隐藏入口标「暂不可用」。
// 恢复只需把 enabled 改回 true；测试通过修改此对象覆盖。绝不在 UI 暴露瑞数/WAF/风控原因。
export const externalSubscriptions = { enabled: false }

type ExternalSourceType = Extract<
  SourceType,
  'instructor' | 'room' | 'laboratory' | 'course' | 'admin_class'
>

interface PersonalOption {
  sourceType: SourceType
  label: string
  description: string
  sourceName: string
}

const personalOptions: PersonalOption[] = [
  {
    sourceType: 'personal_all',
    label: '我的全部课表',
    description: '包含课程和考试',
    sourceName: '我的全部课表',
  },
  {
    sourceType: 'personal_courses',
    label: '我的课程',
    description: '仅包含课程安排',
    sourceName: '我的课程',
  },
  {
    sourceType: 'personal_exams',
    label: '我的考试',
    description: '仅包含考试安排',
    sourceName: '我的考试',
  },
]

const SOURCE_LABELS: Record<ExternalSourceType, string> = {
  instructor: '教师',
  room: '教室',
  laboratory: '实验室',
  course: '课程',
  admin_class: '行政班',
}

const SEARCH_PLACEHOLDERS: Record<ExternalSourceType, string> = {
  instructor: '输入教师姓名或工号',
  room: '输入教室编号',
  laboratory: '输入实验室名称',
  course: '输入课程名称或代码',
  admin_class: '输入班级名称关键词',
}

export default function Add() {
  const location = useLocation()
  const session = useSession()
  const subs = useSubscriptions()
  const setup = usePersonalSetup()
  const personalFeedback = useButtonFeedback()
  const subscribeFeedback = useButtonFeedback()

  const [sessionLoading, setSessionLoading] = useState(true)
  const [sourceType, setSourceType] = useState<ExternalSourceType>('instructor')
  const [keyword, setKeyword] = useState('')
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedGrade, setSelectedGrade] = useState('all')
  const [departments, setDepartments] = useState<DepartmentNode[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [needsRepair, setNeedsRepair] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  const setupRef = useRef(setup)
  const sessionRef = useRef(session)
  setupRef.current = setup
  sessionRef.current = session

  const { reloadSession } = session

  useEffect(() => {
    let active = true
    reloadSession().finally(() => {
      if (active) setSessionLoading(false)
    })
    return () => {
      active = false
    }
  }, [reloadSession])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await setup.begin()
      } catch {
        return
      }
      if (!active) return
      const current = setupRef.current
      if (current.startedThisVisit || current.error || sessionRef.current.isCquUnbound) return
      subs.load().catch(() => toast.error('加载订阅列表失败'))
    })()
    return () => {
      active = false
    }
    // 仅需在挂载时执行一次；setup.begin / subs.load 均为稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  const currentUrl = window.location.origin + location.pathname + location.search + location.hash
  const bindHref = authCquBindUrl(currentUrl)
  const repairBindHref = authCquBindUrl(currentUrl, { repair: true })

  const gradeOptions = useMemo(() => {
    const currentYear = new Date().getFullYear()
    return Array.from({ length: 5 }, (_, index) => String(currentYear - index))
  }, [])

  function isPersonalSubscribed(sourceType: SourceType): boolean {
    return subs.subscriptions.some((s) => s.source_type === sourceType && s.is_personal)
  }

  function isExternalSubscribed(sourceId: string): boolean {
    return subs.subscriptions.some(
      (s) => s.source_id === sourceId && s.source_type === sourceType,
    )
  }

  function clearError() {
    setErrorMessage('')
    setNeedsRepair(false)
  }

  function clearPendingSearch() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }

  async function loadDepartments() {
    try {
      const data = await api.getDepartments()
      setDepartments(data.departments)
    } catch (err: unknown) {
      toast.error(parseApiError(err, '加载院系列表失败'))
    }
  }

  function handleTypeChange(next: string) {
    const type = next as ExternalSourceType
    setSourceType(type)
    setKeyword('')
    setSelectedGrade('all')
    setSelectedDepartment('')
    setSearchResults([])
    setSearched(false)
    clearError()
    clearPendingSearch()
    if (type === 'admin_class' && departments.length === 0) void loadDepartments()
  }

  async function doSearch(kw: string) {
    const seq = ++searchSeq.current
    setSearching(true)
    setSearched(false)
    clearError()
    try {
      const data = await api.searchExternal({
        source_type: sourceType,
        keyword: kw,
        department_id:
          sourceType === 'admin_class' && selectedDepartment ? selectedDepartment : undefined,
        grade:
          sourceType === 'admin_class' && selectedGrade !== 'all' ? selectedGrade : undefined,
      })
      if (seq !== searchSeq.current) return
      setSearchResults(data.results)
    } catch (err: unknown) {
      if (seq !== searchSeq.current) return
      const code = apiErrorCode(err)
      if (code === 'CQU_SESSION_INACTIVE') {
        setErrorMessage('重庆大学统一认证登录状态已失效。')
        setNeedsRepair(true)
      } else if (code === 'FEATURE_NOT_ENABLED') {
        setErrorMessage('外部订阅功能未开通')
      } else {
        setErrorMessage(parseApiError(err, '搜索失败'))
      }
      setSearchResults([])
    } finally {
      if (seq !== searchSeq.current) return
      setSearching(false)
      setSearched(true)
    }
  }

  function onKeywordChange(value: string) {
    setKeyword(value)
    clearPendingSearch()
    if (sourceType !== 'admin_class' && value.trim().length < 2) {
      setSearchResults([])
      setSearched(false)
      return
    }
    debounceRef.current = setTimeout(() => {
      void doSearch(value)
    }, 300)
  }

  function handleDepartmentChange(deptId: string) {
    setSelectedDepartment(deptId)
    clearPendingSearch()
    void doSearch(keyword)
  }

  function handleGradeChange(grade: string) {
    setSelectedGrade(grade)
    clearPendingSearch()
    void doSearch(keyword)
  }

  async function handlePersonalSubscribe(opt: PersonalOption) {
    try {
      await personalFeedback.run(async () => {
        await api.createSubscription({
          sourceType: opt.sourceType,
          sourceName: opt.sourceName,
          isPersonal: true,
          // 不发送 sourceId：后端会将其固定为当前认证用户。
        })
        toast.success(`已订阅「${opt.label}」`)
        await subs.load(true).catch(() => {})
      }, opt.sourceType)
    } catch (err: unknown) {
      toast.error(parseApiError(err, '订阅失败'))
    }
  }

  async function handleExternalSubscribe(item: SearchResult) {
    clearError()
    try {
      await subscribeFeedback.run(async () => {
        await api.createSubscription({
          sourceType,
          sourceId: item.id,
          sourceName: item.name,
        })
        toast.success(`已订阅「${item.name}」`)
        await subs.load(true).catch(() => {})
      }, item.id)
    } catch (err: unknown) {
      toast.error(parseApiError(err, '订阅失败'))
    }
  }

  const busy = setup.preparing || sessionLoading
  const externalUnavailable = !externalSubscriptions.enabled
  const externalLocked = externalSubscriptions.enabled && !session.can('external')

  return (
    <>
      <PageHeader
        title="添加新订阅"
        description="订阅个人课表或外部课表，自动同步到你的日历应用。"
      />
      {busy ? (
        <PageState
          state="loading"
          title="正在准备订阅"
          description="正在确认登录状态与默认订阅，请稍候。"
        />
      ) : (
        <>
          {setup.error && (
            <Alert variant="destructive">
              <AlertDescription className="add-error-row">
                <span>{setup.error}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void setup.begin()}
                >
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <section className="add-section" aria-labelledby="personal-heading">
            <h2 id="personal-heading" className="add-section-title">
              个人课表
            </h2>
            {!session.can('sync') ? (
              <div className="add-hint-box">
                个人课表订阅需要开通「日历同步」权限（内测阶段由管理员开通）。
              </div>
            ) : session.isCquUnbound ? (
              <div className="add-hint-box">
                尚未绑定重庆大学统一认证账号，绑定后即可订阅并自动同步个人课表。请先
                <a href={bindHref} className="add-bind-link">
                  绑定重庆大学统一认证账号
                </a>
                完成绑定。
              </div>
            ) : (
              <div className="add-card">
                {personalOptions.map((opt) => (
                  <div key={opt.sourceType} className="add-option">
                    <div className="min-w-0">
                      <p className="add-option-name">{opt.label}</p>
                      <p className="add-option-desc">{opt.description}</p>
                    </div>
                    {isPersonalSubscribed(opt.sourceType) ? (
                      <Button variant="outline" size="sm" disabled>
                        <Check aria-hidden />
                        已订阅
                      </Button>
                    ) : (
                      <ActionButton
                        type="button"
                        size="sm"
                        state={personalFeedback.stateOf(opt.sourceType)}
                        labels={{
                          idle: '订阅',
                          loading: '订阅中…',
                          success: '已订阅',
                          error: '失败，重试',
                        }}
                        disabled={subs.atLimit}
                        aria-label={`订阅${opt.label}`}
                        onClick={() => void handlePersonalSubscribe(opt)}
                      />
                    )}
                  </div>
                ))}
                {subs.atLimit && (
                  <p className="add-warning">已达订阅上限，请先删除不需要的订阅</p>
                )}
                {session.cquBindStatus === undefined && (
                  <p className="add-hint">
                    首次使用？请先在
                    <a href={bindHref} className="add-bind-link">
                      绑定重庆大学统一认证账号
                    </a>
                    ，否则课表无法同步。
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="add-section" aria-labelledby="external-heading">
            <h2 id="external-heading" className="add-section-title">
              外部订阅
              <span className="add-flag">
                {externalUnavailable ? '暂不可用' : externalLocked ? '未开通' : null}
              </span>
            </h2>
            {externalUnavailable ? (
              <div className="add-hint-box">
                外部订阅（教师、教室、课程、行政班等）功能暂不可用。
              </div>
            ) : externalLocked ? (
              <div className="add-hint-box">
                外部订阅（教师、教室、课程、行政班等）功能尚未开通。
              </div>
            ) : (
              <div className="add-card">
                <Tabs value={sourceType} onValueChange={handleTypeChange}>
                  <TabsList className="add-source-tabs" aria-label="来源类型">
                    {(Object.keys(SOURCE_LABELS) as ExternalSourceType[]).map((type) => (
                      <TabsTrigger key={type} value={type}>
                        {SOURCE_LABELS[type]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                {sourceType === 'admin_class' && (
                  <div className="add-admin-filters">
                    <div className="add-field">
                      <Label htmlFor="department-select">选择学院</Label>
                      <DepartmentTreeSelect
                        id="department-select"
                        departments={departments}
                        value={selectedDepartment}
                        onChange={handleDepartmentChange}
                      />
                    </div>
                    <div className="add-field">
                      <Label htmlFor="grade-select">年级</Label>
                      <Select value={selectedGrade} onValueChange={handleGradeChange}>
                        <SelectTrigger id="grade-select" aria-label="年级">
                          <SelectValue placeholder="全部年级" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全部</SelectItem>
                          {gradeOptions.map((year) => (
                            <SelectItem key={year} value={year}>
                              {year}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="add-search-field">
                      <Search aria-hidden />
                      <Input
                        type="search"
                        aria-label="搜索班级"
                        placeholder="输入班级名称关键词（可选）"
                        value={keyword}
                        onChange={(event) => onKeywordChange(event.target.value)}
                      />
                    </div>
                  </div>
                )}

                {sourceType !== 'admin_class' && (
                  <div className="add-search-field">
                    <Search aria-hidden />
                    <Input
                      type="search"
                      aria-label={`搜索${SOURCE_LABELS[sourceType]}`}
                      placeholder={SEARCH_PLACEHOLDERS[sourceType]}
                      value={keyword}
                      onChange={(event) => onKeywordChange(event.target.value)}
                    />
                  </div>
                )}

                {searching && (
                  <p className="add-searching" role="status">
                    搜索中…
                  </p>
                )}

                {searchResults.length > 0 && (
                  <ul className="add-results">
                    {searchResults.map((item) => (
                      <li key={item.id} className="add-result">
                        <div className="add-result-info">
                          <p className="add-result-name">{item.name}</p>
                          {item.extra && <p className="add-result-extra">{item.extra}</p>}
                        </div>
                        {isExternalSubscribed(item.id) ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled
                            aria-label={`已订阅${item.name}`}
                          >
                            <Check aria-hidden />
                            已订阅
                          </Button>
                        ) : (
                          <ActionButton
                            type="button"
                            size="sm"
                            state={subscribeFeedback.stateOf(item.id)}
                            labels={{
                              idle: '订阅',
                              loading: '订阅中…',
                              success: '已订阅',
                              error: '失败，重试',
                            }}
                            disabled={subs.atLimit}
                            aria-label={`订阅${item.name}`}
                            onClick={() => void handleExternalSubscribe(item)}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {searched && !searching && searchResults.length === 0 && (
                  <p className="add-no-results">未找到结果</p>
                )}

                {subs.atLimit && (
                  <p className="add-warning">已达最大订阅数，请先删除不需要的订阅</p>
                )}
              </div>
            )}
          </section>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>
                {errorMessage}
                {needsRepair && (
                  <>
                    {' '}
                    <a href={repairBindHref} className="add-bind-link">
                      重新绑定重庆大学统一认证账号
                    </a>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </>
  )
}
