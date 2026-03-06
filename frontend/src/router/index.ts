import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const SITE_NAME = 'CQU Schedule'

export const RouteNames = {
  Home: 'Home',
  Login: 'Login',
  Register: 'Register',
  Recover: 'Recover',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
  Changelog: 'Changelog',
  Calendar: 'Calendar',
} as const

const routes = [
  {
    path: '/',
    name: RouteNames.Home,
    component: () => import('@/views/Home.vue'),
    meta: { title: `重庆大学课表订阅 | ${SITE_NAME}` }
  },
  {
    path: '/login',
    name: RouteNames.Login,
    component: () => import('@/views/Login.vue'),
    meta: { title: `登录 | ${SITE_NAME}` }
  },
  {
    path: '/register',
    name: RouteNames.Register,
    component: () => import('@/views/Register.vue'),
    meta: { title: `注册 | ${SITE_NAME}` }
  },
  {
    path: '/recover',
    name: RouteNames.Recover,
    component: () => import('@/views/Recover.vue'),
    meta: { title: `找回 Token | ${SITE_NAME}` }
  },
  {
    path: '/dashboard',
    name: RouteNames.Dashboard,
    component: () => import('@/views/Dashboard.vue'),
    meta: { title: `我的订阅 | ${SITE_NAME}`, requiresAuth: true }
  },
  {
    path: '/add',
    name: RouteNames.Add,
    component: () => import('@/views/Add.vue'),
    meta: { title: `添加订阅 | ${SITE_NAME}`, requiresAuth: true }
  },
  {
    path: '/api-docs',
    name: RouteNames.ApiDocs,
    component: () => import('@/views/Docs.vue'),
    meta: { title: `API 文档 | ${SITE_NAME}` }
  },
  {
    path: '/changelog',
    name: RouteNames.Changelog,
    component: () => import('@/views/Changelog.vue'),
    meta: { title: `更新日志 | ${SITE_NAME}` }
  },
  {
    path: '/calendar/:sub_token',
    name: RouteNames.Calendar,
    component: () => import('@/views/Calendar.vue'),
    meta: { title: `课表日历 | ${SITE_NAME}` }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// 路由守卫
router.beforeEach((to, from, next) => {
  const authStore = useAuthStore()

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    next({ name: RouteNames.Login, query: { redirect: to.fullPath } })
  } else {
    next()
  }
})

router.afterEach((to) => {
  document.title = (to.meta.title as string) ?? `重庆大学课表订阅 | ${SITE_NAME}`
})

export default router
