import type { Env } from "../types";
import type {
  CquHarvestArgs,
  HarvestEntry,
  HarvestFetchSpec,
} from "./auth-rpc";
import {
  parseCourses,
  parseExams,
  type ScheduleResponse,
  type SessionListResponse,
  type SessionDetailResponse,
  type ExamListResponse,
  type SemesterInfo,
} from "./cqu-api";
import type { SessionContext, PersonalScheduleData } from "./sync";

// ── Personal-curriculum harvest recipe ───────────────────────────────────────
//
// Navigating /workspace/curriculum in the user's已登录浏览器 organically fires the
// 课表 POST (my-table-detail) + session-list GET — the only过墙 path for the WRITE
// endpoint (纯 HTTP POST is 412 专守). We capture those auto-fired responses, and
// run the read-豁免 GETs (exam list + semester dates) in the same已过瑞数 context.

const NAV_URL = "https://my.cqu.edu.cn/workspace/curriculum";
const EXAM_URL = "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list";
const SESSION_INFO_URL = "https://my.cqu.edu.cn/api/resourceapi/session/info/";

/** URL substrings to capture from the navigation's auto-fired responses. */
const CAPTURE_TABLE = "my-table-detail";
const CAPTURE_SESSION_LIST = "session/info-detail";

/** Error thrown when a harvest result is missing a required body. Callers in
 *  schedule-sync treat this like a WAF/transient failure (ack, no retry). */
export class HarvestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarvestError";
  }
}

/** Find the first harvest entry whose URL contains `needle`. */
function findEntry(entries: HarvestEntry[], needle: string): HarvestEntry | undefined {
  return entries.find((e) => e.url.includes(needle));
}

/** True for any non-2xx HTTP status (the harvest captured an error/challenge body). */
function isNon2xx(status: number): boolean {
  return status < 200 || status >= 300;
}

/**
 * Resolve a REQUIRED harvest entry by URL substring, rejecting both absence AND a
 * non-2xx status. A non-2xx required capture means the harvest browser recorded a
 * challenge/error response (e.g. a 412 瑞数 challenge HTML or 401/5xx error JSON)
 * instead of the real 课表/session body. Parsing that would either throw on
 * JSON.parse or yield EMPTY courses/exams — and applying that empty result as a
 * "successful" sync would WIPE the user's cached data. Treat it as a harvest
 * failure so the consumer acks-without-retry and leaves the existing data intact.
 */
function requireEntry(
  entries: HarvestEntry[],
  needle: string,
  label: string,
): HarvestEntry {
  const found = findEntry(entries, needle);
  if (!found) {
    throw new HarvestError(`harvest missing ${label} capture`);
  }
  if (isNon2xx(found.status)) {
    throw new HarvestError(`harvest ${label} capture returned non-2xx status ${found.status}`);
  }
  return found;
}

/**
 * Centralized entry-body parse — the ONE place a harvest entry body becomes JSON.
 * Guards every path against two failure modes a `JSON.parse` would otherwise let
 * slip through as the WRONG kind of error:
 *
 *  1. Non-2xx status — the harvest captured a challenge/error body (a 412 瑞数
 *     challenge HTML, a 401/5xx error). Parsing it would either throw a plain
 *     SyntaxError (on HTML) or yield EMPTY data (on `{}`-ish error JSON).
 *  2. Unparseable 2xx body — a truncated/HTML body from a proxy hiccup. A raw
 *     `JSON.parse` throws a plain `SyntaxError`.
 *
 * For a REQUIRED entry either mode throws {@link HarvestError} so the queue
 * consumer acks-without-retry (止血) instead of treating a SyntaxError as a
 * GENERIC failure and RETRYING. For an OPTIONAL entry either mode returns `null`
 * so the caller degrades (e.g. empty exams) without failing the whole harvest.
 *
 * Pre-resolved (non-null) entries only — absence of a REQUIRED capture is handled
 * by {@link requireEntry} before this is called.
 */
