import type { Env } from "../types";
import {
  LINK_FORMATS,
  PERSONAL_VIEW_TYPES,
  type PersonalViewType,
} from "../db/schema";
import { personalSubscriptionMode } from "../config/personal-subscription-mode";
import { PERSONAL_VIEWS } from "./personal-subscription-views";
import { generateUniqueToken, linkTokenExists } from "../utils/token";
import { drizzle } from "drizzle-orm/d1";
import { buildPersonalSyncResult, preGenerateIcs } from "./sync";
import type { CourseEntry, ExamEntry } from "./cqu-api";

export type MigrationSummary = {
  users: number;
  legacyRows: number;
  createdViews: number;
  preservedLinks: number;
  createdDefaultLinks: number;
  incompleteSnapshots: number;
  duplicateDefaults: number;
};

export type MigrationVerification = {
  legacy_rows: number;
  missing_views: number;
  missing_defaults: number;
  missing_tokens: number;
  orphan_views: number;
  orphan_links: number;
  duplicate_personal: number;
  foreign_key_violations: number;
};

export type MigrationRunResult = {
  summary: MigrationSummary;
  next_cursor: string | null;
  complete: boolean;
  verification?: MigrationVerification;
};

const EMPTY_SUMMARY: MigrationSummary = {
  users: 0,
  legacyRows: 0,
  createdViews: 0,
  preservedLinks: 0,
  createdDefaultLinks: 0,
  incompleteSnapshots: 0,
  duplicateDefaults: 0,
};

