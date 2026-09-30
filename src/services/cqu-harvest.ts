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
  type FullSessionListResponse,
  type ExamListResponse,
} from "./cqu-api";
import type { SessionContext, PersonalScheduleData } from "./sync";

// ── Personal-curriculum harvest recipe ───────────────────────────────────────
//
// Navigating /workspace/curriculum in the user's已登录浏览器 organically fires the
// 课表 POST (my-table-detail) + session-list GET — the only过墙 path for the WRITE
// endpoint (纯 HTTP POST is 412 专守). We capture those auto-fired responses, and
// run the read-豁免 GETs (exam list + semester dates) in the same已过瑞数 context.

const CQU_HARVEST_ORIGIN = "https://my.cqu.edu.cn";
const NAV_URL = `${CQU_HARVEST_ORIGIN}/workspace/curriculum`;
const EXAM_URL = `${CQU_HARVEST_ORIGIN}/api/exam/examTask/get-student-exam-list`;
const FULL_SESSION_URL = `${CQU_HARVEST_ORIGIN}/api/resourceapi/session/list`;

/** KV key prefix + TTL for the per-user harvest dedup cache (see fetchPersonalHarvest). */
// Version the cache by recipe so a deployment cannot reuse a successful payload
// produced through the retired aTrust route during the Direct rollout.
const HARVEST_CACHE_PREFIX = "harvest:direct-v1:";
const HARVEST_CACHE_TTL_SECONDS = 600; // 10 min: long enough to dedupe a sync batch
                                       // where a user's personal subs are processed
                                       // minutes apart, short enough to stay fresh.

/** The cached harvest payload (the user's own schedule data — NOT a secret). */
type CachedHarvest = { ctx: SessionContext; data: PersonalScheduleData };

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

function requireSchedulePayload(value: unknown): ScheduleResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(
      (value as { classTimetableVOList?: unknown }).classTimetableVOList,
    )
  ) {
    throw new HarvestError(
      "harvest timetable body missing classTimetableVOList array",
    );
  }
  return value as ScheduleResponse;
}

function requireExamPayload(value: unknown): ExamListResponse {
  if (typeof value !== "object" || value === null) {
    throw new HarvestError("harvest exam body is not an object");
  }
  const candidate = value as {
    status?: unknown;
    data?: { content?: unknown } | null;
  };
  if (
    candidate.status !== "success" ||
    typeof candidate.data !== "object" ||
    candidate.data === null ||
    !Array.isArray(candidate.data.content)
  ) {
    throw new HarvestError(
      "harvest exam body missing successful data.content array",
    );
  }
  return value as ExamListResponse;
}

/** Find the first harvest entry whose URL contains `needle`. */
function findEntry(entries: HarvestEntry[], needle: string): HarvestEntry | undefined {
  return entries.find((e) => e.url.includes(needle));
}

/** Forward the caller's absolute deadline without extending its budget. */
function withDeadline(
  args: CquHarvestArgs,
  options?: { deadlineAt?: number },
): CquHarvestArgs {
  if (options?.deadlineAt === undefined) return args;
  return { ...args, deadlineAt: options.deadlineAt };
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
 * Fetch exams and the full semester calendar during the same navigation. The
 * captured curSessionId selects its dates after all required bodies arrive.
 */
export function buildPersonalHarvestArgs(env: Env, userId: string): CquHarvestArgs {
  const fetch: HarvestFetchSpec[] = [
    { method: "GET", url: EXAM_URL },
    { method: "GET", url: FULL_SESSION_URL },
  ];
  return {
    clientId: env.CALENDAR_CLIENT_ID,
    clientSecret: env.CALENDAR_CLIENT_SECRET,
    userId,
    navUrl: NAV_URL,
    capture: [CAPTURE_TABLE, CAPTURE_SESSION_LIST],
    fetch,
  };
}

function parseSemesterDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = value.split(" ")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date
    ? date : null;
}

/**
 * Derive a {@link SessionContext} from harvest output.
 *  - sessionId comes from the captured `session/info-detail` body (curSessionId).
 *  - semester dates come from the matching sessionVOList entry in the full list.
 */
export function mapHarvestToSessionContext(
  captures: HarvestEntry[],
  fetches: HarvestEntry[],
): SessionContext {
  // Required capture: a non-2xx (412 challenge / 401 / 5xx) here is a harvest
  // failure, not a legitimately-empty session (which would clobber cached data).
  const listEntry = requireEntry(captures, CAPTURE_SESSION_LIST, "session/info-detail");
  const list = parseEntry<SessionListResponse>(listEntry, { required: true });
  const sessionId = list?.curSessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new HarvestError("harvest missing current semester id");
  }

  const fullListEntry = requireEntry(fetches, FULL_SESSION_URL, "session/list");
  const sessions = parseEntry<FullSessionListResponse>(fullListEntry, { required: true })?.sessionVOList;
  if (!Array.isArray(sessions)) {
    throw new HarvestError("harvest missing sessionVOList array");
  }
  const matching = sessions.filter((session) => session?.id === sessionId);
  if (matching.length !== 1) {
    throw new HarvestError("harvest missing or ambiguous current semester dates");
  }
  const semester = matching[0];
  const beginDate = parseSemesterDate(semester.beginDate);
  const endDate = parseSemesterDate(semester.endDate);
  if (!beginDate || (semester.endDate != null && (!endDate || endDate < beginDate))) {
    throw new HarvestError("harvest missing or invalid semester dates");
  }
  const finderName = Array.isArray(list.sessionFinder)
    ? list.sessionFinder.find((session) => session?.id === sessionId)?.name : undefined;
  return {
    sessionId,
    semesterInfo: {
      id: sessionId,
      name: `${semester.year ?? ""}${semester.term ?? ""}` || finderName || "",
      begin_date: beginDate,
      end_date: endDate,
    },
  };
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
  const courses = parseCourses(
    requireSchedulePayload(parseEntry<unknown>(tableEntry, { required: true })),
  );

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
  const exams = parseExams(
    requireExamPayload(parseEntry<unknown>(examEntry, { required: true })),
  );

  return { courses, exams, semesterStart };
}

