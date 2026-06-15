import { createRouter, createWebHistory } from 'vue-router'

const SITE_NAME = 'CQU Schedule'

export const RouteNames = {
  Home: 'Home',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
  Changelog: 'Changelog',
  View: 'View',
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
    // Public read-only calendar page for share links (FE-4).
    // The "web" format in buildLinkUrl generates /view/{token}.
    path: '/view/:token',
    name: RouteNames.View,
    component: () => import('@/views/Calendar.vue'),
    meta: { title: `课表 | ${SITE_NAME}` },
  },
  {
    // Redirect old /calendar/:sub_token links to /view/:sub_token (harmless safety net).
    path: '/calendar/:sub_token',
    redirect: (to) => ({ path: `/view/${to.params.sub_token}` }),
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
