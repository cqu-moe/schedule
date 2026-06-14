import { LINK_FORMATS, type LinkFormat } from "../db/schema";

const LINK_FORMAT_SET: ReadonlySet<string> = new Set<string>(LINK_FORMATS);

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
