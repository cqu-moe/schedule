import { describe, it, expect } from 'vitest'
import { buildLinkUrl } from '@/utils/links'

describe('buildLinkUrl', () => {
  const BASE = 'https://schedule.cqu.moe'
  const TOKEN = 'abc123xyz'

  it('builds ics URL', () => {
    expect(buildLinkUrl(BASE, TOKEN, 'ics')).toBe(
      `${BASE}/api/v2/calendar/${TOKEN}/calendar.ics`,
    )
  })

  it('builds origin_json URL', () => {
    expect(buildLinkUrl(BASE, TOKEN, 'origin_json')).toBe(
      `${BASE}/api/v2/calendar/${TOKEN}/origin.json`,
    )
  })

  it('builds data_json URL', () => {
    expect(buildLinkUrl(BASE, TOKEN, 'data_json')).toBe(
      `${BASE}/api/v2/calendar/${TOKEN}/data.json`,
    )
  })

  it('builds csv URL', () => {
    expect(buildLinkUrl(BASE, TOKEN, 'csv')).toBe(
      `${BASE}/api/v2/calendar/${TOKEN}/data.csv`,
    )
  })

  it('builds web URL', () => {
    expect(buildLinkUrl(BASE, TOKEN, 'web')).toBe(`${BASE}/view/${TOKEN}`)
  })

  it('strips trailing slash from publicUrl', () => {
    expect(buildLinkUrl(`${BASE}/`, TOKEN, 'ics')).toBe(
      `${BASE}/api/v2/calendar/${TOKEN}/calendar.ics`,
    )
  })

  it('strips multiple trailing slashes from publicUrl', () => {
    expect(buildLinkUrl(`${BASE}///`, TOKEN, 'web')).toBe(`${BASE}/view/${TOKEN}`)
  })

  it('handles token with special chars unchanged', () => {
    const tok = 'tok-A1_B2'
    expect(buildLinkUrl(BASE, tok, 'csv')).toBe(
      `${BASE}/api/v2/calendar/${tok}/data.csv`,
    )
  })
})
