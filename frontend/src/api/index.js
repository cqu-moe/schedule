import axios from 'axios'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

client.interceptors.response.use(undefined, (error) => {
  if (error.response?.status === 429 && !error.response?.data?.detail) {
    error.response.data = { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } }
  }
  return Promise.reject(error)
})

const authHeaders = (token) => ({ headers: { Authorization: `Bearer ${token}` } })

export default {
  // 用户相关
  async register(studentId, password, captchaToken = null) {
    const headers = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users', {
      student_id: studentId,
      password: password
    }, { headers, timeout: 120000 })
    return response.data
  },

  async recoverToken(studentId, password, captchaToken = null) {
    const headers = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users/recover', {
      student_id: studentId,
      password: password
    }, { headers })
    return response.data
  },

  async recoverTokenVerify(studentId, password, captchaToken = null) {
    const headers = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users/recover/verify', {
      student_id: studentId,
      password: password
    }, { headers, timeout: 120000 })
    return response.data
  },

  async getCaptchaConfig() {
    const response = await client.get('/captcha/config')
    return response.data
  },

  async getUserInfo(token) {
    const response = await client.get('/users/me', authHeaders(token))
    return response.data
  },

  async deleteUser(token) {
    await client.delete('/users/me', authHeaders(token))
  },

  // 搜索相关
  async searchSchedule(token, sourceType, keyword, departmentId = '', grade = '') {
    const params = new URLSearchParams({ source_type: sourceType, keyword })
    if (departmentId) params.append('department_id', departmentId)
    if (grade) params.append('grade', grade)
    const response = await client.get(`/search?${params}`, authHeaders(token))
    return response.data
  },

  async getDepartments(token) {
    const response = await client.get('/departments', authHeaders(token))
    return response.data
  },

  // 订阅管理
  async createSubscription(token, sourceType, sourceId, sourceName, captchaToken = null) {
    const headers = { Authorization: `Bearer ${token}` }
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const body = {
      source_type: sourceType,
      source_id: sourceId,
      source_name: sourceName,
    }
    const response = await client.post('/subscriptions', body, { headers, timeout: 120000 })
    return response.data
  },

  async getSubscriptions(token) {
    const response = await client.get('/subscriptions', authHeaders(token))
    return response.data
  },

  async deleteSubscription(token, subToken) {
    await client.delete(`/subscriptions/${subToken}`, authHeaders(token))
  },

  async refreshSubscription(token, subToken) {
    const response = await client.post(`/subscriptions/${subToken}/refresh`, null, { ...authHeaders(token), timeout: 120000 })
    return response.data
  },

  async getHealth() {
    const response = await client.get('/health')
    return response.data
  },

  async getConfig() {
    const response = await client.get('/config')
    return response.data
  },
}
