export function getSemesterWeek(date: Date, semesterStart: string): number | null {
  if (!semesterStart) return null
  const termStart = new Date(semesterStart + 'T00:00:00Z')
  if (isNaN(termStart.getTime())) return null

  // FullCalendar's named-zone dates use UTC-coerced wall time.
  const day = termStart.getUTCDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const monday = new Date(termStart)
  monday.setUTCDate(monday.getUTCDate() + mondayOffset)

  const diffMs = date.getTime() - monday.getTime()
  if (diffMs < 0) return null

  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1
  return week >= 1 && week <= 22 ? week : null
}