function parseEntry<T>(entry: HarvestEntry, opts: { required: true }): T;
function parseEntry<T>(entry: HarvestEntry, opts: { required: false }): T | null;
function parseEntry<T>(entry: HarvestEntry, opts: { required: boolean }): T | null {
  if (isNon2xx(entry.status)) {
    if (opts.required) {
      throw new HarvestError(
        `harvest entry ${entry.url} returned non-2xx status ${entry.status}`,
      );
    }
    return null;
  }
  try {
    return JSON.parse(entry.body) as T;
  } catch (e) {
    if (opts.required) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new HarvestError(`harvest entry ${entry.url} body is not valid JSON: ${reason}`);
    }
    return null;
  }
}

/**
 * Build the personal-schedule harvest recipe. Pure — does not call AUTH. The
 * semester-dates GET is appended later (in {@link fetchPersonalHarvest}) once
 * curSessionId is known; here we only request the always-known exam list.
 */
export function buildPersonalHarvestArgs(env: Env, userId: string): CquHarvestArgs {
  const fetch: HarvestFetchSpec[] = [{ method: "GET", url: EXAM_URL }];
  return {
    clientId: env.CALENDAR_CLIENT_ID,
    clientSecret: env.CALENDAR_CLIENT_SECRET,
    userId,
    navUrl: NAV_URL,
    capture: [CAPTURE_TABLE, CAPTURE_SESSION_LIST],
    fetch,
  };
}

/**
 * Derive a {@link SessionContext} from harvest output.
 *  - sessionId comes from the captured `session/info-detail` body (curSessionId).
 *  - semester dates come from a `session/info/{id}` in-page GET (read豁免), whose
 *    shape matches the existing {@link SessionDetailResponse} exactly.
 */
export function mapHarvestToSessionContext(
  captures: HarvestEntry[],
  fetches: HarvestEntry[],
): SessionContext {
  // Required capture: a non-2xx (412 challenge / 401 / 5xx) here is a harvest
  // failure, not a legitimately-empty session (which would clobber cached data).
  const listEntry = requireEntry(captures, CAPTURE_SESSION_LIST, "session/info-detail");
  const list = parseEntry<SessionListResponse>(listEntry, { required: true });
  const sessionId = list.curSessionId ?? "";

  // Match curSessionId's display name from the finder list (best-effort).
  const finderName = (list.sessionFinder ?? []).find((s) => s?.id === sessionId)?.name;

  const detailEntry = findEntry(fetches, `session/info/${sessionId}`)
    ?? findEntry(fetches, "session/info/");
  let semesterInfo: SemesterInfo;
  if (detailEntry) {
    // REQUIRED when present: a non-2xx (412 challenge / 401 / 5xx) or unparseable
    // semester-detail body must surface as a HarvestError (ack-no-retry), NOT a raw
    // SyntaxError from JSON.parse-ing challenge HTML (which the consumer would treat
    // as a generic failure and RETRY mid-WAF).
    const detail = parseEntry<SessionDetailResponse>(detailEntry, { required: true }).data ?? {};
    const beginDate = detail.beginDate ?? "";
    const endDate = detail.endDate ?? "";
    semesterInfo = {
      id: detail.id ?? sessionId ?? null,
      name: `${detail.year ?? ""}${detail.term ?? ""}` || finderName || "",
      begin_date: beginDate ? beginDate.split(" ")[0] : null,
      end_date: endDate ? endDate.split(" ")[0] : null,
    };
  } else {
    // No semester-detail fetch (e.g. recipe without dates yet): degrade to a
    // name-only context; begin_date null → ICS uses no semester offset.
    semesterInfo = { id: sessionId || null, name: finderName ?? "", begin_date: null, end_date: null };
  }

  return { sessionId, semesterInfo };
}

/**
 * Build a {@link PersonalScheduleData} from harvest output, reusing the SHARED
 * pure parsers so course/exam parsing is byte-identical to the old client path.
 */
