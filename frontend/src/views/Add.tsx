import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
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
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@cqu-moe/ui'
import { Check, Search } from 'lucide-react'
import api from '@/api'
import DepartmentTreeSelect from '@/components/DepartmentTreeSelect'
import { AddContentSkeleton, ExternalFormSkeleton, LoadingRegion, SearchResultsSkeleton } from '@/components/LoadingSkeletons'
import { AUTH_BASE_URL, authCquBindUrl } from '@/config/auth'
import { useButtonFeedback } from '@/hooks/useButtonFeedback'
import { usePersonalSetup } from '@/hooks/usePersonalSetup'
import { useSubscriptions } from '@/hooks/useSubscriptions'
import { useSession } from '@/providers/app'
import type { DepartmentNode, SearchResult, SourceType, ExternalAvailability, ExternalSession } from '@/types/api'
import { apiErrorCode, parseApiError } from '@/utils/error'
import './add.css'

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

interface SearchRequest {
  sourceType: ExternalSourceType
  keyword: string
  departmentId: string
  grade: string
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
  const navigate = useNavigate()
  const reselectId = new URLSearchParams(location.search).get('reselect')
  const reselectMode = reselectId !== null
  const session = useSession()
  const subs = useSubscriptions()
  const setup = usePersonalSetup()
  const personalFeedback = useButtonFeedback()
  const subscribeFeedback = useButtonFeedback()

  const [sessionLoading, setSessionLoading] = useState(true)
  const [availability, setAvailability] = useState<ExternalAvailability>({ search_types: [], create_types: [] })
  const [configStatus, setConfigStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [currentTerm, setCurrentTerm] = useState<ExternalSession | null>(null)
  const [departmentTerm, setDepartmentTerm] = useState<ExternalSession | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [selectedCourse, setSelectedCourse] = useState<SearchResult | null>(null)
  const catalogToken = useRef<string | null>(null)
  const courseInput = useRef<HTMLInputElement>(null)
  const teachingClassHeading = useRef<HTMLHeadingElement>(null)
  const teachingClassResults = useRef<HTMLUListElement>(null)
  const searchRetryButton = useRef<HTMLButtonElement>(null)
  const [selectionToken, setSelectionToken] = useState<string | null>(null)
  const [sourceType, setSourceType] = useState<ExternalSourceType>(reselectMode ? 'course' : 'instructor')
  const [keyword, setKeyword] = useState('')
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedGrade, setSelectedGrade] = useState('all')
  const [departments, setDepartments] = useState<DepartmentNode[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [needsRepair, setNeedsRepair] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [sessionError, setSessionError] = useState(false)
  const [subscriptionsLoaded, setSubscriptionsLoaded] = useState(false)
  const [activeSubmission, setActiveSubmission] = useState<{ kind: 'personal' | 'external'; id: string } | null>(null)
  const submitting = activeSubmission !== null
  const submittingRef = useRef(false)
  const [searchScheduled, setSearchScheduled] = useState(false)
  const [subsStatus, setSubsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [departmentsLoading, setDepartmentsLoading] = useState(false)
  const [departmentsError, setDepartmentsError] = useState(false)
  const [schoolLookupActive, setSchoolLookupActive] = useState(false)
  const [departmentsSchoolLookup, setDepartmentsSchoolLookup] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  const lastSearchRef = useRef<SearchRequest | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const departmentsAbortRef = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    if (!selectedCourse) return
    const resultAction = teachingClassResults.current?.querySelector<HTMLButtonElement>(
      'button:not(:disabled):not([aria-disabled="true"])',
    )
    const target = searching || !searched
      ? teachingClassHeading.current
      : errorMessage
        ? searchRetryButton.current
        : resultAction
    const focusTarget = target ?? teachingClassHeading.current
    focusTarget?.focus()
  }, [selectedCourse, searching, searched, errorMessage, searchResults])

