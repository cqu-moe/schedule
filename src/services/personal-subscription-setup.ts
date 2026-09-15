import { drizzle } from "drizzle-orm/d1";
import { EntitlementError } from "../middleware/entitlements";
import { LINK_FORMATS } from "../db/schema";
import { generateUniqueToken, linkTokenExists } from "../utils/token";
import { resolveQuota, type CalendarCaps } from "./auth-rpc";
import type { CquBindStatus } from "./auth-rpc";
import type { Env } from "../types";
import { personalSubscriptionMode } from "../config/personal-subscription-mode";
import { PERSONAL_VIEWS } from "./personal-subscription-views";

export type DispatchStatus = "pending" | "sending" | "sent" | "failed";

export interface PersonalSetupRow {
  user_id: string;
  status: "created" | "existing";
  subscription_ids: string;
  run_id: string | null;
  dispatch_status: DispatchStatus;
  lease_token: string | null;
  lease_until: number;
  created_at: string;
  updated_at: string;
}

export interface PersonalSetupSummary {
  status: "created" | "existing";
  subscription_ids: string[];
  run_id: string | null;
  dispatch_status: DispatchStatus;
}

export interface DefaultSubscriptionsResponse {
  status: "created" | "resumed" | "existing" | "skipped";
  subscription_ids: string[];
  run_id: string | null;
  dispatch_status: DispatchStatus | "none";
}

export async function getPersonalSetup(
  database: D1Database,
  userId: string,
): Promise<PersonalSetupRow | null> {
  return database
    .prepare("SELECT * FROM personal_subscription_setup WHERE user_id = ?")
    .bind(userId)
    .first<PersonalSetupRow>();
}

export function summarizePersonalSetup(row: PersonalSetupRow): PersonalSetupSummary {
  let subscriptionIds: unknown;
  try {
    subscriptionIds = JSON.parse(row.subscription_ids);
  } catch {
    throw new Error("PERSONAL_SETUP_INVALID_SUBSCRIPTION_IDS");
  }
  if (!Array.isArray(subscriptionIds) || !subscriptionIds.every((id) => typeof id === "string")) {
    throw new Error("PERSONAL_SETUP_INVALID_SUBSCRIPTION_IDS");
  }
  return {
    status: row.status,
    subscription_ids: subscriptionIds,
    run_id: row.run_id,
    dispatch_status: row.dispatch_status,
  };
}

export async function recordExistingSetup(
  database: D1Database,
  userId: string,
): Promise<PersonalSetupRow> {
  const now = new Date().toISOString();
  await database.prepare(`INSERT INTO personal_subscription_setup
    (user_id,status,subscription_ids,dispatch_status,created_at,updated_at)
    VALUES (?,'existing','[]','sent',?,?) ON CONFLICT(user_id) DO NOTHING`)
    .bind(userId, now, now)
    .run();
  const row = await getPersonalSetup(database, userId);
  if (!row) throw new Error("PERSONAL_SETUP_WRITE_FAILED");
  return row;
}

function responseFromRow(row: PersonalSetupRow): DefaultSubscriptionsResponse {
  const summary = summarizePersonalSetup(row);
  return {
    status: summary.status === "created" ? "resumed" : "existing",
    subscription_ids: summary.subscription_ids,
    run_id: summary.run_id,
    dispatch_status: summary.dispatch_status,
  };
}

