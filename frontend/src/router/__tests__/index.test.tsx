import { describe, it, expect } from 'vitest'
import { createMemoryRouter } from 'react-router'
import { appRoutes } from '@/router'

async function navigate(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: ['/'] })
  await router.initialize()
  await router.navigate(path)
  return router
}

describe('router (v2)', () => {
  it.each(['/', '/dashboard', '/add', '/api-docs', '/changelog'])(
    '%s resolves to a matched route',
    async (path) => {
      const router = await navigate(path)
      expect(router.state.location.pathname).toBe(path)
      expect(router.state.matches.length).toBeGreaterThan(0)
    },
  )

  it('/view/:token resolves with the token param', async () => {
    const router = await navigate('/view/my-link-token')
    expect(router.state.location.pathname).toBe('/view/my-link-token')
    const leaf = router.state.matches.at(-1)
    expect(leaf?.params.token).toBe('my-link-token')
  })

  it('/calendar/:sub_token redirects to /view/:sub_token', async () => {
    const router = await navigate('/calendar/my-link-token')
    expect(router.state.location.pathname).toBe('/view/my-link-token')
    expect(router.state.matches.at(-1)?.params.token).toBe('my-link-token')
  })

  it('unknown paths fall through to the not-found route', async () => {
    const router = await navigate('/nope')
    expect(router.state.location.pathname).toBe('/nope')
    expect(router.state.matches.at(-1)?.route.path).toBe('*')
  })
})
