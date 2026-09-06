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
  sub_limit: number | null
  share_limit: number | null
  sync_interval: number | null
  manual_refresh: number | null
}

export interface MeResponse {
  user: SessionUser
  caps: {
    calendar: CalendarCaps
  }
}

// ── v2 link / subscription types ─────────────────────────────────────────────

export type LinkFormat = 'ics' | 'origin_json' | 'data_json' | 'csv' | 'web'

export interface CalendarLink {
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
  source_name: string
  session_id: string | null
  session_name: string | null
  semester_start: string | null
  is_personal: boolean
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
}

export interface SubscriptionList {
  subscriptions: Subscription[]
  count: number
}

// ── v2 search / department types ─────────────────────────────────────────────

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

// ── app config & health ───────────────────────────────────────────────────────

export interface AppConfig {
  public_url: string
}

export interface HealthStatus {
  status: string
  commit?: string
  date?: string
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
