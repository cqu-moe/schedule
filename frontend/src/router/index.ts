import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export const RouteNames = {
  Home: 'Home',
  Login: 'Login',
  Register: 'Register',
  Recover: 'Recover',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
} as const

const routes = [
  {
    path: '/',
    name: RouteNames.Home,
    component: () => import('@/views/Home.vue')
  },
  {
    path: '/login',
    name: RouteNames.Login,
    component: () => import('@/views/Login.vue')
  },
  {
    path: '/register',
    name: RouteNames.Register,
    component: () => import('@/views/Register.vue')
  },
  {
    path: '/recover',
    name: RouteNames.Recover,
    component: () => import('@/views/Recover.vue')
  },
  {
    path: '/dashboard',
    name: RouteNames.Dashboard,
    component: () => import('@/views/Dashboard.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/add',
    name: RouteNames.Add,
    component: () => import('@/views/Add.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/api-docs',
    name: RouteNames.ApiDocs,
    component: () => import('@/views/Docs.vue')
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

export default router
