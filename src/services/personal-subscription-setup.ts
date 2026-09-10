import { drizzle } from "drizzle-orm/d1";
import { EntitlementError } from "../middleware/entitlements";
import { LINK_FORMATS } from "../db/schema";
import { generateUniqueToken, linkTokenExists } from "../utils/token";
import { resolveQuota, type CalendarCaps } from "./auth-rpc";
import type { Env } from "../types";

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

export async function prepareDefaultSubscriptions(
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
