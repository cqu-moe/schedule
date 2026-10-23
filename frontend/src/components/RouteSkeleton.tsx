import { useLocation } from 'react-router'
import { AddRouteSkeleton, CalendarRouteSkeleton, DashboardRouteSkeleton, DocsRouteSkeleton } from './LoadingSkeletons'

export default function RouteSkeleton({ pathname, search }: { pathname?: string; search?: string }) {
  const location = useLocation()
  const path = (pathname ?? location.pathname).replace(/\/+$/, '').toLowerCase() || '/'
  if (path === '/add') return <AddRouteSkeleton reselect={new URLSearchParams(search ?? location.search).has('reselect')} />
  if (path.startsWith('/view/') || path.startsWith('/calendar/')) return <CalendarRouteSkeleton />
  if (path === '/dashboard') return <DashboardRouteSkeleton />
  if (path === '/api-docs') return <DocsRouteSkeleton />
  return null
}