/**
 * End-to-end personal harvest: one AUTH.cquHarvest call → typed SessionContext +
 * PersonalScheduleData, including the captured current semester's dates.
 *
 * A user owning multiple personal subs (personal_all + personal_courses +
 * personal_exams) processed close together would otherwise launch ONE expensive
 * browser navigation PER queue message even though the
 * course/exam payload is IDENTICAL for all personal types. A short-lived per-user
 * KV cache ({@link HARVEST_CACHE_PREFIX}+userId, {@link HARVEST_CACHE_TTL_SECONDS})
 * lets subs of the same user reuse ONE harvest. Only SUCCESSFUL harvests are
 * cached (never a {@link HarvestError}/failure — a transient 412/timeout must not
 * be memoized for the whole TTL). The cache is best-effort: a KV get/put failure
 * is caught and the harvest proceeds normally.
 *
 * Throws {@link HarvestError} on `{error}` from auth or missing required bodies,
 * so the queue consumer can ack-without-retry (止血), same as the 412 path.
 */
export async function fetchPersonalHarvest(
  env: Env,
  userId: string,
  options?: { deadlineAt?: number },
): Promise<{ ctx: SessionContext; data: PersonalScheduleData }> {
  if (!env.AUTH?.cquHarvest) {
    throw new HarvestError("AUTH.cquHarvest unavailable");
  }

  // Cache HIT short-circuits the whole harvest (best-effort — a KV get failure is
  // caught and treated as a miss). The cached value is the user's own schedule data
  // (not a secret); do not log it.
  const cacheKey = `${HARVEST_CACHE_PREFIX}${userId}`;
  const cached = await readHarvestCache(env, cacheKey);
  if (cached) return cached;

  // One navigation captures the timetable/current semester and fetches both lists.
  const recipe = buildPersonalHarvestArgs(env, userId);
  const harvest = await env.AUTH.cquHarvest(withDeadline(recipe, options));
  if ("error" in harvest) throw new HarvestError(harvest.error);
  const ctx = mapHarvestToSessionContext(harvest.captures, harvest.fetches);

  // Never materialize or cache a timetable without a usable semester start.
  if (ctx.semesterInfo.begin_date === null) {
    throw new HarvestError("harvest missing semester dates");
  }

  const data = mapHarvestToPersonalData(
    harvest.captures,
    harvest.fetches,
    ctx.semesterInfo.begin_date,
  );
  // SUCCESS only: cache so the same user's other personal subs (processed close
  // together) reuse this harvest. Any failure above threw HarvestError before here,
  // so a transient 412/timeout is never memoized. Best-effort (KV put failure caught).
  const result: CachedHarvest = { ctx, data };
  await writeHarvestCache(env, cacheKey, result);
  return result;
}

/** Best-effort per-user harvest cache read. A KV outage / parse error is swallowed
 *  (returns null → treated as a miss) so the cache can never break the harvest. */
async function readHarvestCache(env: Env, key: string): Promise<CachedHarvest | null> {
  try {
    const raw = await env.CACHE?.get(key);
    return raw ? (JSON.parse(raw) as CachedHarvest) : null;
  } catch {
    return null;
  }
}

/** Best-effort per-user harvest cache write. A KV outage is swallowed so a put
 *  failure can never break the (already-successful) harvest. */
async function writeHarvestCache(env: Env, key: string, value: CachedHarvest): Promise<void> {
  try {
    await env.CACHE?.put(key, JSON.stringify(value), {
      expirationTtl: HARVEST_CACHE_TTL_SECONDS,
    });
  } catch {
    /* best-effort: harvest already succeeded; a cache write failure is non-fatal */
  }
}

/** Best-effort per-user harvest cache clear. Called on ANY subscription delete
 *  (issue #97) so the cached harvest cannot outlive the deletion. Personal subs
 *  are managed (never deletable via the route), so this fires on external
 *  deletes — over-clearing is harmless (worst case one extra harvest within the
 *  10-min dedup window). A KV failure is swallowed: the delete already succeeded. */
export async function clearHarvestCache(env: Env, userId: string): Promise<void> {
  try {
    await env.CACHE?.delete(`${HARVEST_CACHE_PREFIX}${userId}`);
  } catch {
    /* best-effort: never fail a subscription delete on a KV outage */
  }
}
