import type { Env } from "../types";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";
import type { ExternalSearchArgs, ExternalSearchResult, ExternalDepartment } from "./external-search";
import { DIRECTORY_CATALOGS, parseDirectoryResult, type DirectoryItem, type DirectoryRecipe } from "./external-directory-contract";

const WEEK = 7 * 24 * 60 * 60_000;
const LEASE = 2 * 60_000;
const MAX_RUN_AGE = 5 * 24 * 60 * 60_000;
// Teaching-class harvesting is deferred to #152; the weekly run publishes only
// the department plus the four interactive core catalogs.
const CORE_DIRECTORY_CATALOGS = DIRECTORY_CATALOGS.filter(sourceType => sourceType !== "teaching_class");
const CATALOG_PHASE = CORE_DIRECTORY_CATALOGS.length;
const sourceOwner = (env: Env) => env.EXTERNAL_DIRECTORY_USER_ID?.trim() ?? "";
interface Run {
  id: string; owner_id: string; status: string; phase: number;
  session_id: string | null; session_name: string | null; departments_json: string | null;
  started_at: number; next_attempt_at: number; failure_count: number;
}
const jitter = () => 60 + Math.floor(Math.random() * 61);
const fence = "EXISTS (SELECT 1 FROM external_directory_runs r JOIN external_directory_state s ON s.active_run_id=r.id WHERE r.id=? AND r.lease_token=? AND r.status='running' AND r.lease_until>?)";

async function enqueueRun(env: Env, id: string): Promise<void> {
  const now = Date.now();
  const run = await env.DB.prepare(`UPDATE external_directory_runs SET dispatch_until=MAX(next_attempt_at,?)+900000
    WHERE id=? AND status='running' AND dispatch_until<=? AND lease_until<=?
      AND EXISTS (SELECT 1 FROM external_directory_state WHERE active_run_id=?) RETURNING *`)
    .bind(now, id, now, now, id).first<Run>();
  if (!run) return;
  const delaySeconds = Math.max(0, Math.min(43_200, Math.ceil((run.next_attempt_at - now) / 1000)));
  try {
    await env.SCHEDULE_SYNC_QUEUE.send({ purpose: "external_directory", subscriptionId: "directory", userId: run.owner_id, runId: run.id, trigger: "cron" }, { delaySeconds });
  } catch {
    // Cron recovers a failed or lost enqueue; the durable cursor is authoritative.
    await env.DB.prepare("UPDATE external_directory_runs SET dispatch_until=0 WHERE id=? AND lease_token IS NULL").bind(id).run();
  }
}

/** Weekly scheduler, and recovery of interrupted Queue deliveries. Disabled until
 * the operator configures the explicitly consenting source account. */
export async function scheduleExternalDirectory(env: Env): Promise<void> {
  const owner = sourceOwner(env);
  if (!owner || !env.AUTH.cquExternalDirectory) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE external_directory_runs SET status='failed',finished_at=?,last_error='RUN_EXPIRED',lease_token=NULL,lease_until=0
      WHERE status='running' AND (owner_id<>? OR started_at<?)`).bind(now, owner, now - MAX_RUN_AGE),
    env.DB.prepare(`UPDATE external_directory_state SET active_run_id=NULL,next_due_at=?
      WHERE active_run_id IN (SELECT id FROM external_directory_runs WHERE status='failed')`).bind(now + 15 * 60_000),
  ]);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO external_directory_runs (id,owner_id,started_at,next_attempt_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM external_directory_state WHERE id=1 AND active_run_id IS NULL AND next_due_at<=?)`)
      .bind(id, owner, now, now + jitter() * 1000, now),
    env.DB.prepare(`UPDATE external_directory_state SET active_run_id=? WHERE id=1 AND active_run_id IS NULL
      AND EXISTS (SELECT 1 FROM external_directory_runs WHERE id=?)`).bind(id, id),
    env.DB.prepare(`DELETE FROM external_directory_runs WHERE started_at<?
      AND id NOT IN (SELECT COALESCE(active_run_id,'') FROM external_directory_state
        UNION SELECT COALESCE(catalog_run_id,'') FROM external_directory_state)`)
      .bind(now - 2 * WEEK),
    env.DB.prepare("DELETE FROM external_directory_course_cache WHERE expires_at<?").bind(now),
  ]);
  const state = await env.DB.prepare("SELECT active_run_id FROM external_directory_state WHERE id=1").first<{ active_run_id: string | null }>();
  if (state?.active_run_id) await enqueueRun(env, state.active_run_id);
}

