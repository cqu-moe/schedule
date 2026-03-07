export interface UserInfo {
  student_id: string
  calendar_token: string
  oauth_expires_at: string
  last_synced_at: string | null
}

export type SourceType =
  | "personal_all"
  | "personal_courses"
  | "personal_exams"
  | "instructor"
  | "room"
  | "laboratory"
  | "course"
  | "admin_class";

export interface Subscription {
  calendar_token: string
  source_type: SourceType
  source_id: string
  source_name: string
  is_personal: boolean
  session_name: string
  last_synced_at: string | null
  subscription_url: string
}

export interface SubscriptionList {
  subscriptions: Subscription[]
  max: number
}

export interface SearchResult {
  id: string
  name: string
  extra: string
}

export interface AppConfig {
  public_url: string
  captcha: {
    enabled: boolean
    sitekey: string
  }
}

export interface HealthStatus {
  status: string
}

export interface AuthResult {
  success: boolean
  token?: string
  error?: string
}

export interface FormattedEvent {
  name: string
  type: 'course' | 'exam'
  instructor: string | null
  location: string
  day_of_week: number | null
  start_time: string
  end_time: string
  week: number | null
}

export interface CalendarData {
  semester: string
  semester_start: string
  generated_at: string
  events: FormattedEvent[]
}

export interface RotateTokenPrepare {
  new_token: string
}

export interface RotateTokenConfirm {
  calendar_token: string
}

export interface RotateSubscription {
  calendar_token: string
  subscription_url: string
}

export interface RotateAllSubscriptions {
  count: number
}
