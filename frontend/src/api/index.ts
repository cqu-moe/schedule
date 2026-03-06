import axios, { type AxiosError } from 'axios'
import type {
  UserInfo,
  SubscriptionList,
  SearchResult,
  AppConfig,
  HealthStatus,
  Subscription,
} from '@/types/api'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

client.interceptors.response.use(undefined, (error: AxiosError) => {
  if (error.response?.status === 429 && !(error.response?.data as Record<string, unknown>)?.detail) {
    error.response.data = { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } }
  }
  return Promise.reject(error)
})

const authHeaders = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

export default {
  // 用户相关
  async register(studentId: string, password: string, captchaToken: string | null = null): Promise<UserInfo> {
    const headers: Record<string, string> = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users', {
      student_id: studentId,
      password: password
    }, { headers, timeout: 120000 })
    return response.data
  },

  async recoverToken(studentId: string, password: string, captchaToken: string | null = null): Promise<UserInfo> {
    const headers: Record<string, string> = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users/recover', {
      student_id: studentId,
      password: password
    }, { headers })
    return response.data
  },

  async recoverTokenVerify(studentId: string, password: string, captchaToken: string | null = null): Promise<UserInfo> {
    const headers: Record<string, string> = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users/recover/verify', {
      student_id: studentId,
      password: password
    }, { headers, timeout: 120000 })
    return response.data
  },

  async getUserInfo(token: string): Promise<UserInfo> {
    const response = await client.get('/users/me', authHeaders(token))
    return response.data
  },

  async deleteUser(token: string): Promise<void> {
    await client.delete('/users/me', authHeaders(token))
  },

  // 搜索相关
  async searchSchedule(token: string, sourceType: string, keyword: string, departmentId = '', grade = ''): Promise<SearchResult[]> {
    const params = new URLSearchParams({ source_type: sourceType, keyword })
    if (departmentId) params.append('department_id', departmentId)
    if (grade) params.append('grade', grade)
    const response = await client.get(`/search?${params}`, authHeaders(token))
    return response.data
  },

  async getDepartments(token: string): Promise<SearchResult[]> {
    const response = await client.get('/departments', authHeaders(token))
    return response.data
  },

  // 订阅管理
  async createSubscription(token: string, sourceType: string, sourceId: string, sourceName: string, captchaToken: string | null = null): Promise<Subscription> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const body = {
      source_type: sourceType,
      source_id: sourceId,
      source_name: sourceName,
    }
    const response = await client.post('/subscriptions', body, { headers, timeout: 120000 })
    return response.data
  },

  async getSubscriptions(token: string): Promise<SubscriptionList> {
    const response = await client.get('/subscriptions', authHeaders(token))
    return response.data
  },

  async deleteSubscription(token: string, subToken: string): Promise<void> {
    await client.delete(`/subscriptions/${subToken}`, authHeaders(token))
  },

  async refreshSubscription(token: string, subToken: string): Promise<Subscription> {
    const response = await client.post(`/subscriptions/${subToken}/refresh`, null, { ...authHeaders(token), timeout: 120000 })
    return response.data
  },

  async getHealth(): Promise<HealthStatus> {
    const response = await client.get('/health')
    return response.data
  },

  async getConfig(): Promise<AppConfig> {
    const response = await client.get('/config')
    return response.data
  },
}