async function prepareCanonicalDefaultSubscriptions(
  env: Env,
  userId: string,
  caps: CalendarCaps,
  bindingStatus: CquBindStatus | undefined,
): Promise<DefaultSubscriptionsResponse> {
  if (!caps.sync) {
    await env.DB.prepare(`UPDATE subscriptions SET is_active=0,updated_at=?
      WHERE user_id=? AND source_type='personal' AND is_active!=0`)
      .bind(new Date().toISOString(), userId)
      .run();
    return { status: "skipped", subscription_ids: [], run_id: null, dispatch_status: "none" };
  }

  interface CanonicalRow {
    id: string;
    last_synced_at: string | null;
    sync_status: string;
    sync_run_id: string | null;
    sync_error_code: string | null;
    sync_requested_at: string | null;
  }

  let canonical = await env.DB.prepare(`SELECT id,last_synced_at,sync_status,sync_run_id,
    sync_error_code,sync_requested_at FROM subscriptions
    WHERE user_id=? AND source_type='personal' LIMIT 1`)
    .bind(userId)
    .first<CanonicalRow>();

  const now = new Date().toISOString();
  if (!canonical) {
    const canonicalId = crypto.randomUUID();
    const viewRows = await Promise.all(PERSONAL_VIEWS.map(async (definition) => ({
      ...definition,
      id: crypto.randomUUID(),
      linkId: crypto.randomUUID(),
      token: await generateUniqueToken((token) => linkTokenExists(drizzle(env.DB), token)),
    })));
    const runId = bindingStatus === "active" ? crypto.randomUUID() : null;
    const errorCode = bindingStatus === "active"
      ? null
      : bindingStatus === undefined
        ? "CQU_BINDING_STATUS_UNKNOWN"
        : "CQU_BINDING_REQUIRED";
    const errorMessage = errorCode === "CQU_BINDING_STATUS_UNKNOWN"
      ? "暂时无法确认统一认证绑定状态"
      : errorCode === "CQU_BINDING_REQUIRED"
        ? "请先绑定重庆大学统一认证账号"
        : null;

    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO subscriptions
          (id,user_id,source_type,source_id,source_name,is_personal,is_active,
           sync_status,sync_run_id,sync_trigger,sync_requested_at,sync_finished_at,
           sync_error_code,sync_error_message,created_at,updated_at)
          VALUES (?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,?)`)
          .bind(
            canonicalId,
            userId,
            "personal",
            userId,
            "个人课表",
            runId ? "queued" : "error",
            runId,
            runId ? "initial" : null,
            runId ? now : null,
            runId ? null : now,
            errorCode,
            errorMessage,
            now,
            now,
          ),
        ...viewRows.map((row) => env.DB.prepare(`INSERT INTO personal_subscription_views
          (id,subscription_id,source_type,source_name,created_at) VALUES (?,?,?,?,?)`)
          .bind(row.id, canonicalId, row.sourceType, row.sourceName, now)),
        ...viewRows.map((row) => env.DB.prepare(`INSERT INTO calendar_links
          (id,subscription_id,token,formats,personal_view_type,is_default,created_at,updated_at)
          VALUES (?,?,?,?,?,1,?,?)`)
          .bind(
            row.linkId,
            canonicalId,
            row.token,
            JSON.stringify(LINK_FORMATS),
            row.sourceType,
            now,
            now,
          )),
        env.DB.prepare(`INSERT INTO personal_subscription_setup
          (user_id,status,subscription_ids,run_id,dispatch_status,created_at,updated_at)
          VALUES (?,'created',?,?,?, ?,?)
          ON CONFLICT(user_id) DO UPDATE SET status='created',
            subscription_ids=excluded.subscription_ids,
            run_id=excluded.run_id,
            dispatch_status=excluded.dispatch_status,
            lease_token=NULL,lease_until=0,updated_at=excluded.updated_at`)
          .bind(
            userId,
            JSON.stringify(viewRows.map((row) => row.id)),
            runId,
            runId ? "pending" : "sent",
            now,
            now,
          ),
      ]);
    } catch (error) {
      canonical = await env.DB.prepare(`SELECT id,last_synced_at,sync_status,sync_run_id,
        sync_error_code,sync_requested_at FROM subscriptions
        WHERE user_id=? AND source_type='personal' LIMIT 1`)
        .bind(userId)
        .first<CanonicalRow>();
      if (!canonical) throw error;
      return prepareCanonicalDefaultSubscriptions(env, userId, caps, bindingStatus);
    }

    return {
      status: "created",
      subscription_ids: viewRows.map((row) => row.id),
      run_id: runId,
      dispatch_status: runId ? "pending" : "sent",
    };
  }

  await env.DB.prepare(`UPDATE subscriptions SET is_active=1,updated_at=?
    WHERE id=? AND is_active!=1`).bind(now, canonical.id).run();

  const existingViews = await env.DB.prepare(`SELECT id,source_type FROM personal_subscription_views
    WHERE subscription_id=?`).bind(canonical.id).all<{ id: string; source_type: string }>();
  const viewsByType = new Map(existingViews.results.map((view) => [view.source_type, view.id]));
  const resourceStatements: D1PreparedStatement[] = [];
  for (const definition of PERSONAL_VIEWS) {
    if (!viewsByType.has(definition.sourceType)) {
      const viewId = crypto.randomUUID();
      viewsByType.set(definition.sourceType, viewId);
      resourceStatements.push(env.DB.prepare(`INSERT INTO personal_subscription_views
        (id,subscription_id,source_type,source_name,created_at) VALUES (?,?,?,?,?)`)
        .bind(viewId, canonical.id, definition.sourceType, definition.sourceName, now));
    }
    const existingDefault = await env.DB.prepare(`SELECT id FROM calendar_links
      WHERE subscription_id=? AND personal_view_type=? AND is_default=1 LIMIT 1`)
      .bind(canonical.id, definition.sourceType)
      .first<{ id: string }>();
    if (!existingDefault) {
      const token = await generateUniqueToken((candidate) =>
        linkTokenExists(drizzle(env.DB), candidate));
      resourceStatements.push(env.DB.prepare(`INSERT INTO calendar_links
        (id,subscription_id,token,formats,personal_view_type,is_default,created_at,updated_at)
        SELECT ?,?,?,?,?,1,?,? WHERE NOT EXISTS (
          SELECT 1 FROM calendar_links WHERE subscription_id=? AND personal_view_type=? AND is_default=1
        )`).bind(
          crypto.randomUUID(),
          canonical.id,
          token,
          JSON.stringify(LINK_FORMATS),
          definition.sourceType,
          now,
          now,
          canonical.id,
          definition.sourceType,
        ));
    }
  }

  const viewIds = PERSONAL_VIEWS.map((definition) => viewsByType.get(definition.sourceType)!);
  if (resourceStatements.length > 0) await env.DB.batch(resourceStatements);

  const activeCutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const hasActiveRun = (canonical.sync_status === "queued" || canonical.sync_status === "running")
    && canonical.sync_requested_at !== null
    && canonical.sync_requested_at > activeCutoff;
  const recoverableErrors = new Set([
    "CQU_BINDING_REQUIRED",
    "CQU_BINDING_STATUS_UNKNOWN",
    "PERSONAL_SYNC_REQUIRED",
  ]);
  const canStartInitial = bindingStatus === "active"
    && canonical.last_synced_at === null
    && !hasActiveRun
    && (canonical.sync_status === "idle" || recoverableErrors.has(canonical.sync_error_code ?? ""));

  const bindingBlocked = bindingStatus !== "active"
    && canonical.last_synced_at === null
    && !hasActiveRun;
  if (bindingBlocked) {
    const errorCode = bindingStatus === undefined
      ? "CQU_BINDING_STATUS_UNKNOWN"
      : "CQU_BINDING_REQUIRED";
    const errorMessage = bindingStatus === undefined
      ? "暂时无法确认统一认证绑定状态"
      : "请先绑定重庆大学统一认证账号";
    await env.DB.prepare(`UPDATE subscriptions SET sync_status='error',sync_run_id=NULL,
      sync_trigger=NULL,sync_requested_at=NULL,sync_started_at=NULL,sync_finished_at=?,
      sync_error_code=?,sync_error_message=?,session_recovery_attempts=0,updated_at=? WHERE id=?`)
      .bind(now, errorCode, errorMessage, now, canonical.id)
      .run();
  }

  let claimedRunId: string | null = null;
  if (canStartInitial) {
    const runId = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE subscriptions SET sync_status='queued',
      sync_run_id=?,sync_trigger='initial',sync_requested_at=?,sync_started_at=NULL,
      sync_finished_at=NULL,sync_error_code=NULL,sync_error_message=NULL,
      session_recovery_attempts=0,updated_at=?
      WHERE id=? AND last_synced_at IS NULL
        AND (sync_status NOT IN ('queued','running') OR sync_requested_at IS NULL OR sync_requested_at<=?)`)
      .bind(runId, now, now, canonical.id, activeCutoff)
      .run();
    if ((claimed.meta.changes ?? 0) === 1) claimedRunId = runId;
  }

  const current = await getPersonalSetup(env.DB, userId);
  const status = claimedRunId ? "created" : (current?.status ?? "existing");
  const runId = bindingBlocked
    ? null
    : claimedRunId ?? current?.run_id ?? canonical.sync_run_id;
  const dispatchStatus = bindingBlocked
    ? "sent"
    : claimedRunId
    ? "pending"
    : current?.dispatch_status ?? "sent";
  await env.DB.prepare(`INSERT INTO personal_subscription_setup
    (user_id,status,subscription_ids,run_id,dispatch_status,lease_token,lease_until,created_at,updated_at)
    VALUES (?,?,?,?,?,NULL,0,?,?)
    ON CONFLICT(user_id) DO UPDATE SET subscription_ids=excluded.subscription_ids,
      status=CASE WHEN excluded.status='created' THEN 'created' ELSE personal_subscription_setup.status END,
      run_id=CASE WHEN excluded.status='created' THEN excluded.run_id ELSE personal_subscription_setup.run_id END,
      dispatch_status=CASE WHEN excluded.status='created' THEN excluded.dispatch_status ELSE personal_subscription_setup.dispatch_status END,
      lease_token=CASE WHEN excluded.status='created' THEN NULL ELSE personal_subscription_setup.lease_token END,
      lease_until=CASE WHEN excluded.status='created' THEN 0 ELSE personal_subscription_setup.lease_until END,
      updated_at=excluded.updated_at`)
    .bind(userId, status, JSON.stringify(viewIds), runId, dispatchStatus, now, now)
    .run();

  const stored = await getPersonalSetup(env.DB, userId);
  if (!stored) throw new Error("PERSONAL_SETUP_WRITE_FAILED");
  return responseFromRow(stored);
}

