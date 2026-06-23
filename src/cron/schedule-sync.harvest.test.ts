import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { subscriptions } from "../db/schema";
import { processScheduleSyncBatch, type ScheduleSyncMessage } from "./schedule-sync";
import * as harvestModule from "../services/cqu-harvest";
import { HarvestError } from "../services/cqu-harvest";
import type { Env } from "../types";

const db = drizzle(env.DB);

const FULL_CAPS = {
  sync: true, external: true, share: true,
  sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
};

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();
  await env.DB.prepare(
    `CREATE TABLE subscriptions (
      id text PRIMARY KEY NOT NULL, user_id text NOT NULL, source_type text NOT NULL,
      source_id text NOT NULL, source_name text NOT NULL, session_id text, session_name text,
      semester_start text, is_personal integer NOT NULL DEFAULT 0, is_active integer NOT NULL DEFAULT 1,
      ics_content text, courses_json text, exams_json text, last_synced_at text,
      created_at text NOT NULL, updated_at text NOT NULL
    )`,
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM subscriptions").run();
  await env.CACHE.put("caps:user-1", JSON.stringify(FULL_CAPS));
});

afterEach(() => vi.restoreAllMocks());

async function insertSub(overrides: Partial<typeof subscriptions.$inferInsert> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(subscriptions).values({
    id, userId: "user-1", sourceType: "personal_all", sourceId: "user-1",
    sourceName: "我的课表", createdAt: now, updatedAt: now, ...overrides,
  });
  return id;
}

function makeBatch(bodies: ScheduleSyncMessage[]) {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  return { batch: { queue: "schedule-sync", messages } as unknown as MessageBatch<ScheduleSyncMessage>, messages };
}

describe("processScheduleSyncBatch — organic harvest personal path", () => {
  it("syncs a personal sub via fetchPersonalHarvest (no bearer)", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(harvest).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.coursesJson).toBe("[]");
    expect(row.icsContent).toContain("BEGIN:VCALENDAR");
    expect(row.sessionName).toBe("2025秋");
  });

  it("acks WITHOUT retry on a HarvestError (止血: WAF/会话失效/超时)", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(
      new HarvestError("CQU_WAF_BLOCKED"),
    );

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull(); // not synced
  });

  it("retries on a generic (non-harvest) error", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new Error("boom"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].retry).toHaveBeenCalled();
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("acks-skips an external sub (软禁用: 冻结,不删数据,不取数)", async () => {
    const sid = await insertSub({ sourceType: "instructor", sourceId: "T-42", isPersonal: false });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull(); // frozen, not synced, not deleted
  });
});