function stageItems(env: Env, runId: string, lease: string, kind: string, rows: DirectoryItem[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += 250) {
    statements.push(env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name,extra,department_id,grade,course_code)
      SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.extra'),
        COALESCE(json_extract(value,'$.departmentId'),''),COALESCE(json_extract(value,'$.grade'),''),COALESCE(json_extract(value,'$.courseCode'),'')
      FROM json_each(?) WHERE ${fence}
      ON CONFLICT(run_id,kind,id) DO UPDATE SET name=excluded.name,extra=excluded.extra,department_id=excluded.department_id,
        grade=excluded.grade,course_code=excluded.course_code`)
      .bind(runId, kind, JSON.stringify(rows.slice(offset, offset + 250)), runId, lease, Date.now()));
  }
  return statements;
}

async function deferRun(env: Env, run: Run, lease: string, seconds: number, code?: string): Promise<void> {
  await env.DB.prepare(`UPDATE external_directory_runs SET next_attempt_at=?,dispatch_until=0,lease_token=NULL,lease_until=0,
    failure_count=failure_count+?,last_error=? WHERE id=? AND lease_token=? AND status='running'`)
    .bind(Date.now() + seconds * 1000, code ? 1 : 0, code ?? null, run.id, lease).run();
  await enqueueRun(env, run.id);
}

async function failRun(env: Env, run: Run, lease: string, code: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE external_directory_runs SET status='failed',finished_at=?,last_error=?,lease_token=NULL,lease_until=0
      WHERE id=? AND lease_token=?`).bind(now, code, run.id, lease),
    env.DB.prepare(`UPDATE external_directory_state SET active_run_id=NULL,next_due_at=? WHERE active_run_id=?
      AND EXISTS (SELECT 1 FROM external_directory_runs WHERE id=? AND status='failed')`)
      .bind(now + (code === "CURRENT_SESSION_CHANGED" ? 15 * 60_000 : 6 * 60 * 60_000), run.id, run.id),
  ]);
}

/** Each message owns at most one bounded school batch. Progress, publication and
 * the next delay are persisted together; duplicate messages cannot skip a step. */
