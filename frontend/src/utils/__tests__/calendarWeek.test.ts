import { describe, it, expect } from 'vitest'
import { getSemesterWeek } from '@/utils/calendarWeek'

describe('getSemesterWeek', () => {
  const semesterStart = '2025-09-01' // Monday

  it('returns 1 for the first day of semester', () => {
    expect(getSemesterWeek(new Date('2025-09-01'), semesterStart)).toBe(1)
  })

  it('returns 1 for Sunday of first week', () => {
    expect(getSemesterWeek(new Date('2025-09-07'), semesterStart)).toBe(1)
  })

  it('returns 2 for Monday of second week', () => {
    expect(getSemesterWeek(new Date('2025-09-08'), semesterStart)).toBe(2)
  })

  it('returns 22 for the last valid week', () => {
    // Week 22 starts at day 147 (21*7), which is 2026-01-26
    expect(getSemesterWeek(new Date('2026-01-26'), semesterStart)).toBe(22)
  })

  it('returns null before semester starts', () => {
    expect(getSemesterWeek(new Date('2025-08-31'), semesterStart)).toBeNull()
  })

  it('returns null after week 22', () => {
    // Week 23 starts at day 154, which is 2026-02-02
    expect(getSemesterWeek(new Date('2026-02-02'), semesterStart)).toBeNull()
  })

  it('returns null for empty semesterStart', () => {
    expect(getSemesterWeek(new Date('2025-09-01'), '')).toBeNull()
  })

  it('returns null for invalid semesterStart', () => {
    expect(getSemesterWeek(new Date('2025-09-01'), 'invalid')).toBeNull()
  })

  it('handles mid-week semester start correctly', () => {
    const wedStart = '2025-09-03' // Wednesday
    expect(getSemesterWeek(new Date('2025-09-01'), wedStart)).toBe(1)
    expect(getSemesterWeek(new Date('2025-09-07'), wedStart)).toBe(1)
    expect(getSemesterWeek(new Date('2025-09-08'), wedStart)).toBe(2)
  })
})