  const { reloadSession } = session
  const { load: loadSubscriptions } = subs
  const { begin: beginPersonalSetup } = setup
  const setupRequested = new URLSearchParams(location.search).get('setup') === '1' && !reselectMode

  const loadSubscriptionList = useCallback(
    async (noCache = false) => {
      setSubsStatus('loading')
      try {
        await loadSubscriptions(noCache)
        setSubscriptionsLoaded(true)
        setSubsStatus('ready')
      } catch {
        setSubsStatus('error')
      }
    },
    [loadSubscriptions],
  )

  const loadExternalConfig = useCallback(async () => {
    setConfigStatus('loading')
    try {
      const config = await api.getMe()
      const supported = Object.keys(SOURCE_LABELS) as ExternalSourceType[]
      const search_types = supported.filter(type => config.external?.search_types?.includes(type))
      const create_types = search_types.filter(type => config.external?.create_types?.includes(type))
      setAvailability({ search_types, create_types })
      if (reselectMode) setSourceType('course')
      else if (search_types[0]) setSourceType(search_types[0])
      setConfigStatus('ready')
    } catch { setConfigStatus('error') }
  }, [reselectMode])

  useEffect(() => { void loadExternalConfig() }, [loadExternalConfig])

  useEffect(() => {
    let active = true
    reloadSession()
      .catch(() => {
        if (active) setSessionError(true)
      })
      .finally(() => {
        if (active) setSessionLoading(false)
      })
    return () => {
      active = false
    }
  }, [reloadSession])

  useEffect(() => {
    if (!reselectMode) void beginPersonalSetup()
  }, [beginPersonalSetup, reselectMode])

  useEffect(() => {
    if (setupRequested) return
    void loadSubscriptionList()
  }, [setupRequested, loadSubscriptionList])

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      searchAbortRef.current?.abort()
      departmentsAbortRef.current?.abort()
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

  async function reloadAfterCreate() {
    setSubsStatus('loading')
    try {
      await loadSubscriptions(true)
      setSubsStatus('ready')
    } catch {
      setSubsStatus('error')
      toast.error('订阅成功，但刷新订阅列表失败')
    }
  }

  async function retrySession() {
    setSessionLoading(true)
    setSessionError(false)
    try {
      await reloadSession()
      if (setupRequested) await beginPersonalSetup()
    } catch {
      setSessionError(true)
    } finally {
      setSessionLoading(false)
    }
  }

  function isPersonalSubscribed(sourceType: SourceType): boolean {
    return subs.subscriptions.some((s) => s.source_type === sourceType && s.is_personal)
  }

  function isExternalSubscribed(sourceId: string): boolean {
    return subs.subscriptions.some(
      (s) => s.source_version === 1 && s.source_id === sourceId && s.source_type === sourceType,
    )
  }

  function clearError() {
    setErrorMessage('')
    setNeedsRepair(false)
    setSubmitError('')
  }

