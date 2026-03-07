# Calendar Week Number Display Design

## Goal

在日历视图中显示当前是该学期第几周。

## Design

### Week Calculation

纯函数 `getSemesterWeek(date: Date, semesterStart: string): number | null`:
- 计算 `date` 相对于 `semesterStart` 周一的天数差，`Math.floor(diff / 7) + 1`
- 返回 1-22 范围内的周数，范围外返回 `null`
- `semesterStart` 为空/无效时返回 `null`

### Month View: Per-row Week Numbers

- 启用 `weekNumbers: true`
- 自定义 `weekNumberContent` 回调，调用 `getSemesterWeek()` 返回周数文本（如 "W12"）
- 范围外返回空内容，不显示

### Day/Week View: Toolbar Title Append

- `datesSet` 回调中获取当前视图日期范围
- 周视图取周一、日视图取当天，计算学期周数
- DOM 查找 `.fc-toolbar-title`，在日期文本后追加 ` · 第X周`
- 范围外不追加

### Data Flow

- `CalendarData.semester_start` 已由 API 返回（YYYY-MM-DD 格式）
- `Calendar.vue` 的 `onMounted` 中保存到 ref，供计算使用

## Scope

- 仅修改 `frontend/src/views/Calendar.vue`
- 无后端/API 改动
