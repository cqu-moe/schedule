import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { Hono } from "hono";
import { businessIdentity } from "../../test-utils/business-identity";
import type { SessionEnv } from "../../middleware/session";
import type { Env } from "../../types";
import { resetPersonalData } from "../../../tests/fixtures/personal-subscriptions";
import external from "./external";
import subscriptions from "./subscriptions";
import calendar from "./calendar";
import { processScheduleSyncBatch } from "../../cron/schedule-sync";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => resetPersonalData(env.DB));

const sources = [{ type: "instructor", target: "teacher-b", name: "同名教师", extra: "学院乙 · T002", owner: { instructorIdList: ["teacher-b", "teacher-c"] } }, { type: "room", target: "room-b", name: "同名教室", extra: "虎溪 · 一教101", owner: { roomId: "room-b" } }, { type: "laboratory", target: "lab-b", name: "实验室乙", extra: "虎溪 · 实验楼201", owner: { roomId: "lab-b", exprProjectName: "电路实验项目" } }] as const;

describe.each(sources)("new $type source", ({ type, target, name, extra, owner }) => {
  function harness() {
    const userId = crypto.randomUUID();
    const caps = { sync: true, external: true, share: true, sub_limit: 5, share_limit: 5, sync_interval: 60, manual_refresh: 5, change_notification: false };
    const send = vi.fn().mockResolvedValue(undefined);
    const search = vi.fn().mockResolvedValue({ contractVersion: 1, sourceType: type,
      session: { id: "current", name: "当前学期" }, truncated: false,
      items: [{ id: "same-name-other", name, extra: "学院甲 · T001" }, { id: target, name, extra, phone: "MUST_NOT_EXPOSE" }] });
    const capture = vi.fn().mockResolvedValue({ contractVersion: 1, sourceType: type, target: { id: target, name },
      session: { id: "current", name: "当前学期", beginDate: "2026-09-07" }, timetable: { maxSection: 12,
        classTimetableVOList: [{ courseName: "目标课程", roomName: "一教101", weekDay: 1, teachingWeek: "11", period: "11", ...owner }] } });
    const testEnv = { ...env, EXTERNAL_SUBSCRIPTION_TYPES: type,
      AUTH: { verifySession: async () => ({ user: { id: userId, name: "测试", email: "test@example.com", role: "user" }, caps: { calendar: caps }, cquBindStatus: "active" }),
        getCaps: vi.fn().mockResolvedValue({ calendar: caps }), getCquTicket: vi.fn(), cquExternalSearch: search, cquExternalCapture: capture },
      SCHEDULE_SYNC_QUEUE: { send } } as unknown as Env;
    const app = new Hono<SessionEnv>();
    app.use("/search/*", businessIdentity); app.use("/subscriptions/*", businessIdentity);
    app.route("/search", external); app.route("/subscriptions", subscriptions); app.route("/calendar", calendar);
    const request = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("CF-Connecting-IP", `2001:db8:${userId.slice(0, 4)}:${userId.slice(4, 8)}::1`);
      return app.request(path, { ...init, headers }, testEnv);
    };
    async function create() {
      const found = await request(`/search/search?source_type=${type}&keyword=同名`);
      expect(found.status).toBe(200);
      const selected = await found.json<any>();
      expect(selected.results).toEqual([{ id: "same-name-other", name, extra: "学院甲 · T001" }, { id: target, name, extra }]);
      const response = await request("/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: type, sourceId: target, sourceName: name, sessionId: "current", selectionToken: selected.selection_token }) });
      expect(response.status).toBe(201);
      return response.json<any>();
    }
    async function consume() {
      await processScheduleSyncBatch({ queue: "schedule-sync", messages: [{ body: send.mock.calls[0][0], attempts: 1, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<any>, testEnv);
    }
    return { request, capture, search, create, consume, testEnv };
  }

  it("searches distinguishable identities and publishes only the exact selected target", async () => {
    const app = harness(); const created = await app.create(); await app.consume();
    expect(app.capture).toHaveBeenCalledWith(expect.objectContaining({ sourceType: type, targetId: target, expectedSessionId: "current" }));
    const response = await app.request(`/calendar/${created.links[0].token}/calendar.ics`);
    expect(response.status).toBe(200); const body = await response.text(); expect(body).toContain("SUMMARY:目标课程");
    if (type === "laboratory") expect(body).toContain("实验内容：电路实验项目");
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ source_type: type, source_id: target, import_quality: "complete", source_version: 1 });
    expect(app.testEnv.AUTH.getCquTicket).not.toHaveBeenCalled();
  });

  it("represents an empty target without substituting another same-name result", async () => {
    const app = harness(); const created = await app.create();
    app.capture.mockResolvedValue({ contractVersion: 1, sourceType: type, target: { id: target, name }, session: { id: "current", name: "当前学期", beginDate: "2026-09-07" },
      timetable: { maxSection: 12, classTimetableVOList: [] } });
    await app.consume();
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "success", import_quality: "empty", source_id: target });
    const calendar = await app.request(`/calendar/${created.links[0].token}/calendar.ics`);
    expect(calendar.status).toBe(200); expect(await calendar.text()).not.toContain("BEGIN:VEVENT");
  });

  it("reports unverified extra activities instead of claiming an empty complete calendar", async () => {
    const app = harness(); const created = await app.create();
    app.capture.mockResolvedValue({ contractVersion: 1, sourceType: type, target: { id: target, name }, session: { id: "current", name: "当前学期", beginDate: "2026-09-07" },
      timetable: { maxSection: 12, classTimetableVOList: [], unverifiedItemCount: 3 } });
    await app.consume();
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "success", import_quality: "partial", skipped_count: 3 });
  });

  it("fails the whole capture if a row belongs to another target", async () => {
    const app = harness(); const created = await app.create();
    app.capture.mockResolvedValue({ contractVersion: 1, sourceType: type, target: { id: target, name }, session: { id: "current", name: "当前学期", beginDate: "2026-09-07" },
      timetable: { maxSection: 12, classTimetableVOList: [{ courseName: "其他人的课", weekDay: 1, teachingWeek: "1", period: "11", instructorIdList: ["same-name-other"] }] } });
    await app.consume();
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "error", sync_error_code: "EXTERNAL_INVALID_RESPONSE", last_synced_at: null });
    expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(503);
  });
});
