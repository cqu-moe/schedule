export interface UserInfo {
  student_id: string
  calendar_token: string
  oauth_expires_at: string
  last_synced_at: string | null
}

export interface Subscription {
  calendar_token: string
  source_type: string
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

export interface CaptchaConfig {
  enabled: boolean
  sitekey: string
}

export interface AppConfig {
  public_url: string
}

export interface HealthStatus {
  status: string
}

export interface AuthResult {
  success: boolean
  token?: string
  error?: string
}
