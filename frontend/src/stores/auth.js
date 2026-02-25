import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '../api'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('calendar_token') || '')
  const userInfo = ref(null)
  const loading = ref(false)

  const isAuthenticated = computed(() => !!token.value)

  async function register(studentId, password, captchaToken = null) {
    loading.value = true
    try {
      const response = await api.register(studentId, password, captchaToken)
      token.value = response.calendar_token
      localStorage.setItem('calendar_token', token.value)
      return { success: true, token: response.calendar_token }
    } catch (error) {
      if (error.response?.status === 429) {
        return { success: false, error: error.response.data.detail }
      }
      const detail = error.response?.data?.detail
      if (detail === 'CAPTCHA_REQUIRED' || detail === 'CAPTCHA_FAILED') {
        return { success: false, error: '验证码验证失败，请刷新页面重试' }
      }
      const errorObj = detail?.error || detail
      if (errorObj?.code === 'USER_EXISTS') {
        return { success: false, error: '该账号已注册，请使用 Token 登录' }
      }
      return { success: false, error: errorObj?.message || '注册失败' }
    } finally {
      loading.value = false
    }
  }

  async function loginWithToken(calendarToken) {
    loading.value = true
    try {
      const response = await api.getUserInfo(calendarToken)
      token.value = calendarToken
      userInfo.value = response
      localStorage.setItem('calendar_token', token.value)
      return { success: true }
    } catch (error) {
      return { success: false, error: 'Token 无效或已过期' }
    } finally {
      loading.value = false
    }
  }

  async function fetchUserInfo() {
    if (!token.value) return
    try {
      userInfo.value = await api.getUserInfo(token.value)
    } catch (error) {
      logout()
    }
  }

  function logout() {
    token.value = ''
    userInfo.value = null
    localStorage.removeItem('calendar_token')
  }

  // 初始化时检查 token 有效性
  if (token.value) {
    fetchUserInfo()
  }

  return {
    token,
    userInfo,
    loading,
    isAuthenticated,
    register,
    loginWithToken,
    fetchUserInfo,
    logout
  }
})
