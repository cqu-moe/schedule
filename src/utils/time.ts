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
