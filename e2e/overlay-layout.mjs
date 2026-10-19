// Layout-only browser regression: real UI/CSS, synthetic API data, no backend writes.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../frontend/', import.meta.url))
const output = fileURLToPath(new URL('../.e2e/overlay-layout/', import.meta.url))
const quick = process.argv.includes('--quick')
const links = [{ id: 'default', token: 'synthetic-token', label: null, formats: ['ics', 'web'], is_default: true }]
const subscriptions = ['我的全部课表', '我的课程', '我的考试', '测试班级'].map((source_name, i) => ({
  id: `sub-${i}`, user_id: 'fixture-user', source_type: ['personal_all', 'personal_courses', 'personal_exams', 'admin_class'][i],
  source_id: 'fixture', source_name, is_personal: i < 3, is_active: true,
  session_id: '2026-fall', session_name: '2026秋', semester_start: '2026-09-01',
  last_synced_at: '2026-10-19T02:00:00Z', sync_status: 'success', sync_run_id: null,
  sync_trigger: null, sync_requested_at: null, sync_started_at: null, sync_finished_at: null,
  sync_error_code: null, sync_error_message: null, manual_refresh_at: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-19T02:00:00Z', links,
}))

async function checkLayout(browser, origin, { width, theme, reducedMotion, hiddenScrollbars }) {
  const label = `${width}-${theme}-${reducedMotion}-${hiddenScrollbars ? 'hidden' : 'visible'}`
  const context = await browser.newContext({
    viewport: { width, height: 956 }, colorScheme: theme, reducedMotion,
  })
  try {
    const page = await context.newPage()
    const unexpected = []
    const responses = {
      '/api/v2/config': { public_url: origin },
      '/api/v2/me': { user: { id: 'fixture-user', name: '测试用户', email: 'fixture@example.invalid', role: 'student' }, cquBindStatus: 'active', caps: { calendar: { sync: true, external: true, share: true, change_notification: true, sub_limit: 5, share_limit: 10, sync_interval: 300, manual_refresh: 5, external_sync_interval: 300, external_manual_refresh: 5 } } },
      '/api/v2/subscriptions': { subscriptions, count: subscriptions.length, personal_setup: null, manual_remaining: 5 },
      '/api/v2/notification-settings': { eligible: true, enabled: false },
    }
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(origin).origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (route.request().method() !== 'GET' || !(url.pathname in responses)) {
        unexpected.push(`${route.request().method()} ${url.pathname}`)
        return route.abort()
      }
      await route.fulfill({ json: responses[url.pathname] })
    })
    await page.goto(`${origin}dashboard`)
    const qr = page.getByRole('button', { name: '我的全部课表二维码', exact: true })
    const more = page.getByRole('button', { name: '我的全部课表的更多操作', exact: true })
    await qr.waitFor()
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme)
    if (!hiddenScrollbars) {
      assert.ok(await page.evaluate(() => innerWidth > document.documentElement.clientWidth),
        `${label}: visible scrollbar required to exercise compensation`)
    }
    await page.evaluate(() => {
      // Sample every animation frame, including menu -> dialog handoff and exits.
      window.overlayLayoutSamples = []
      const selectors = ['.page-body', '.page-body h1', '.site-brand', '.dash-list > li']
      function sample() {
        window.overlayLayoutSamples.push(selectors.map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect()
          return [rect.x, rect.width]
        }).flat())
        window.overlayLayoutFrame = requestAnimationFrame(sample)
      }
      sample()
    })
    // Observe beyond the design system's 180ms enter / 140ms exit animations.
    const settle = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
    const shot = name => page.screenshot({ path: `${output}/${label}-${name}.png` })
    await settle()
    await qr.click()
    await page.getByRole('dialog', { name: '扫码订阅' }).waitFor()
    await settle()
    await shot('qr')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '扫码订阅' }).waitFor({ state: 'hidden' })
    await settle()
    assert.equal(await qr.evaluate(element => element === document.activeElement), true, `${label}: QR focus restored`)
    await more.click()
    await page.getByRole('menu').waitFor()
    await settle()
    await shot('menu')
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    await settle()
    assert.equal(await more.evaluate(element => element === document.activeElement), true, `${label}: menu focus restored`)
    await more.press('Enter')
    await page.getByRole('menuitem', { name: '管理共享链接' }).click()
    await page.getByRole('dialog', { name: '管理共享链接' }).waitFor()
    await settle()
    await shot('share')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '管理共享链接' }).waitFor({ state: 'hidden' })
    await settle()
    assert.equal(await more.evaluate(element => element === document.activeElement), true, `${label}: share focus restored`)
    assert.equal(await page.evaluate(() => document.body.hasAttribute('data-scroll-locked')), false, `${label}: scroll unlocked`)
    const samples = await page.evaluate(() => {
      cancelAnimationFrame(window.overlayLayoutFrame)
      return window.overlayLayoutSamples
    })
    const shift = Math.max(...samples[0].map((_, i) => {
      const values = samples.map(sample => sample[i])
      return Math.max(...values) - Math.min(...values)
    }))
    assert.deepEqual(unexpected, [], `${label}: unexpected API calls`)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: page overflow`)
    console.log(`${label}: maximum horizontal layout change ${shift}px`)
    assert.ok(shift <= 1, `${label}: opening schedule options shifts page geometry by ${shift}px`)
  } finally {
    await context.close()
  }
}

await mkdir(output, { recursive: true })
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  for (const hiddenScrollbars of quick ? [false] : [false, true]) {
    // Playwright hides scrollbars by default, which masks #162 entirely.
    const browser = await chromium.launch({ headless: true,
      ignoreDefaultArgs: hiddenScrollbars ? [] : ['--hide-scrollbars'],
      args: hiddenScrollbars ? [] : ['--disable-features=OverlayScrollbar'],
    })
    try {
      const cases = quick
        ? [{ width: 1472, theme: 'light', reducedMotion: 'no-preference' }]
        : hiddenScrollbars
          ? [390, 1440].map(width => ({ width, theme: 'light', reducedMotion: 'no-preference' }))
          : [320, 390, 768, 1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme, reducedMotion: 'no-preference' })))
            .concat([{ width: 1472, theme: 'light', reducedMotion: 'reduce' }])
      for (const config of cases) await checkLayout(browser, origin, { ...config, hiddenScrollbars })
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