export function mapHarvestToPersonalData(
  captures: HarvestEntry[],
  fetches: HarvestEntry[],
  semesterStart: string,
): PersonalScheduleData {
  // Required capture: reject absence AND non-2xx (412 challenge / 401 / 5xx). An
  // error body parses to EMPTY courses, and applying that empty result as a
  // "successful" sync would WIPE the user's cached 课表 — so fail the harvest.
  const tableEntry = requireEntry(captures, CAPTURE_TABLE, "my-table-detail");
  const courses = parseCourses(parseEntry<ScheduleResponse>(tableEntry, { required: true }));

  // The exam fetch is REQUIRED (round-5 [P2 DATA LOSS] fix). buildPersonalHarvestArgs
  // ALWAYS requests the exam URL, so an ABSENT exam entry means the fetch was
  // DROPPED/timed-out — NOT a legitimately-empty exam list. Earlier this degraded
  // absence to exams=[], but applying that as a "successful" sync ERASES a
  // previously-valid exam calendar (personal_exams / the exam slice of personal_all).
  // requireEntry rejects BOTH absence AND a non-2xx (412 瑞数 challenge / 401 / 5xx)
  // status with HarvestError, and parseEntry's `required: true` additionally rejects a
  // 2xx-but-unparseable body → the consumer acks-without-retry and leaves the cached
  // exams intact. A genuine empty exam list arrives as a real 2xx body with
  // {data:{content:[]}}, which parses to exams=[] without throwing.
  const examEntry = requireEntry(fetches, "get-student-exam-list", "get-student-exam-list");
  const exams = parseExams(parseEntry<ExamListResponse>(examEntry, { required: true }));

  return { courses, exams, semesterStart };
}

/**
 * End-to-end personal harvest: one AUTH.cquHarvest call → typed SessionContext +
 * PersonalScheduleData. Does the two-phase semester-date fetch by re-using the
 * captured curSessionId.
 *
 * Throws {@link HarvestError} on `{error}` from auth or missing required bodies,
 * so the queue consumer can ack-without-retry (止血), same as the 412 path.
 */
export async function fetchPersonalHarvest(
  env: Env,
  userId: string,
): Promise<{ ctx: SessionContext; data: PersonalScheduleData }> {
  if (!env.AUTH?.cquHarvest) {
    throw new HarvestError("AUTH.cquHarvest unavailable");
  }

  // Phase 1: navigate + capture 课表/session-list + fetch exam list.
  const recipe = buildPersonalHarvestArgs(env, userId);
  const r1 = await env.AUTH.cquHarvest(recipe);
  if ("error" in r1) throw new HarvestError(r1.error);

  const ctxPartial = mapHarvestToSessionContext(r1.captures, r1.fetches);

  // Phase 2: if we have a sessionId but no semester dates yet, fetch them
  // (read豁免 GET) in a second harvest call so begin_date is populated.
  let ctx = ctxPartial;
  if (ctxPartial.sessionId && ctxPartial.semesterInfo.begin_date === null) {
    const r2 = await env.AUTH.cquHarvest({
      clientId: env.CALENDAR_CLIENT_ID,
      clientSecret: env.CALENDAR_CLIENT_SECRET,
      userId,
      navUrl: NAV_URL,
      capture: [CAPTURE_SESSION_LIST],
      fetch: [{ method: "GET", url: `${SESSION_INFO_URL}${ctxPartial.sessionId}` }],
    });
    if (!("error" in r2)) {
      ctx = mapHarvestToSessionContext(r1.captures, [...r1.fetches, ...r2.fetches]);
    }
  }

  // 止血 invariant: never return data without a real semester begin_date. If
  // Phase 2 errored (transient timeout/WAF/reauth) or returned no usable
  // session/info, begin_date stays null → the consumer's ICS would use
  // semesterStart="" (new Date("") is Invalid) → courses can't be dated → an
  // empty/broken ICS would OVERWRITE the user's previously-valid calendar while
  // marking it synced. Treat missing dates as a harvest failure so the consumer
  // acks WITHOUT retry and leaves the existing calendar untouched.
  if (ctx.semesterInfo.begin_date === null) {
    throw new HarvestError("harvest missing semester dates");
  }

  const data = mapHarvestToPersonalData(
    r1.captures,
    r1.fetches,
    ctx.semesterInfo.begin_date ?? "",
  );
  return { ctx, data };
}