export async function processExternalDirectory(env: Env, message: Message<ScheduleSyncMessage>, foregroundInBatch = false): Promise<void> {
  const { runId, userId } = message.body;
  if (!runId || !sourceOwner(env) || userId !== sourceOwner(env) || !env.AUTH.cquExternalDirectory) { message.ack(); return; }
  const now = Date.now(), lease = crypto.randomUUID();
  const run = await env.DB.prepare(`UPDATE external_directory_runs SET lease_token=?,lease_until=?,dispatch_until=0
    WHERE id=? AND owner_id=? AND status='running' AND next_attempt_at<=? AND lease_until<=?
      AND EXISTS (SELECT 1 FROM external_directory_state WHERE active_run_id=?) RETURNING *`)
    .bind(lease, now + LEASE, runId, userId, now, now, runId).first<Run>();
  if (!run) { message.ack(); return; }
  try {
    if (now - run.started_at > MAX_RUN_AGE) { await failRun(env, run, lease, "RUN_EXPIRED"); message.ack(); return; }
    const observed = await env.DB.prepare("SELECT observed_session_id FROM external_directory_state WHERE id=1").first<{ observed_session_id: string | null }>();
    if (run.session_id && observed?.observed_session_id && run.session_id !== observed.observed_session_id) {
      await failRun(env, run, lease, "CURRENT_SESSION_CHANGED"); message.ack(); return;
    }
    if (run.phase >= CATALOG_PHASE) {
      await failRun(env, run, lease, "TEACHER_CRAWL_CANCELLED"); message.ack(); return;
    }
    const busy = await env.DB.prepare(`SELECT 1 AS busy FROM external_directory_state WHERE foreground_until>?
      UNION ALL SELECT 1 FROM subscriptions WHERE user_id=? AND
        (sync_status='running' OR (sync_status='queued' AND datetime(updated_at)>datetime(?))) LIMIT 1`)
      .bind(now, userId, new Date(now - 2 * 60 * 60_000).toISOString()).first();
    if (foregroundInBatch || busy) { await deferRun(env, run, lease, 120 + jitter()); message.ack(); return; }
    const recipe: DirectoryRecipe = { kind: "catalog", sourceType: CORE_DIRECTORY_CATALOGS[run.phase], ...(run.session_id ? { expectedSessionId: run.session_id } : {}) };
    const raw = await env.AUTH.cquExternalDirectory({ ...recipe, userId, clientId: env.CALENDAR_CLIENT_ID,
      clientSecret: env.CALENDAR_CLIENT_SECRET, deadlineAt: now + 90_000 });
    if ("error" in raw) {
      const fatal = ["CURRENT_SESSION_CHANGED", "FORBIDDEN", "NO_CQU_BINDING", "CQU_SESSION_INACTIVE", "TGT_EXPIRED", "SESSION_INACTIVE"].includes(raw.error);
      if (fatal) await failRun(env, run, lease, raw.error);
      else await deferRun(env, run, lease, Math.min(1800, 120 * 2 ** Math.min(run.failure_count, 4)) + jitter(), "SCHOOL_UNAVAILABLE");
      message.ack(); return;
    }
    const result = parseDirectoryResult(raw, recipe);
    if (!result) throw new Error("SCHEMA_INVALID");
    const finished = Date.now(), statements: D1PreparedStatement[] = [];
    if (result.kind === "catalog") {
      statements.push(...stageItems(env, runId, lease, result.sourceType, result.items ?? []));
      statements.push(env.DB.prepare(`UPDATE external_directory_runs SET phase=phase+1,session_id=?,session_name=?,
        departments_json=COALESCE(?,departments_json) WHERE id=? AND lease_token=? AND lease_until>?`)
        .bind(result.session.id, result.session.name, result.departments ? JSON.stringify(result.departments) : null, runId, lease, finished));
    }
    statements.push(
      env.DB.prepare(`UPDATE external_directory_state SET observed_session_id=?,observed_at=? WHERE id=1 AND observed_at<=? AND ${fence}`)
        .bind(result.session.id, now, now, runId, lease, finished),
    );
    if (run.phase + 1 === CATALOG_PHASE) {
      statements.push(
        env.DB.prepare(`UPDATE external_directory_runs SET status='complete',finished_at=? WHERE id=? AND lease_token=? AND lease_until>?
          AND phase=? AND departments_json IS NOT NULL
          AND EXISTS (SELECT 1 FROM external_directory_state WHERE active_run_id=? AND observed_session_id=external_directory_runs.session_id)
          AND EXISTS (SELECT 1 FROM external_directory_items WHERE run_id=? AND kind IN ('room','laboratory','admin_class','course_catalog')
            GROUP BY run_id HAVING COUNT(DISTINCT kind)=4)`)
          .bind(finished, runId, lease, finished, CATALOG_PHASE, runId, runId),
        env.DB.prepare(`UPDATE external_directory_state SET catalog_run_id=?,active_run_id=NULL,next_due_at=?
          WHERE active_run_id=? AND observed_session_id=? AND EXISTS (SELECT 1 FROM external_directory_runs WHERE id=? AND status='complete' AND lease_token=?)`)
          .bind(runId, Math.max(finished, run.started_at + WEEK), runId, result.session.id, runId, lease),
      );
    }
    statements.push(env.DB.prepare(`UPDATE external_directory_runs SET lease_token=NULL,lease_until=0,dispatch_until=0,next_attempt_at=?,failure_count=0,last_error=NULL
      WHERE id=? AND lease_token=?`).bind(finished + jitter() * 1000, runId, lease));
    await env.DB.batch(statements);
    await enqueueRun(env, runId);
    message.ack();
  } catch {
    // Also covers malformed replies and D1 failure. No incomplete generation is
    // made visible, and a crashed lease is recoverable by the periodic producer.
    await deferRun(env, run, lease, Math.min(1800, 120 * 2 ** Math.min(run.failure_count, 4)) + jitter(), "BATCH_FAILED");
    message.ack();
  }
}

