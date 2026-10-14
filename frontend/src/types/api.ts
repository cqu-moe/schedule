// ── v2 session / identity types ──────────────────────────────────────────────

export interface SessionUser {
  id: string
  name: string
  email: string
  role: string
}

export interface CalendarCaps {
  sync: boolean
  external: boolean
  share: boolean
  change_notification: boolean
  sub_limit: number | null
  share_limit: number | null
  sync_interval: number | null
  manual_refresh: number | null
  external_sync_interval?: number
  external_manual_refresh?: number | null
}

export interface NotificationSettings {
  eligible: boolean
  enabled: boolean
}

export interface MeResponse {
  user: SessionUser
  caps: {
    calendar: CalendarCaps
  }
  /**
   * CQU identity binding status, supplied by newer auth deploys.
   * Absent (undefined) means "unknown" — never treat it as unbound.
   */
  cquBindStatus?: CquBindStatus
}

export type CquBindStatus = 'pending' | 'active' | 'revoked' | 'deleting' | 'unbound'

// ── v2 link / subscription types ─────────────────────────────────────────────

export type LinkFormat = 'ics' | 'origin_json' | 'data_json' | 'csv' | 'web'

export interface CalendarLink {
  is_active?: boolean
  id: string
  token: string
  label: string | null
  formats: LinkFormat[]
  is_default: boolean
}

export type SourceType =
  | 'personal_all'
  | 'personal_courses'
  | 'personal_exams'
  | 'instructor'
  | 'room'
  | 'laboratory'
  | 'course'
  | 'admin_class'

export interface Subscription {
  id: string
  user_id: string
  source_type: SourceType
  source_id: string
  source_version?: number
  external_state?: 'active' | 'expired' | 'reselecting'
  import_quality?: 'complete' | 'partial' | 'empty' | null
  skipped_count?: number
  source_name: string
  session_id: string | null
  session_name: string | null
  semester_start: string | null
  is_personal: boolean
  is_active: boolean
  last_synced_at: string | null
  sync_status: 'idle' | 'queued' | 'running' | 'success' | 'error'
  sync_run_id: string | null
  sync_trigger: 'cron' | 'manual' | 'initial' | 'admin' | null
  sync_requested_at: string | null
  sync_started_at: string | null
  sync_finished_at: string | null
  sync_error_code: string | null
  sync_error_message: string | null
  manual_refresh_at: string | null
  created_at: string
  updated_at: string
  links: CalendarLink[]
}

export interface SyncQueuedResponse {
  status: 'queued'
  run_id: string
  affected_subscription_ids: string[]
  cooldown_until: string
  manual_remaining?: number | null
}

export type PersonalSetupDispatchStatus = 'pending' | 'sending' | 'sent' | 'failed'

export interface PersonalSetupSummary {
  status: 'created' | 'existing'
  subscription_ids: string[]
  run_id: string | null
  dispatch_status: PersonalSetupDispatchStatus
}

export interface DefaultSubscriptionsResponse {
  status: 'created' | 'resumed' | 'existing' | 'skipped'
  subscription_ids: string[]
  run_id: string | null
  dispatch_status: PersonalSetupDispatchStatus | 'none'
}

export interface SubscriptionList {
  subscriptions: Subscription[]
  count: number
  personal_setup?: PersonalSetupSummary | null
  manual_remaining?: number | null
}

// ── v2 search / department types ─────────────────────────────────────────────

export type ExternalSourceType = Extract<SourceType, 'instructor' | 'room' | 'laboratory' | 'course' | 'admin_class'>
export interface ExternalSession { id: string; name: string }
export interface ExternalSearchResponse {
  stage?: 'courses' | 'classes'
  course?: { id: string; name: string }
  selection_token: string
  session: ExternalSession
  results: SearchResult[]
  truncated: boolean
}
export interface ExternalAvailability {
  search_types: ExternalSourceType[]
  create_types: ExternalSourceType[]
}

export interface SearchResult {
  id: string
  name: string
  extra: string
}

export interface DepartmentNode {
  id: string
  name: string
  children?: DepartmentNode[]
}

// ── v2 link request bodies ────────────────────────────────────────────────────

export interface CreateLinkBody {
  label?: string
  formats: LinkFormat[]
}

export interface PatchLinkBody {
  label?: string | null
  formats?: LinkFormat[]
}

// ── v2 link rotation response ─────────────────────────────────────────────────

export interface RotateLinkResult {
  token: string
  url?: string
}

// ── app config ────────────────────────────────────────────────────────────────

export interface AppConfig {
  public_url: string
  external?: ExternalAvailability
}

// ── calendar / view page types (unchanged; used by Calendar.vue / FE-4) ──────

export interface FormattedEvent {
  name: string
  type: 'course' | 'exam'
  instructor: string | null
  location: string
  day_of_week: number | null
  start_time: string
  end_time: string
  week: number | null
  experiment_name?: string
}

export interface CalendarData {
  semester: string
  semester_start: string
  generated_at: string
  events: FormattedEvent[]
}