async function prepareLegacyDefaultSubscriptions(
  env: Env,
  userId: string,
  caps: CalendarCaps,
): Promise<DefaultSubscriptionsResponse> {
  if (!caps.sync) {
    return {
      status: "skipped",
      subscription_ids: [],
      run_id: null,
      dispatch_status: "none",
    };
  }

  const stored = await getPersonalSetup(env.DB, userId);
  if (stored) return responseFromRow(stored);

  const subscription = await env.DB
    .prepare("SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();
  if (subscription) {
    return responseFromRow(await recordExistingSetup(env.DB, userId));
  }

  if (resolveQuota(caps.sub_limit) < 3) {
    throw new EntitlementError(
      "QUOTA_EXCEEDED",
      409,
      "订阅额度不足，无法准备三个个人订阅",
    );
  }

  const definitions = [
    ["personal_all", "我的全部课表"],
    ["personal_courses", "我的课程"],
    ["personal_exams", "我的考试"],
  ] as const;
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = drizzle(env.DB);
  const rows = await Promise.all(definitions.map(async ([type, name]) => ({
    id: crypto.randomUUID(),
    linkId: crypto.randomUUID(),
    type,
    name,
    token: await generateUniqueToken((token) => linkTokenExists(db, token)),
  })));
  const ids = rows.map((row) => row.id);

  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO personal_subscription_setup
        (user_id,status,subscription_ids,run_id,dispatch_status,created_at,updated_at)
        VALUES (?,'created',?,?,'pending',?,?)`)
        .bind(userId, JSON.stringify(ids), runId, now, now),
      ...rows.map((row) => env.DB.prepare(`INSERT INTO subscriptions
        (id,user_id,source_type,source_id,source_name,is_personal,is_active,
         sync_status,sync_run_id,sync_trigger,sync_requested_at,created_at,updated_at)
        VALUES (?,?,?,?,?,1,1,'queued',?,'initial',?,?,?)`)
        .bind(row.id, userId, row.type, userId, row.name, runId, now, now, now)),
      ...rows.map((row) => env.DB.prepare(`INSERT INTO calendar_links
        (id,subscription_id,token,formats,is_default,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`)
        .bind(row.linkId, row.id, row.token, JSON.stringify(LINK_FORMATS), now, now)),
    ]);
  } catch (error) {
    const winner = await getPersonalSetup(env.DB, userId);
    if (winner) return responseFromRow(winner);
    throw error;
  }

  return {
    status: "created",
    subscription_ids: ids,
    run_id: runId,
    dispatch_status: "pending",
  };
}

export async function prepareDefaultSubscriptions(
  env: Env,
  userId: string,
  caps: CalendarCaps,
  bindingStatus?: CquBindStatus,
): Promise<DefaultSubscriptionsResponse> {
  const mode = personalSubscriptionMode(env);
  if (mode === "migration") {
    throw new EntitlementError(
      "PERSONAL_SUBSCRIPTION_MIGRATING",
      503,
      "个人课表正在维护，请稍后重试",
    );
  }
  if (mode === "enabled") {
    return prepareCanonicalDefaultSubscriptions(env, userId, caps, bindingStatus);
  }
  return prepareLegacyDefaultSubscriptions(env, userId, caps);
}