export async function markDirectoryForeground(env: Env, userId: string): Promise<void> {
  if (!sourceOwner(env) || userId !== sourceOwner(env)) return;
  await env.DB.prepare("UPDATE external_directory_state SET foreground_until=MAX(foreground_until,?) WHERE id=1")
    .bind(Date.now() + 120_000).run();
}

export async function observeDirectorySession(env: Env, id: string, requestedAt: number): Promise<void> {
  if (!sourceOwner(env)) return;
  await env.DB.prepare("UPDATE external_directory_state SET observed_session_id=?,observed_at=? WHERE id=1 AND observed_at<=?")
    .bind(id, requestedAt, requestedAt).run();
}

export async function directorySessionMatches(env: Env, id: string): Promise<boolean> {
  if (!sourceOwner(env)) return true;
  const row = await env.DB.prepare("SELECT observed_session_id FROM external_directory_state WHERE id=1").first<{ observed_session_id: string | null }>();
  return !row?.observed_session_id || row.observed_session_id === id;
}

/** Must be called only after the requesting user's live capability/binding gates. */
export async function lookupDirectory(env: Env, userId: string, input: Omit<ExternalSearchArgs, "clientId" | "clientSecret" | "userId">): Promise<ExternalSearchResult | null> {
  if (!sourceOwner(env)) return null;
  const current = await env.DB.prepare("SELECT observed_session_id FROM external_directory_state WHERE id=1").first<{ observed_session_id: string | null }>();
  if (input.expectedSessionId && current?.observed_session_id && current.observed_session_id !== input.expectedSessionId) return null;
  if (input.sourceType === "course") {
    if (!input.expectedSessionId || !input.courseId) return null;
    const row = await env.DB.prepare(`SELECT result_json FROM external_directory_course_cache WHERE user_id=? AND session_id=? AND course_id=? AND expires_at>?`)
      .bind(userId, input.expectedSessionId, input.courseId, Date.now()).first<{ result_json: string }>();
    if (!row) return null;
    const result = JSON.parse(row.result_json) as ExternalSearchResult;
    return result.sourceType === "course" && result.course.id === input.courseId && result.course.name === input.courseName && result.session.id === input.expectedSessionId ? result : null;
  }
  if (input.sourceType === "instructor") return null;
  const run = await env.DB.prepare(`SELECT r.* FROM external_directory_runs r JOIN external_directory_state s ON s.catalog_run_id=r.id
    WHERE r.status='complete' AND r.phase>=${CATALOG_PHASE} AND r.session_id=s.observed_session_id`).first<Run>();
  if (!run?.session_id || !run.session_name) return null;
  const session = { id: run.session_id, name: run.session_name };
  if (input.sourceType === "department") {
    return run.departments_json ? { contractVersion: 1, sourceType: "department", session, departments: JSON.parse(run.departments_json) as ExternalDepartment[] } : null;
  }
  // instr() treats %, _ and backslashes as literal user input, unlike LIKE.
  const keyword = (input.keyword ?? "").trim().toLowerCase();
  const rows = await env.DB.prepare(`SELECT id,name,extra FROM external_directory_items WHERE run_id=? AND kind=?
    AND (?='' OR instr(lower(name),?)>0 OR instr(lower(extra),?)>0)
    AND (?='' OR department_id=?) AND (?='' OR grade=?) ORDER BY name,id LIMIT 201`)
    .bind(run.id, input.sourceType, keyword, keyword, keyword, input.departmentId ?? "", input.departmentId ?? "", input.grade ?? "", input.grade ?? "")
    .all<{ id: string; name: string; extra: string }>();
  if (!rows.results.length) return null;
  return { contractVersion: 1, sourceType: input.sourceType, session, items: rows.results.slice(0, 200), truncated: rows.results.length > 200 };
}

export async function cacheDirectoryCourse(env: Env, userId: string, result: ExternalSearchResult): Promise<void> {
  if (!sourceOwner(env) || result.sourceType !== "course") return;
  await env.DB.prepare(`INSERT INTO external_directory_course_cache (user_id,session_id,course_id,result_json,expires_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,session_id,course_id) DO UPDATE SET result_json=excluded.result_json,expires_at=excluded.expires_at`)
    .bind(userId, result.session.id, result.course.id, JSON.stringify(result), Date.now() + WEEK).run();
}