  function clearPendingSearch() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    setSearchScheduled(false)
  }

  function startSearchRequest() {
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    return controller
  }

  const loadDepartments = useCallback(async () => {
    const controller = new AbortController()
    departmentsAbortRef.current?.abort()
    departmentsAbortRef.current = controller
    setDepartmentsLoading(true)
    setDepartmentsError(false)
    setDepartmentsSchoolLookup(false)
    try {
      const data = await api.getDepartments({
        signal: controller.signal,
        onSchoolLookup: () => {
          if (departmentsAbortRef.current === controller && !controller.signal.aborted) {
            setDepartmentsSchoolLookup(true)
          }
        },
      })
      if (controller.signal.aborted) return
      setDepartments(data.departments)
      setDepartmentTerm(data.session ?? null)
    } catch (err: unknown) {
      if (controller.signal.aborted) return
      setDepartmentsError(true)
      toast.error(parseApiError(err, '加载院系列表失败'))
    } finally {
      if (departmentsAbortRef.current === controller) setDepartmentsSchoolLookup(false)
      if (departmentsAbortRef.current === controller && !controller.signal.aborted) {
        setDepartmentsLoading(false)
      }
    }
  }, [])

  const canSearchExternal = session.can('external')
  useEffect(() => {
    if (!sessionLoading && canSearchExternal && availability.search_types.includes('admin_class') && sourceType === 'admin_class') {
      void loadDepartments()
    }
    return () => {
      departmentsAbortRef.current?.abort()
      setDepartmentsSchoolLookup(false)
    }
  }, [sessionLoading, canSearchExternal, availability, sourceType, loadDepartments])

  function handleTypeChange(next: string) {
    if (submittingRef.current) return
    const type = next as ExternalSourceType
    invalidateSearch()
    setSourceType(type)
    setKeyword('')
    setSelectedGrade('all')
    setSelectedDepartment('')
    setSearchResults([])
    setSearched(false)
    setTruncated(false)
    clearError()
  }

  function handleSearchAccessDenial(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status
    const code = apiErrorCode(error)
    const denied = status === 401 || status === 403 || (code !== undefined && [
      'FEATURE_NOT_ENABLED', 'FORBIDDEN', 'UNAUTHORIZED', 'PERMISSION_DENIED',
      'EXTERNAL_TARGET_FORBIDDEN', 'PAGE_PERMISSION_DENIED', 'SOURCE_FORBIDDEN', 'SEARCH_FORBIDDEN',
    ].includes(code))
    if (!denied) return false
    setSearchResults([])
    setSelectionToken(null)
    setSelectedCourse(null)
    catalogToken.current = null
    setErrorMessage('当前账号无权查询外部课表，请联系管理员确认访问权限，或重新登录后重试。')
    return true
  }

  async function runSearch(request: SearchRequest) {
    if (submittingRef.current) return
    clearPendingSearch()
    setSelectionToken(null)
    setSelectedCourse(null)
    catalogToken.current = null
    const seq = ++searchSeq.current
    lastSearchRef.current = request
    setSearching(true)
    setSearched(false)
    setTruncated(false)
    setSchoolLookupActive(false)
    clearError()
    const controller = startSearchRequest()
    try {
      const data = await api.searchExternal({
        source_type: request.sourceType,
        keyword: request.keyword,
        department_id:
          request.sourceType === 'admin_class' && request.departmentId
            ? request.departmentId
            : undefined,
        grade:
          request.sourceType === 'admin_class' && request.grade !== 'all'
            ? request.grade
            : undefined,
      }, {
        signal: controller.signal,
        onSchoolLookup: () => {
          if (seq === searchSeq.current && !controller.signal.aborted) setSchoolLookupActive(true)
        },
      })
      if (seq !== searchSeq.current) return
      setSearchResults(data.results)
      setSelectionToken(data.selection_token ?? null)
      setCurrentTerm(data.session ?? null)
      setTruncated(data.truncated === true)
    } catch (err: unknown) {
      if (seq !== searchSeq.current || controller.signal.aborted) return
      if (handleSearchAccessDenial(err)) return
      const code = apiErrorCode(err)
      if (code === 'CQU_SESSION_INACTIVE') {
        setErrorMessage('重庆大学统一认证登录状态已失效。')
        setNeedsRepair(true)
      } else {
        setErrorMessage(parseApiError(err, '搜索失败'))
      }
    } finally {
      if (seq !== searchSeq.current) return
      setSearching(false)
      setSearched(true)
      setSchoolLookupActive(false)
    }
  }

  function invalidateSearch(preserveResults = false) {
    searchSeq.current += 1
    clearPendingSearch()
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    setSearching(false)
    setSelectionToken(null)
    setSelectedCourse(null)
    catalogToken.current = null
    if (!preserveResults) setSearchResults([])
    setSearched(false)
    setTruncated(false)
    setSchoolLookupActive(false)
  }

  function retrySearch() {
    if (selectedCourse && catalogToken.current) { void selectCourse(selectedCourse, catalogToken.current); return }
    if (lastSearchRef.current) void runSearch(lastSearchRef.current)
  }

  function onKeywordChange(value: string) {
    if (submittingRef.current) return
    const request: SearchRequest = {
      sourceType,
      keyword: value,
      departmentId: selectedDepartment,
      grade: selectedGrade,
    }

    setKeyword(value)
    const validQuery = sourceType === 'admin_class' || value.trim().length >= 2
    invalidateSearch(validQuery && !selectedCourse)
    clearError()
    if (sourceType !== 'admin_class' && value.trim().length < 2) {
      setSearchResults([])
      setSearched(false)
      return
    }
    setSearchScheduled(true)
    debounceRef.current = setTimeout(() => {
      void runSearch(request)
    }, 300)
  }

  function handleDepartmentChange(deptId: string) {
    if (submittingRef.current) return
    setSelectedDepartment(deptId)
    clearPendingSearch()
    void runSearch({
      sourceType: 'admin_class',
      keyword,
      departmentId: deptId,
      grade: selectedGrade,
    })
  }

  function handleGradeChange(grade: string) {
    if (submittingRef.current) return
    setSelectedGrade(grade)
    clearPendingSearch()
    void runSearch({
      sourceType: 'admin_class',
      keyword,
      departmentId: selectedDepartment,
      grade,
    })
  }

  async function handlePersonalSubscribe(opt: PersonalOption) {
    if (submittingRef.current || subscriptionsUnavailable || subs.atLimit) return
    submittingRef.current = true
    setActiveSubmission({ kind: 'personal', id: opt.sourceType })
    clearPendingSearch()
    try {
      await personalFeedback.run(async () => {
        await api.createSubscription({
          sourceType: opt.sourceType,
          sourceName: opt.sourceName,
          isPersonal: true,
          // 不发送 sourceId：后端会将其固定为当前认证用户。
        })
        toast.success(`已订阅「${opt.label}」`)
        await reloadAfterCreate()
      }, opt.sourceType)
    } catch (err: unknown) {
      toast.error(parseApiError(err, '订阅失败'))
    } finally {
      submittingRef.current = false
      setActiveSubmission(null)
    }
  }

  async function selectCourse(item: SearchResult, token = selectionToken) {
    if (!token || submittingRef.current) return
    const seq = ++searchSeq.current
    clearPendingSearch()
    catalogToken.current = token
    setSelectedCourse(item)
    setSelectionToken(null)
    if (selectedCourse?.id !== item.id) setSearchResults([])
    setSearching(true)
    setSearched(false)
    setSchoolLookupActive(false)
    clearError()
    const controller = startSearchRequest()
    try {
      const data = await api.searchTeachingClasses(item.id, token, {
        signal: controller.signal,
        onSchoolLookup: () => {
          if (seq === searchSeq.current && !controller.signal.aborted) setSchoolLookupActive(true)
        },
      })
      if (seq !== searchSeq.current) return
      setSearchResults(data.results)
      setSelectionToken(data.selection_token)
      setCurrentTerm(data.session)
      setTruncated(data.truncated)
    } catch (error) {
      if (seq !== searchSeq.current || controller.signal.aborted) return
      if (handleSearchAccessDenial(error)) return
      setErrorMessage(parseApiError(error, '教学班查询失败，请重试或重新选择课程'))
    } finally {
      if (seq === searchSeq.current) {
        setSearching(false)
        setSearched(true)
        setSchoolLookupActive(false)
      }
    }
  }

  function chooseAnotherCourse() {
    if (submittingRef.current) return
    invalidateSearch()
    setSearched(false)
    clearError()
    requestAnimationFrame(() => courseInput.current?.focus())
  }

  async function handleExternalSubscribe(item: SearchResult) {
    if (!selectionToken || !currentTerm || searchPending || submittingRef.current || subscriptionsUnavailable || !creationAvailable || (!reselectMode && subs.atLimit)) return
    submittingRef.current = true
    setActiveSubmission({ kind: 'external', id: item.id })
    clearError()
    try {
      await subscribeFeedback.run(async () => {
        const body = {
          sourceType, sourceId: item.id, sourceName: item.name,
          selectionToken, sessionId: currentTerm.id,
        }
        if (reselectMode) {
          if (!reselectId || !canReselect) return
          const result = await api.reselectTeachingClass(reselectId, body)
          toast.success('已提交重选，正在重新同步；同步成功后原链接恢复可用')
          navigate('/dashboard', { state: { reselection: { id: reselectId, runId: result.run_id } } })
        } else {
          await api.createSubscription(body)
          toast.success(`已订阅「${item.name}」`)
          await reloadAfterCreate()
        }
      }, item.id)
    } catch (err: unknown) {
      const message = parseApiError(err, reselectMode ? '重选提交失败，请重试' : '订阅失败')
      setSubmitError(message)
      toast.error(message)
    } finally {
      submittingRef.current = false
      setActiveSubmission(null)
    }
  }

  const reselectSubscription = subs.subscriptions.find(sub => sub.id === reselectId)
  const reselectPending = reselectSubscription?.sync_status === 'queued' || reselectSubscription?.sync_status === 'running'
  const canReselect = Boolean(reselectSubscription && reselectSubscription.user_id === session.user?.id
    && reselectSubscription.source_version === 1 && reselectSubscription.source_type === 'course'
    && !reselectSubscription.is_personal && !reselectPending
    && (reselectSubscription.external_state === 'expired'
      || (reselectSubscription.external_state === 'reselecting' && reselectSubscription.sync_status === 'error')))
  const busy = (!reselectMode && setup.preparing) || sessionLoading
  const externalUnavailable = reselectMode ? !availability.search_types.includes('course') : availability.search_types.length === 0
  const externalLocked = !externalUnavailable && !canSearchExternal
  const creationAvailable = reselectMode || availability.create_types.includes(sourceType)
  const displayedTerm = currentTerm ?? departmentTerm
  const searchPending = searching || searchScheduled
  const subscriptionsUnavailable = subsStatus !== 'ready' || (!reselectMode && setup.error !== null)

  return (
    <>
      <PageHeader
        title={reselectMode ? '重新选择教学班' : '添加新订阅'}
        description={reselectMode ? '原订阅和全部链接地址保持不变；新教学班同步成功前，公共链接保持停用。' : '选择个人课表或外部课表，添加后可返回「我的订阅」查看日历链接。'}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard">我的订阅</Link>
          </Button>
        }
      />
      {busy ? (
        <AddContentSkeleton reselect={reselectMode} />
      ) : sessionError ? (
        <PageState
          state="error"
          title="暂时无法确认登录状态"
          description="请重试本次请求；仍失败时，稍后重新打开本页。"
          action={
            <Button type="button" variant="outline" onClick={() => void retrySession()}>
              重试
            </Button>
          }
        />
      ) : !subscriptionsLoaded && (subsStatus === 'loading' || (subsStatus === 'idle' && !setup.error)) ? (
        <AddContentSkeleton reselect={reselectMode} />
      ) : !subscriptionsLoaded && subsStatus === 'error' ? (
        <PageState
          state="error"
          title="订阅状态加载失败"
          description="暂时无法确认哪些内容已订阅。为避免重复添加，请重试加载。"
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadSubscriptionList(true)}
            >
              重试
            </Button>
          }
        />
      ) : reselectMode && !canReselect ? (
        <PageState state="error" title={reselectPending ? '教学班正在重新同步' : '无法重选此订阅'}
          description={reselectPending ? '请等待本次同步完成后再操作；公共链接保持停用。' : '仅支持本人已过期或重选失败的教学班订阅，请返回我的订阅确认状态。'} />
      ) : (
        <div aria-busy={subsStatus === 'loading'}>
          {subscriptionsLoaded && subsStatus === 'loading' && <span className="sr-only" role="status">正在刷新订阅状态</span>}
          {subscriptionsLoaded && subsStatus === 'error' && <Alert variant="destructive">
            <AlertDescription className="add-error-row">
              <span>订阅状态加载失败</span>
              <Button type="button" variant="outline" aria-label="重试加载订阅状态" onClick={() => void loadSubscriptionList(true)}>重试</Button>
            </AlertDescription>
          </Alert>}
          {!reselectMode && setup.error && (
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

          {!reselectMode && <section className="add-section" aria-labelledby="personal-heading">
            <h2 id="personal-heading" className="add-section-title">
              个人课表
            </h2>
            {!session.can('sync') ? (
              <div className="add-hint-box">
                个人课表订阅需要开通「日历同步」权限（内测阶段由管理员开通）。
              </div>
            ) : session.cquBindStatus === 'deleting' ? (
              <div className="add-hint-box">
                统一认证账号正在解绑，清理完成前无法同步个人课表。请前往
                <a href={`${AUTH_BASE_URL}/settings/cqu`} className="add-bind-link">认证中心查看解绑进度</a>。
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
                        disabled={activeSubmission?.kind === 'personal' && activeSubmission.id === opt.sourceType
                          ? false : submitting || subscriptionsUnavailable || subs.atLimit}
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
          </section>}

          <section className="add-section" aria-labelledby="external-heading">
            <h2 id="external-heading" className="add-section-title">
              外部订阅
              {configStatus === 'ready' && (externalUnavailable || externalLocked) && <span className="add-flag">
                {externalUnavailable ? '暂不可用' : '未开通'}
              </span>}
            </h2>
            {configStatus === 'loading' ? (
              <ExternalFormSkeleton reselect={reselectMode} />
            ) : configStatus === 'error' ? (
              <Alert variant="destructive"><AlertDescription>
                无法确认外部订阅可用性。
                <Button variant="outline" onClick={() => void loadExternalConfig()}>重试加载</Button>
              </AlertDescription></Alert>
            ) : externalUnavailable ? (
              <div className="add-hint-box">
                外部订阅（教师、教室、课程、行政班等）功能暂不可用。
              </div>
            ) : externalLocked ? (
              <div className="add-hint-box">
                外部订阅（教师、教室、课程、行政班等）功能尚未开通。
              </div>
            ) : reselectMode && session.cquBindStatus !== 'active' ? (
              <div className="add-hint-box">重选需要有效的重庆大学统一认证绑定。
                <a href={session.cquBindStatus === 'deleting' ? `${AUTH_BASE_URL}/settings/cqu` : bindHref}>查看或修复绑定</a>
              </div>
            ) : (
              <div className="add-card">
                {reselectMode && <p className="add-hint">重选失败后，可在上次提交5分钟后重试。</p>}
                <Tabs value={sourceType} onValueChange={handleTypeChange} className="add-external-tabs">
                  {!reselectMode && <TabsList className="add-source-tabs" aria-label="来源类型">
                    {availability.search_types.map((type) => (
                      <TabsTrigger className="add-touch-control" key={type} value={type} disabled={submitting}>
                        {SOURCE_LABELS[type]}
                      </TabsTrigger>
                    ))}
                  </TabsList>}
                  <TabsContent value={sourceType} asChild
                    {...(reselectMode ? { role: 'group', 'aria-label': '选择教学班', 'aria-labelledby': undefined } : {})}>
                    <form className="add-external-panel" aria-busy={searchPending || submitting} onSubmit={(event) => {
                      event.preventDefault()
                      if (submitting || selectedCourse || searching || (sourceType !== 'admin_class' && keyword.trim().length < 2)) return
                      clearPendingSearch()
                      void runSearch({ sourceType, keyword, departmentId: selectedDepartment, grade: selectedGrade })
                    }}>

                      {displayedTerm && <p className="add-result-extra">当前学期：{displayedTerm.name}</p>}
                      <p className="add-result-extra">仅查询学校当前学期。</p>
                      {!creationAvailable && <p className="add-result-extra">当前支持搜索，订阅创建暂未开放。</p>}
                      {sourceType === 'admin_class' && (
                        <div className="add-admin-filters">
                          <div className="add-field">
                            <Label htmlFor="department-select">选择学院</Label>
                            <DepartmentTreeSelect
                              id="department-select"
                              departments={departments}
                              loading={departmentsLoading}
                              disabled={submitting}
                              value={selectedDepartment}
                              onChange={handleDepartmentChange}
                            />
                            {selectedDepartment && (
                              <Button type="button" variant="ghost" size="default" disabled={submitting} onClick={() => handleDepartmentChange('')}>
                                清除学院筛选
                              </Button>
                            )}
                            {departmentsLoading && departmentsSchoolLookup && <p role="status" className="add-result-extra">目录中未找到，正在向学校查询，耗时会比平常稍长。</p>}
                          </div>
                          <div className="add-field">
                            <Label htmlFor="grade-select">年级</Label>
                            <Select disabled={submitting} value={selectedGrade} onValueChange={handleGradeChange}>
                              <SelectTrigger className="add-touch-control" id="grade-select" aria-label="年级">
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
                          <Label htmlFor="external-keyword">搜索班级</Label>
                          <div className="add-search-field">
                            <Search aria-hidden />
                            <Input
                              id="external-keyword"
                              type="search"
                              aria-describedby="external-search-help"
                              aria-label="搜索班级"
                              placeholder="输入班级名称关键词（可选）"
                              value={keyword}
                              disabled={submitting}
                              onChange={(event) => onKeywordChange(event.target.value)}
                            />
                          </div>
                          {departmentsError && (
                            <Alert variant="destructive">
                              <AlertDescription className="add-error-row">
                                <span>院系列表加载失败，可先直接搜索班级。</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="default"
                                  disabled={departmentsLoading || submitting}
                                  onClick={() => void loadDepartments()}
                                >
                                  重试
                                </Button>
                              </AlertDescription>
                            </Alert>
                          )}
                        </div>
                      )}

                      {sourceType !== 'admin_class' && !selectedCourse && (
                        <div className="add-field">
                        <Label htmlFor="external-keyword">搜索{SOURCE_LABELS[sourceType]}</Label>
                        <div className="add-search-field">
                          <Search aria-hidden />
                          <Input
                            type="search"
                            id="external-keyword"
                            aria-describedby="external-search-help"
                            ref={courseInput}
                            aria-label={`搜索${SOURCE_LABELS[sourceType]}`}
                            placeholder={SEARCH_PLACEHOLDERS[sourceType]}
                            value={keyword}
                            disabled={submitting}
                            onChange={(event) => onKeywordChange(event.target.value)}
                          />
                        </div>
                        </div>
                      )}

                      {!selectedCourse && <p id="external-search-help" className="add-hint">{sourceType === 'admin_class' ? '可按学院、年级筛选，也可直接搜索班级。' : '请输入至少两个字符，可按 Enter 搜索。'}</p>}
                      {selectedCourse && <div className="add-field"><h3 ref={teachingClassHeading} tabIndex={-1} className="add-result-name" aria-describedby={searching ? 'external-lookup-status' : errorMessage ? 'external-search-error' : undefined}>{selectedCourse.name} · 选择教学班</h3><Button type="button" variant="outline" disabled={submitting} onClick={chooseAnotherCourse}>重新选择课程</Button></div>}
                      {!selectedCourse && <Button className="add-touch-control" type="submit" variant="outline"
                        disabled={submitting || searching || (sourceType !== 'admin_class' && keyword.trim().length < 2)}
                        aria-describedby="external-search-help">
                        搜索
                      </Button>}
                      {truncated && <p className="add-warning" role="status">结果可能不完整，请缩小搜索范围。</p>}
                      {searchPending && <>
                        {schoolLookupActive && <p className="add-searching" role="status">目录中未找到，正在向学校查询，耗时会比平常稍长。</p>}
                        {searchResults.length === 0
                          ? <LoadingRegion id="external-lookup-status" label="搜索中…"><SearchResultsSkeleton /></LoadingRegion>
                          : <span id="external-lookup-status" className="sr-only" role="status">搜索中…</span>}
                      </>}

                      {searched && !searching && !errorMessage && searchResults.length > 0 && (!selectionToken || !currentTerm) && <p id="external-selection-help" className="add-warning">本次结果暂不能选择，请重新搜索。</p>}
                      {searchResults.length > 0 && (
                        <ul ref={teachingClassResults} className="add-results" aria-label="搜索结果" role="list" aria-busy={searchPending}>
                          {searchResults.map((item) => (
                            <li key={item.id} className="add-result">
                              <div className="add-result-info">
                                <p className="add-result-name">{item.name}</p>
                                {item.extra && <p className="add-result-extra">{item.extra}</p>}
                              </div>
                              {sourceType === 'course' && !selectedCourse ? (
                                <Button className="add-touch-control" type="button" size="default" aria-label={`选择课程${item.name}`} disabled={submitting || searchPending || !selectionToken || !currentTerm} aria-describedby={(!selectionToken || !currentTerm) ? "external-selection-help" : undefined} onClick={() => void selectCourse(item)}>选择教学班</Button>
                              ) : !reselectMode && isExternalSubscribed(item.id) ? (
                                <Button
                                  variant="outline"
                                  size="default"
                                  disabled
                                  aria-label={`已订阅${item.name}`}
                                >
                                  <Check aria-hidden />
                                  已订阅
                                </Button>
                              ) : (
                                <ActionButton
                                  className="add-touch-control"
                                  type="button"
                                  size="default"
                                  state={subscribeFeedback.stateOf(item.id)}
                                  labels={{
                                    idle: reselectMode ? '重选教学班' : '订阅',
                                    loading: reselectMode ? '提交中…' : '订阅中…',
                                    success: reselectMode ? '已提交' : '已订阅',
                                    error: '失败，重试',
                                  }}
                                  disabled={activeSubmission?.kind === 'external' && activeSubmission.id === item.id
                                    ? false : submitting || !creationAvailable || !selectionToken || !currentTerm || searchPending || subscriptionsUnavailable || (!reselectMode && subs.atLimit)}
                                  aria-describedby={(!selectionToken || !currentTerm) ? "external-selection-help" : undefined}
                                  aria-label={`${reselectMode ? '重选' : '订阅'}${item.name}`}
                                  onClick={() => void handleExternalSubscribe(item)}
                                />
                              )}
                            </li>
                          ))}
                        </ul>
                      )}

                      {searched && !searching && !errorMessage && searchResults.length === 0 && (
                        <PageState state="empty" title="未找到结果" description={selectedCourse ? '此课程暂无教学班，可重新选择课程。' : '请更换关键词或调整筛选后重试。'} />
                      )}

                      {!reselectMode && subs.atLimit && (
                        <p className="add-warning">已达最大订阅数，请先删除不需要的订阅</p>
                      )}
                      {submitError && <Alert variant="destructive"><AlertDescription>{submitError}。所选内容已保留，可重试提交。</AlertDescription></Alert>}
                    </form>
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </section>

          {errorMessage && (
            <Alert id="external-search-error" variant="destructive">
              <AlertDescription className="add-error-row">
                <span>{errorMessage}</span>
                {needsRepair && (
                  <>
                    {' '}
                    <a href={repairBindHref} className="add-bind-link">
                      重新绑定重庆大学统一认证账号
                    </a>
                  </>
                )}
                {!needsRepair && (
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    ref={searchRetryButton}
                    disabled={submitting || searchPending}
                    onClick={retrySearch}
                  >
                    重试搜索
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </>
  )
}
