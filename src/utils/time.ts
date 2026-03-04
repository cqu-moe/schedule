export const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

export function formatChinaIso(utcDate: Date): string {
  const china = new Date(utcDate.getTime() + CHINA_TZ_OFFSET_MS);
  const y = china.getUTCFullYear();
  const mo = String(china.getUTCMonth() + 1).padStart(2, "0");
  const d = String(china.getUTCDate()).padStart(2, "0");
  const h = String(china.getUTCHours()).padStart(2, "0");
  const mi = String(china.getUTCMinutes()).padStart(2, "0");
  const s = String(china.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
}

/**
 * Calculate the UTC Date for a course event given term start, week, day, and time string.
 */
export function calculateCourseEventTime(
  termStart: Date,
  week: number,
  dayOfWeek: number,
  timeStr: string,
): Date {
  const daysSinceStart = (week - 1) * 7 + (dayOfWeek - 1);
  const eventDateMs =
    termStart.getTime() + daysSinceStart * 24 * 60 * 60 * 1000;
  const eventDate = new Date(eventDateMs);

  const [h, m, s] = timeStr.split(":").map(Number);

  const chinaMs =
    Date.UTC(
      eventDate.getUTCFullYear(),
      eventDate.getUTCMonth(),
      eventDate.getUTCDate(),
      h,
      m,
      s,
    ) - CHINA_TZ_OFFSET_MS;

  return new Date(chinaMs);
}
