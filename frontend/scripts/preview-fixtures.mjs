// Local-only UI acceptance fixtures. Never imported by the application or bundled.
// Run alongside Vite; use /view/preview, /view/empty, /view/missing, /view/forbidden.
import { createServer } from 'node:http'
const publicUrl = 'http://127.0.0.1:5178'
let scenario = 'ready'
let notificationEnabled = true
const timestamp = '2026-10-12T01:00:00Z'
const formats = ['ics', 'web', 'data_json', 'origin_json', 'csv']
const subscriptions = ['我的全部课表', '我的课程', '我的考试'].map((source_name, index) => ({
  id: `preview-${index}`,
  user_id: 'preview-user',
  source_name,
  source_type: ['personal_all', 'personal_courses', 'personal_exams'][index],
  source_id: 'preview-user',
  session_id: 'preview-semester',
  session_name: '2026 秋季学期',
  semester_start: '2026-09-07',
  is_personal: true,
  last_synced_at: timestamp,
  sync_status: 'success',
  sync_run_id: null,
  sync_trigger: 'cron',
  sync_requested_at: null,
  sync_started_at: null,
  sync_finished_at: timestamp,
  sync_error_code: null,
  sync_error_message: null,
  manual_refresh_at: null,
  created_at: timestamp,
  updated_at: timestamp,
  links: [{ id: `link-${index}`, token: 'preview', label: null, formats, is_default: true }],
}))
const events = [
  ['多元微积分', '2026-10-12T08:30:00+08:00', '2026-10-12T10:10:00+08:00', 'D1234', 'course'],
  ['大学物理', '2026-10-12T14:00:00+08:00', '2026-10-12T15:40:00+08:00', 'D1456', 'course'],
  [
    '程序设计实验',
    '2026-10-13T10:30:00+08:00',
    '2026-10-13T12:10:00+08:00',
    '计算机实验室',
    'course',
  ],
  ['英语阶段测试', '2026-10-15T08:30:00+08:00', '2026-10-15T10:10:00+08:00', 'D1330', 'exam'],
].map(([name, start_time, end_time, location, type]) => ({
  name,
  start_time,
  end_time,
  location,
  type,
  instructor: '示例教师',
  day_of_week: 1,
  week: 6,
}))
createServer(async (req, res) => {
  const path = new URL(req.url, publicUrl).pathname
  const send = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  const error = (code, message, http = 503) => send({ detail: { error: { code, message } } }, http)
  if (path === '/__scenario' && req.method === 'PUT') {
    let body = ''
    for await (const chunk of req) body += chunk
    scenario = JSON.parse(body).scenario
    return send({ scenario })
  }
  if (path === '/api/v2/config') return send({ public_url: publicUrl })
  if (path === '/api/v2/me')
    return scenario === 'guest'
      ? error('UNAUTHORIZED', '未登录', 401)
      : send({
          user: {
            id: 'preview-user',
            name: '预览用户',
            email: 'preview@example.invalid',
            role: 'student',
          },
          cquBindStatus: 'active',
          caps: {
            calendar: {
              sync: true,
              external: false,
              share: true,
              change_notification: true,
              sub_limit: 5,
              share_limit: 10,
              sync_interval: 3600,
              manual_refresh: 5,
            },
          },
        })
  if (path === '/api/v2/subscriptions/defaults')
    return send({ status: 'existing', subscription_ids: subscriptions.map((s) => s.id) })
  if (path === '/api/v2/subscriptions')
    return scenario === 'error'
      ? error('UNAVAILABLE', '服务暂时不可用')
      : send({
          subscriptions: scenario === 'empty' ? [] : subscriptions,
          count: scenario === 'empty' ? 0 : subscriptions.length,
        })
  if (path === '/api/v2/notification-settings') {
    if (req.method === 'PUT') {
      let body = ''
      for await (const chunk of req) body += chunk
      notificationEnabled = JSON.parse(body).enabled
    }
    return scenario === 'error'
      ? error('UNAVAILABLE', '保存失败')
      : send({ eligible: true, enabled: notificationEnabled })
  }
  if (path.endsWith('/view.json')) {
    if (path.includes('/missing/')) return error('NOT_FOUND', '链接不存在', 404)
    if (path.includes('/forbidden/')) return error('FORMAT_NOT_ALLOWED', '未开启网页查看', 403)
    if (scenario === 'error') return error('UNAVAILABLE', '加载课表数据失败')
    return send({
      semester: '2026秋',
      semester_start: '2026-09-07',
      generated_at: timestamp,
      events: path.includes('/empty/') ? [] : events,
    })
  }
  const sub = subscriptions.find((s) => path === `/api/v2/subscriptions/${s.id}/links`)
  if (sub) return send({ links: sub.links, count: sub.links.length })
  return error('NOT_FOUND', '未实现的预览接口', 404)
}).listen(8787, '127.0.0.1', () =>
  console.log('Local UI fixtures: http://127.0.0.1:8787 (not a real backend)'),
)
