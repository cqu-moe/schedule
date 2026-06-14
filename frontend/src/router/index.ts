import { createRouter, createWebHistory } from 'vue-router'

const SITE_NAME = 'CQU Schedule'

export const RouteNames = {
  Home: 'Home',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
  Changelog: 'Changelog',
  // /calendar/:sub_token kept for backward compat; FE-4 will replace with /view/:token
  Calendar: 'Calendar',
} as const

// Removed: Login, Register, Recover (auth is now delegated to auth.cqu.moe via cookie;
// the 401 axios interceptor handles unauthenticated redirects — no router guard needed).

const routes = [
  {
    path: '/',
    name: RouteNames.Home,
    component: () => import('@/views/Home.vue'),
    meta: { title: `重庆大学课表订阅 | ${SITE_NAME}` },
  },
  {
    path: '/dashboard',
    name: RouteNames.Dashboard,
    component: () => import('@/views/Dashboard.vue'),
    meta: { title: `我的订阅 | ${SITE_NAME}` },
  },
  {
    path: '/add',
    name: RouteNames.Add,
    component: () => import('@/views/Add.vue'),
    meta: { title: `添加订阅 | ${SITE_NAME}` },
  },
  {
    path: '/api-docs',
    name: RouteNames.ApiDocs,
    component: () => import('@/views/Docs.vue'),
    meta: { title: `API 文档 | ${SITE_NAME}` },
  },
  {
    path: '/changelog',
    name: RouteNames.Changelog,
    component: () => import('@/views/Changelog.vue'),
    meta: { title: `更新日志 | ${SITE_NAME}` },
  },
  {
    // Kept for backward compat. FE-4 will introduce /view/:token for the new
    // public share-link view. At that point, this route can be retired.
    path: '/calendar/:sub_token',
    name: RouteNames.Calendar,
    component: () => import('@/views/Calendar.vue'),
    meta: { title: `课表日历 | ${SITE_NAME}` },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// No beforeEach auth guard — cookie-based auth means every page is accessible;
// the 401 axios interceptor redirects to auth.cqu.moe/login on API failure.

router.afterEach((to) => {
  document.title = (to.meta.title as string) ?? `重庆大学课表订阅 | ${SITE_NAME}`
})

export default router
