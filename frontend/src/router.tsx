import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  redirect,
  type RouteObject,
  useRouteError,
} from 'react-router'
import { Button, ContentContainer, PageHeader, PageState } from '@cqu-moe/ui'
import Layout from '@/layout'

const SITE_NAME = 'CQU Schedule'

function RouteError() {
  const error = useRouteError()
  const forbidden = isRouteErrorResponse(error) && error.status === 403
  return (
    <main>
      <ContentContainer>
        <PageHeader title={forbidden ? '访问受限' : '页面加载失败'} />
        <PageState
          state={forbidden ? 'forbidden' : 'error'}
          title={forbidden ? '没有访问权限' : '暂时无法加载页面'}
          description={forbidden ? '请联系管理员确认权限。' : '请稍后重试；仍失败时联系管理员。'}
          action={
            <Button asChild variant="outline">
              <Link to="/">返回首页</Link>
            </Button>
          }
        />
      </ContentContainer>
    </main>
  )
}

const NotFound = (
  <>
    <PageHeader title="页面不存在" />
    <PageState
      state="not-found"
      title="未找到页面"
      description="请检查链接，或返回首页。"
      action={
        <Button asChild variant="outline">
          <Link to="/">返回首页</Link>
        </Button>
      }
    />
  </>
)

export const appRoutes: RouteObject[] = [
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('@/views/Home')).default }),
        handle: { title: `重庆大学课表订阅 | ${SITE_NAME}` },
      },
      {
        path: 'dashboard',
        lazy: async () => ({ Component: (await import('@/views/Dashboard')).default }),
        handle: { title: `我的订阅 | ${SITE_NAME}` },
      },
      {
        path: 'add',
        lazy: async () => ({ Component: (await import('@/views/Add')).default }),
        handle: { title: `添加订阅 | ${SITE_NAME}` },
      },
      {
        path: 'api-docs',
        lazy: async () => ({ Component: (await import('@/views/Docs')).default }),
        handle: { title: `API 文档 | ${SITE_NAME}` },
      },
      {
        path: 'changelog',
        lazy: async () => ({ Component: (await import('@/views/Changelog')).default }),
        handle: { title: `更新日志 | ${SITE_NAME}` },
      },
      {
        path: 'view/:token',
        lazy: async () => ({ Component: (await import('@/views/Calendar')).default }),
        handle: { title: `课表 | ${SITE_NAME}` },
      },
      {
        // Redirect old /calendar/:sub_token links to /view/:sub_token.
        path: 'calendar/:sub_token',
        loader: ({ params, request }) => {
          const url = new URL(request.url)
          return redirect(`/view/${params.sub_token}${url.search}`, 302)
        },
      },
      { path: '*', element: NotFound },
    ],
  },
]

export const router = createBrowserRouter(appRoutes)
