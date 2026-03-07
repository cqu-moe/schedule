export function getSemesterWeek(date: Date, semesterStart: string): number | null {
  if (!semesterStart) return null
  const termStart = new Date(semesterStart + 'T00:00:00Z')
  if (isNaN(termStart.getTime())) return null

  // Align to Monday of the semester start week
  const day = termStart.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const monday = new Date(termStart)
  monday.setDate(monday.getDate() + mondayOffset)

  const diffMs = date.getTime() - monday.getTime()
  if (diffMs < 0) return null

  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1
  return week >= 1 && week <= 22 ? week : null
}
