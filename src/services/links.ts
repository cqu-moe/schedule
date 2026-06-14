import { LINK_FORMATS, type LinkFormat } from "../db/schema";

const LINK_FORMAT_SET: ReadonlySet<string> = new Set<string>(LINK_FORMATS);

/** Default resource path for a calendar link when no explicit format is given. */
const DEFAULT_CALENDAR_PATH = "calendar.ics";

/** Map a {@link LinkFormat} to its public resource path under a token. */
const FORMAT_PATHS: Record<LinkFormat, string> = {
  ics: "calendar.ics",
  origin_json: "origin.json",
  data_json: "data.json",
  csv: "data.csv",
  web: "view.json",
};

/**
 * Build the canonical public URL for a calendar link.
 *
 * Single source of truth for the `/api/v2/calendar/<token>/<resource>` URL
 * shape, shared by the rotation endpoint and any other URL emitter. Returns
 * `null` when `publicUrl` is falsy so callers can omit the field.
 *
 * @param publicUrl - configured `PUBLIC_URL` (trailing slash tolerated)
 * @param token - the link token
 * @param format - optional {@link LinkFormat}; defaults to the `.ics` path
 */
export function buildCalendarUrl(
  publicUrl: string | undefined,
  token: string,
  format?: LinkFormat,
): string | null {
  if (!publicUrl) return null;
  const base = publicUrl.replace(/\/$/, "");
  const path = format ? FORMAT_PATHS[format] : DEFAULT_CALENDAR_PATH;
  return `${base}/api/v2/calendar/${token}/${path}`;
}

/**
 * Validate and normalize a client-supplied formats value into a `LinkFormat[]`.
 *
 * Accepts only a non-empty array whose elements are all known {@link LINK_FORMATS}.
 * Duplicates are removed (order of first occurrence preserved).
 *
 * @throws {Error} "INVALID_FORMATS" if `raw` is not an array, is empty, or
 *   contains any value outside {@link LINK_FORMATS}.
 */
export function parseFormats(raw: unknown): LinkFormat[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("INVALID_FORMATS");
  }
  const seen = new Set<string>(raw as unknown[] as string[]);
  for (const f of seen) {
    if (!LINK_FORMAT_SET.has(f)) {
      throw new Error("INVALID_FORMATS");
    }
  }
  return [...seen] as LinkFormat[];
}

/**
 * Return whether a stored formats JSON array (TEXT column) permits `fmt`.
 * Malformed JSON or non-array content yields `false` (deny by default).
 */
export function linkAllows(formatsJson: string, fmt: LinkFormat): boolean {
  try {
    const parsed = JSON.parse(formatsJson) as unknown;
    return Array.isArray(parsed) && parsed.includes(fmt);
  } catch {
    return false;
  }
}
