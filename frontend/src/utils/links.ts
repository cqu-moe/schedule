import type { LinkFormat } from '@/types/api'

const SUFFIX: Record<LinkFormat, string> = {
  ics: '/api/v2/calendar/{t}/calendar.ics',
  origin_json: '/api/v2/calendar/{t}/origin.json',
  data_json: '/api/v2/calendar/{t}/data.json',
  csv: '/api/v2/calendar/{t}/data.csv',
  web: '/view/{t}',
}

/**
 * Build a public URL for a calendar link token + format.
 *
 * @example
 *   buildLinkUrl('https://schedule.cqu.moe', 'abc123', 'ics')
 *   // → 'https://schedule.cqu.moe/api/v2/calendar/abc123/calendar.ics'
 *
 *   buildLinkUrl('https://schedule.cqu.moe/', 'abc123', 'web')
 *   // → 'https://schedule.cqu.moe/view/abc123'
 */
export function buildLinkUrl(
  publicUrl: string,
  token: string,
  format: LinkFormat,
): string {
  const base = publicUrl.replace(/\/+$/, '')
  const path = SUFFIX[format].replace('{t}', token)
  return `${base}${path}`
}