interface LegacyRow {
  id: string;
  user_id: string;
  source_type: PersonalViewType;
  source_id: string;
  source_name: string;
  session_id: string | null;
  session_name: string | null;
  semester_start: string | null;
  ics_content: string | null;
  courses_json: string | null;
  exams_json: string | null;
  last_synced_at: string | null;
  manual_refresh_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyLink {
  id: string;
  subscription_id: string;
  token: string;
  label: string | null;
  formats: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function addSummary(target: MigrationSummary, source: MigrationSummary): void {
  for (const key of Object.keys(target) as Array<keyof MigrationSummary>) {
    target[key] += source[key];
  }
}

function termKey(row: LegacyRow): string {
  return row.semester_start || row.session_id || row.session_name || `row:${row.id}`;
}

function parseArray<T>(raw: string | null, field: string, rowId: string): T[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as T[];
  } catch {
    throw new Error(`PERSONAL_MIGRATION_CORRUPTED_${field}:${rowId}`);
  }
}

function selectSnapshot(rows: LegacyRow[]): {
  courses: CourseEntry[] | null;
  exams: ExamEntry[] | null;
  anchor: LegacyRow;
  complete: boolean;
  lastSyncedAt: string | null;
} {
  const survivor = [...rows].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  const candidates = rows
    .filter((row) => row.last_synced_at)
    .sort((a, b) =>
      b.last_synced_at!.localeCompare(a.last_synced_at!) || b.updated_at.localeCompare(a.updated_at));
  const anchor = candidates[0] ?? survivor;
  const sameTerm = candidates.filter((row) => termKey(row) === termKey(anchor));

  let courses: CourseEntry[] | null = null;
  let exams: ExamEntry[] | null = null;
  let coursesAt: string | null = null;
  let examsAt: string | null = null;
  for (const row of sameTerm) {
    if (courses === null && row.source_type !== "personal_exams") {
      const parsed = parseArray<CourseEntry>(row.courses_json, "COURSES", row.id);
      if (parsed !== null) {
        courses = parsed;
        coursesAt = row.last_synced_at;
      }
    }
    if (exams === null && row.source_type !== "personal_courses") {
      const parsed = (row.source_type === "personal_all" || row.source_type === "personal_exams")
        && row.exams_json === null
        ? []
        : parseArray<ExamEntry>(row.exams_json, "EXAMS", row.id);
      if (parsed !== null) {
        exams = parsed;
        examsAt = row.last_synced_at;
      }
    }
  }
  const complete = courses !== null && exams !== null;
  const lastSyncedAt = complete && coursesAt && examsAt
    ? (coursesAt < examsAt ? coursesAt : examsAt)
    : null;
  return { courses, exams, anchor, complete, lastSyncedAt };
}

async function loadLegacyUser(database: D1Database, userId: string) {
  const rows = await database.prepare(`SELECT * FROM subscriptions WHERE user_id=?
    AND source_type IN ('personal_all','personal_courses','personal_exams')
    ORDER BY created_at,id`).bind(userId).all<LegacyRow>();
  const ids = rows.results.map((row) => row.id);
  if (ids.length === 0) return { rows: [], links: [], setup: null };
  const placeholders = ids.map(() => "?").join(",");
  const links = await database.prepare(`SELECT * FROM calendar_links
    WHERE subscription_id IN (${placeholders}) ORDER BY created_at,id`)
    .bind(...ids)
    .all<LegacyLink>();
  const setup = await database.prepare(`SELECT * FROM personal_subscription_setup WHERE user_id=?`)
    .bind(userId)
    .first<Record<string, unknown>>();
  return { rows: rows.results, links: links.results, setup };
}

export async function migratePersonalUser(
  env: Env,
  userId: string,
  apply: boolean,
): Promise<MigrationSummary> {
  const loaded = await loadLegacyUser(env.DB, userId);
  if (loaded.rows.length === 0) return { ...EMPTY_SUMMARY };
  const snapshot = selectSnapshot(loaded.rows);
  const byType = new Map(loaded.rows.map((row) => [row.source_type, row]));
  const survivor = byType.get("personal_all") ?? [...loaded.rows].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  const linksByType = new Map<PersonalViewType, LegacyLink[]>();
  for (const row of loaded.rows) {
    linksByType.set(
      row.source_type,
      loaded.links.filter((link) => link.subscription_id === row.id),
    );
  }
  const duplicateDefaults = [...linksByType.values()].reduce((count, links) =>
    count + Math.max(0, links.filter((link) => link.is_default === 1).length - 1), 0);
  const createdDefaultLinks = PERSONAL_VIEW_TYPES.filter((type) =>
    !(linksByType.get(type) ?? []).some((link) => link.is_default === 1)).length;
  const summary: MigrationSummary = {
    users: 1,
    legacyRows: loaded.rows.length,
    createdViews: 3,
    preservedLinks: loaded.links.length,
    createdDefaultLinks,
    incompleteSnapshots: snapshot.complete ? 0 : 1,
    duplicateDefaults,
  };
  if (!apply) return summary;
  if (personalSubscriptionMode(env) !== "migration") {
    throw new Error("PERSONAL_MIGRATION_MODE_REQUIRED");
  }

  const now = new Date().toISOString();
  const viewIds = new Map<PersonalViewType, string>();
  for (const definition of PERSONAL_VIEWS) {
    viewIds.set(definition.sourceType, byType.get(definition.sourceType)?.id ?? crypto.randomUUID());
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO personal_subscription_migration_backups
      (user_id,subscriptions_json,links_json,setup_json,migrated_at) VALUES (?,?,?,?,?)`)
      .bind(
        userId,
        JSON.stringify(loaded.rows),
        JSON.stringify(loaded.links),
        loaded.setup ? JSON.stringify(loaded.setup) : null,
        now,
      ),
  ];

  for (const definition of PERSONAL_VIEWS) {
    statements.push(env.DB.prepare(`INSERT INTO personal_subscription_views
      (id,subscription_id,source_type,source_name,created_at) VALUES (?,?,?,?,?)`)
      .bind(
        viewIds.get(definition.sourceType)!,
        survivor.id,
        definition.sourceType,
        byType.get(definition.sourceType)?.source_name ?? definition.sourceName,
        byType.get(definition.sourceType)?.created_at ?? now,
      ));
    const links = linksByType.get(definition.sourceType) ?? [];
    const defaults = links.filter((link) => link.is_default === 1);
    const keepDefault = defaults[0]?.id ?? null;
    for (const link of links) {
      statements.push(env.DB.prepare(`UPDATE calendar_links SET subscription_id=?,
        personal_view_type=?,is_default=?,updated_at=? WHERE id=?`)
        .bind(
          survivor.id,
          definition.sourceType,
          link.is_default === 1 && link.id !== keepDefault ? 0 : link.is_default,
          now,
          link.id,
        ));
    }
    if (!keepDefault) {
      const token = await generateUniqueToken((candidate) =>
        linkTokenExists(drizzle(env.DB), candidate));
      statements.push(env.DB.prepare(`INSERT INTO calendar_links
        (id,subscription_id,token,formats,personal_view_type,is_default,created_at,updated_at)
        VALUES (?,?,?,?,?,1,?,?)`)
        .bind(
          crypto.randomUUID(),
          survivor.id,
          token,
          JSON.stringify(LINK_FORMATS),
          definition.sourceType,
          now,
          now,
        ));
    }
  }

  for (const row of loaded.rows) {
    if (row.id !== survivor.id) {
      statements.push(env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(row.id));
    }
  }
  const courses = snapshot.courses ?? [];
  const exams = snapshot.exams ?? [];
  const semesterStart = snapshot.anchor.semester_start ?? "";
  const generated = buildPersonalSyncResult(
    "personal",
    { courses, exams, semesterStart },
    preGenerateIcs({ courses, exams, semesterStart }, userId),
  );
  const manualRefreshAt = loaded.rows
    .map((row) => row.manual_refresh_at)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  statements.push(env.DB.prepare(`UPDATE subscriptions SET source_type='personal',source_id=?,
    source_name='个人课表',is_personal=1,session_id=?,session_name=?,semester_start=?,
    ics_content=?,courses_json=?,exams_json=?,last_synced_at=?,manual_refresh_at=?,
    sync_status=?,sync_run_id=NULL,sync_trigger=NULL,sync_requested_at=NULL,
    sync_started_at=NULL,sync_finished_at=?,sync_error_code=?,sync_error_message=?,updated_at=?
    WHERE id=? AND user_id=?`)
    .bind(
      userId,
      snapshot.anchor.session_id,
      snapshot.anchor.session_name,
      semesterStart,
      generated.icsContent,
      snapshot.courses === null ? null : JSON.stringify(courses),
      snapshot.exams === null ? null : JSON.stringify(exams),
      snapshot.lastSyncedAt,
      manualRefreshAt,
      snapshot.complete ? "success" : "error",
      now,
      snapshot.complete ? null : "PERSONAL_SYNC_REQUIRED",
      snapshot.complete ? null : "个人课表需要重新同步",
      now,
      survivor.id,
      userId,
    ));
  statements.push(env.DB.prepare(`INSERT INTO personal_subscription_setup
    (user_id,status,subscription_ids,run_id,dispatch_status,lease_token,lease_until,created_at,updated_at)
    VALUES (?,'existing',?,NULL,'sent',NULL,0,?,?)
    ON CONFLICT(user_id) DO UPDATE SET status='existing',subscription_ids=excluded.subscription_ids,
      run_id=NULL,dispatch_status='sent',lease_token=NULL,lease_until=0,updated_at=excluded.updated_at`)
    .bind(
      userId,
      JSON.stringify(PERSONAL_VIEW_TYPES.map((type) => viewIds.get(type)!)),
      loaded.setup && typeof loaded.setup.created_at === "string" ? loaded.setup.created_at : now,
      now,
    ));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const completed = await env.DB.prepare(`SELECT s.id,
      (SELECT count(*) FROM personal_subscription_views v WHERE v.subscription_id=s.id) AS views
      FROM subscriptions s WHERE s.user_id=? AND s.source_type='personal' LIMIT 1`)
      .bind(userId)
      .first<{ id: string; views: number }>();
    const legacy = await env.DB.prepare(`SELECT count(*) AS count FROM subscriptions
      WHERE user_id=? AND source_type IN ('personal_all','personal_courses','personal_exams')`)
      .bind(userId)
      .first<{ count: number }>();
    if (completed?.views === 3 && Number(legacy?.count ?? 0) === 0) {
      return { ...EMPTY_SUMMARY };
    }
    throw error;
  }
  return summary;
}

async function verifyMigration(database: D1Database): Promise<MigrationVerification> {
  const count = async (sql: string) => Number((await database.prepare(sql)
    .first<{ count: number }>())?.count ?? 0);
  const legacyRows = await count(`SELECT count(*) AS count FROM subscriptions
    WHERE source_type IN ('personal_all','personal_courses','personal_exams')`);
  const missingViews = await count(`SELECT count(*) AS count FROM subscriptions s
    WHERE s.source_type='personal' AND
      (SELECT count(*) FROM personal_subscription_views v WHERE v.subscription_id=s.id)!=3`);
  const missingDefaults = await count(`SELECT count(*) AS count FROM personal_subscription_views v
    WHERE (SELECT count(*) FROM calendar_links l WHERE l.subscription_id=v.subscription_id
      AND l.personal_view_type=v.source_type AND l.is_default=1)!=1`);
  const orphanViews = await count(`SELECT count(*) AS count FROM personal_subscription_views v
    LEFT JOIN subscriptions s ON s.id=v.subscription_id WHERE s.id IS NULL`);
  const orphanLinks = await count(`SELECT count(*) AS count FROM calendar_links l
    LEFT JOIN subscriptions s ON s.id=l.subscription_id WHERE s.id IS NULL`);
  const duplicatePersonal = await count(`SELECT count(*) AS count FROM (
    SELECT user_id FROM subscriptions WHERE source_type='personal'
    GROUP BY user_id HAVING count(*)>1)`);
  const backups = await database.prepare(`SELECT links_json FROM personal_subscription_migration_backups`)
    .all<{ links_json: string }>();
  const tokens = await database.prepare(`SELECT token FROM calendar_links`).all<{ token: string }>();
  const currentTokens = new Set(tokens.results.map((row) => row.token));
  let missingTokens = 0;
  for (const backup of backups.results) {
    const links = JSON.parse(backup.links_json) as LegacyLink[];
    missingTokens += links.filter((link) => !currentTokens.has(link.token)).length;
  }
  const foreignKeys = await database.prepare("PRAGMA foreign_key_check").all();
  return {
    legacy_rows: legacyRows,
    missing_views: missingViews,
    missing_defaults: missingDefaults,
    missing_tokens: missingTokens,
    orphan_views: orphanViews,
    orphan_links: orphanLinks,
    duplicate_personal: duplicatePersonal,
    foreign_key_violations: foreignKeys.results.length,
  };
}

export async function runPersonalMigration(
  env: Env,
  input: { mode: "dry_run" | "apply" | "verify"; after_user_id: string | null; limit: number },
): Promise<MigrationRunResult> {
  if (input.mode === "verify") {
    const verification = await verifyMigration(env.DB);
    return {
      summary: { ...EMPTY_SUMMARY },
      next_cursor: null,
      complete: Object.values(verification).every((value) => value === 0),
      verification,
    };
  }
  if (input.mode === "apply" && personalSubscriptionMode(env) !== "migration") {
    throw new Error("PERSONAL_MIGRATION_MODE_REQUIRED");
  }
  const users = await env.DB.prepare(`SELECT DISTINCT user_id FROM subscriptions
    WHERE source_type IN ('personal_all','personal_courses','personal_exams') AND user_id>?
    ORDER BY user_id LIMIT ?`)
    .bind(input.after_user_id ?? "", input.limit + 1)
    .all<{ user_id: string }>();
  const page = users.results.slice(0, input.limit);
  const summary = { ...EMPTY_SUMMARY };
  for (const row of page) {
    addSummary(summary, await migratePersonalUser(env, row.user_id, input.mode === "apply"));
  }
  const hasMore = users.results.length > input.limit;
  return {
    summary,
    next_cursor: hasMore ? page.at(-1)?.user_id ?? null : null,
    complete: !hasMore,
  };
}
