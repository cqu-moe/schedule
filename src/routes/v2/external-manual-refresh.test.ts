import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { Hono } from "hono";
import { businessIdentity } from "../../test-utils/business-identity";
import type { SessionEnv } from "../../middleware/session";
import type { CalendarCaps } from "../../services/auth-rpc";
import type { Env } from "../../types";
import subscriptions from "./subscriptions";
import calendar from "./calendar";
import { processScheduleSyncBatch } from "../../cron/schedule-sync";

const CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: false,
  sub_limit: 10,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
  external_manual_refresh: 1,
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeApp(userId: string, caps = CAPS) {
  const send = vi.fn().mockResolvedValue(undefined);
  const capture = vi.fn();
  const app = new Hono<SessionEnv>();
  app.use("/subscriptions/*", businessIdentity);
  app.route("/subscriptions", subscriptions);
  app.route("/calendar", calendar);
  const testEnv = {
    ...env,
    EXTERNAL_SUBSCRIPTION_TYPES: "admin_class",
    AUTH: {
      verifySession: async () => ({
        user: { id: userId, name: "测试", email: "test@example.com", role: "user" },
        caps: { calendar: caps },
        cquBindStatus: "active",
      }),
      getCquTicket: vi.fn().mockResolvedValue({ error: "NOT_USED" }),
      getCaps: vi.fn().mockResolvedValue({ calendar: caps }),
      cquExternalCapture: capture,
    },
    SCHEDULE_SYNC_QUEUE: { send },
  } as unknown as Env;
    return {
    send,
    capture,
    testEnv,
    request: (path: string, init?: RequestInit) => app.request(path, { method: "POST", ...init }, testEnv),
  };
}

async function seedExternalSubscription(userId: string, suffix: string, targetRevision = 0) {
  const id = `${userId}-external-${suffix}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO subscriptions
    (id,user_id,source_type,source_id,source_name,source_version,target_revision,
     external_state,is_personal,is_active,sync_status,sync_run_id,last_synced_at,
     manual_refresh_at,created_at,updated_at)
    VALUES (?,?, 'admin_class',?,?,1,?,'active',0,1,'success','old-run','2000-01-01T00:00:00.000Z',NULL,?,?)`)
    .bind(id, userId, `target-${suffix}`, `测试行政班${suffix}`, targetRevision, now, now)
    .run();
  return id;
}

describe("new external manual refresh quota", () => {
  it("charges a captured failure, preserves its calendar, and retries to a public success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const userId = `end-to-end-user-${crypto.randomUUID()}`;
    const sid = await seedExternalSubscription(userId, "one", 3);
    const token = `manual-${crypto.randomUUID()}`;
    const previousCalendar = "BEGIN:VCALENDAR\r\nSUMMARY:旧课表\r\nEND:VCALENDAR";
    await env.DB.prepare(`INSERT INTO calendar_links
      (id,subscription_id,token,formats,is_default,is_active,created_at,updated_at)
      VALUES (?,?,?, '["ics"]',1,1,?,?)`)
      .bind(crypto.randomUUID(), sid, token, new Date().toISOString(), new Date().toISOString()).run();
    await env.DB.prepare(`UPDATE subscriptions SET ics_content=?,last_synced_at='2000-01-01T00:00:00.000Z'
      WHERE id=?`).bind(previousCalendar, sid).run();
    const app = makeApp(userId, { ...CAPS, external_manual_refresh: 2 });
    const consume = async (call: number) => {
      const message = {
        body: app.send.mock.calls[call][0],
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      await processScheduleSyncBatch(
        { queue: "schedule-sync", messages: [message] } as unknown as MessageBatch<any>,
        app.testEnv,
      );
      return message;
    };

    const first = await app.request(`/subscriptions/${sid}/syncs`);
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    app.capture.mockResolvedValueOnce({ error: "PAGE_PERMISSION_DENIED" });
    await consume(0);

    expect(await env.DB.prepare(`SELECT sync_status,sync_error_code,ics_content,last_synced_at
      FROM subscriptions WHERE id=?`).bind(sid).first()).toMatchObject({
      sync_status: "error",
      sync_error_code: "EXTERNAL_TARGET_FORBIDDEN",
      ics_content: previousCalendar,
      last_synced_at: "2000-01-01T00:00:00.000Z",
    });
    expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
      WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toEqual({ used_count: 1 });
    const publicFailure = await app.request(`/calendar/${token}/calendar.ics`, { method: "GET" });
    expect(publicFailure.status).toBe(200);
    expect(await publicFailure.text()).toContain("旧课表");

    const immediateRetry = await app.request(`/subscriptions/${sid}/syncs`);
    expect(immediateRetry.status).toBe(429);
    expect((await immediateRetry.json()).detail.error.code).toBe("MANUAL_REFRESH_COOLDOWN");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const retry = await app.request(`/subscriptions/${sid}/syncs`);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ manual_remaining: 0 });
    app.capture.mockResolvedValueOnce({
      contractVersion: 1,
      sourceType: "admin_class",
      target: { id: "target-one", name: "测试行政班one" },
      session: { id: "term-current", name: "2026秋", beginDate: "2026-09-07" },
      timetable: {
        maxSection: 14,
        classTimetableVOList: [{
          courseName: "手动刷新课程",
          instructorName: "测试教师",
          roomName: "DS1001",
          weekDay: 1,
          teachingWeek: "11",
          period: "11000000000000",
          assignTeachingObject: [{ adminClassId: "target-one" }],
        }],
      },
    });
    await consume(1);

    expect(await env.DB.prepare(`SELECT sync_status,import_quality,skipped_count
      FROM subscriptions WHERE id=?`).bind(sid).first()).toMatchObject({
      sync_status: "success",
      import_quality: "complete",
      skipped_count: 0,
    });
    expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
      WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toEqual({ used_count: 2 });
    const publicSuccess = await app.request(`/calendar/${token}/calendar.ics`, { method: "GET" });
    expect(publicSuccess.status).toBe(200);
    expect(await publicSuccess.text()).toContain("手动刷新课程");
  });

  it("keeps legacy externals and non-active new lifecycle rows frozen without usage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const cases = [
      { name: "legacy", sql: "source_version=0", status: 503, code: "EXTERNAL_UNAVAILABLE" },
      { name: "expired", sql: "external_state='expired'", status: 409, code: "EXTERNAL_TERM_EXPIRED" },
      { name: "reselecting", sql: "external_state='reselecting'", status: 409, code: "EXTERNAL_RESELECTING" },
    ] as const;

    for (const item of cases) {
      const userId = `frozen-user-${item.name}-${crypto.randomUUID()}`;
      const sid = await seedExternalSubscription(userId, item.name);
      await env.DB.prepare(`UPDATE subscriptions SET ${item.sql} WHERE id=?`).bind(sid).run();
      const app = makeApp(userId);
      const response = await app.request(`/subscriptions/${sid}/syncs`);
      expect(response.status).toBe(item.status);
      expect((await response.json()).detail.error.code).toBe(item.code);
      expect(app.send).not.toHaveBeenCalled();
      expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
        WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toBeNull();
    }
  });

  it("reuses one in-flight task for concurrent requests to the same subscription", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const userId = `same-sub-user-${crypto.randomUUID()}`;
    const sid = await seedExternalSubscription(userId, "one");
    const app = makeApp(userId);

    const responses = await Promise.all([
      app.request(`/subscriptions/${sid}/syncs`),
      app.request(`/subscriptions/${sid}/syncs`),
    ]);
    const bodies = await Promise.all(responses.map(response => response.json()));

    expect(responses.map(response => response.status)).toEqual([202, 202]);
    expect(new Set(bodies.map(body => body.run_id)).size).toBe(1);
    expect(bodies.map(body => body.manual_remaining)).toEqual([0, 0]);
    expect(app.send).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
      WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toEqual({ used_count: 1 });
  });

  it("distinguishes absent, zero, and explicit unlimited external manual quota", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));

    for (const caps of [
      { ...CAPS, external_manual_refresh: undefined },
      { ...CAPS, external_manual_refresh: 0 },
    ]) {
      const userId = `disabled-user-${crypto.randomUUID()}`;
      const sid = await seedExternalSubscription(userId, "one", 7);
      const app = makeApp(userId, caps);
      const response = await app.request(`/subscriptions/${sid}/syncs`);
      expect(response.status).toBe(429);
      expect((await response.json()).detail.error.code).toBe("RATE_LIMITED");
      expect(app.send).not.toHaveBeenCalled();
      expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
        WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toBeNull();
    }

    const userId = `unlimited-user-${crypto.randomUUID()}`;
    const sid = await seedExternalSubscription(userId, "one", 7);
    const app = makeApp(userId, { ...CAPS, external_manual_refresh: null });
    const response = await app.request(`/subscriptions/${sid}/syncs`);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ manual_remaining: null });
    expect(app.send).toHaveBeenCalledWith(expect.objectContaining({
      sourceVersion: 1,
      targetRevision: 7,
    }));
    expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
      WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toEqual({ used_count: 1 });
  });

  it("counts unlimited accepted runs when an administrator later grants a finite allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const userId = `downgrade-user-${crypto.randomUUID()}`;
    const first = await seedExternalSubscription(userId, "one");
    const second = await seedExternalSubscription(userId, "two");
    const unlimited = makeApp(userId, { ...CAPS, external_manual_refresh: null });
    expect((await unlimited.request(`/subscriptions/${first}/syncs`)).status).toBe(202);
    const limited = makeApp(userId, { ...CAPS, external_manual_refresh: 1 });
    expect((await limited.request(`/subscriptions/${second}/syncs`)).status).toBe(429);
    expect(limited.send).not.toHaveBeenCalled();
  });

  it("enforces cooldown, then resets the shared quota on the next China day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const userId = `cooldown-user-${crypto.randomUUID()}`;
    const first = await seedExternalSubscription(userId, "one");
    const second = await seedExternalSubscription(userId, "two");
    const third = await seedExternalSubscription(userId, "three");
    const app = makeApp(userId, { ...CAPS, external_manual_refresh: 2 });

    const accepted = await app.request(`/subscriptions/${first}/syncs`);
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({ manual_remaining: 1 });
    const list = await app.request("/subscriptions", { method: "GET" });
    expect(await list.json()).toMatchObject({
      manual_remaining: 1,
      subscriptions: expect.arrayContaining([expect.objectContaining({ id: first, is_active: true })]),
    });
    await env.DB.prepare(`UPDATE subscriptions SET sync_status='success'
      WHERE id=? AND sync_run_id=?`).bind(first, acceptedBody.run_id).run();
    const cooling = await app.request(`/subscriptions/${first}/syncs`);
    expect(cooling.status).toBe(429);
    expect((await cooling.json()).detail.error.code).toBe("MANUAL_REFRESH_COOLDOWN");
    expect(app.send).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const secondAccepted = await app.request(`/subscriptions/${first}/syncs`);
    expect(secondAccepted.status).toBe(202);
    expect(await secondAccepted.json()).toMatchObject({ manual_remaining: 0 });

    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    const nextDay = await app.request(`/subscriptions/${third}/syncs`);
    expect(nextDay.status).toBe(202);
    expect(await nextDay.json()).toMatchObject({ manual_remaining: 1 });
    expect(await env.DB.prepare(`SELECT quota_date,used_count
      FROM external_manual_refresh_usage WHERE user_id=? ORDER BY quota_date`)
      .bind(userId).all()).toMatchObject({
      results: [
        { quota_date: "2026-09-06", used_count: 2 },
        { quota_date: "2026-09-07", used_count: 1 },
      ],
    });
  });

  it("refunds an unqueued external manual task and allows an immediate retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const userId = `queue-failure-user-${crypto.randomUUID()}`;
    const sid = await seedExternalSubscription(userId, "one");
    const app = makeApp(userId);
    app.send.mockRejectedValueOnce(new Error("queue offline"));

    const failed = await app.request(`/subscriptions/${sid}/syncs`);
    expect(failed.status).toBe(500);

    expect(await env.DB.prepare(`SELECT used_count,manual_refresh_at,sync_status,sync_error_code
      FROM external_manual_refresh_usage JOIN subscriptions ON subscriptions.user_id=external_manual_refresh_usage.user_id
      WHERE external_manual_refresh_usage.user_id=? AND quota_date='2026-09-06' AND subscriptions.id=?`)
      .bind(userId, sid).first()).toMatchObject({
      used_count: 0,
      manual_refresh_at: null,
      sync_status: "error",
      sync_error_code: "QUEUE_UNAVAILABLE",
    });

    const retried = await app.request(`/subscriptions/${sid}/syncs`);
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ manual_remaining: 0 });
    expect(app.send).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
      WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toEqual({ used_count: 1 });
  });

  it.each(["deleted", "expired"])("refunds failed enqueue after the reserved subscription is %s", async lifecycle => {
    const userId = `lost-reservation-${crypto.randomUUID()}`;
    const sid = await seedExternalSubscription(userId, "one");
    const other = await seedExternalSubscription(userId, "two");
    const app = makeApp(userId);
    let reject!: (error: Error) => void;
    app.send.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = app.request(`/subscriptions/${sid}/syncs`);
    await vi.waitFor(() => expect(app.send).toHaveBeenCalledOnce());
    if (lifecycle === "deleted") {
      expect((await app.request(`/subscriptions/${sid}`, { method: "DELETE" })).status).toBe(204);
    } else {
      // Independently owned term-expiration transaction clears the run identity.
      await env.DB.prepare("UPDATE subscriptions SET external_state='expired',is_active=0,sync_run_id=NULL,target_revision=target_revision+1 WHERE id=?")
        .bind(sid).run();
    }
    reject(new Error("queue rejected"));
    expect((await pending).status).toBe(500);
    expect(await (await app.request("/subscriptions", { method: "GET" })).json()).toMatchObject({ manual_remaining: 1 });
    const next = await app.request(`/subscriptions/${other}/syncs`);
    expect(next.status).toBe(202);
    expect(await next.json()).toMatchObject({ manual_remaining: 0 });
  });

  it("refunds only the rejected reservation after another subscription has spent a newer unit", async () => {
    const userId = `overlapping-reservations-${crypto.randomUUID()}`;
    const first = await seedExternalSubscription(userId, "one");
    const second = await seedExternalSubscription(userId, "two");
    const third = await seedExternalSubscription(userId, "three");
    const app = makeApp(userId, { ...CAPS, external_manual_refresh: 2 });
    let reject!: (error: Error) => void;
    app.send.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = app.request(`/subscriptions/${first}/syncs`);
    await vi.waitFor(() => expect(app.send).toHaveBeenCalledOnce());
    const accepted = await app.request(`/subscriptions/${second}/syncs`);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ manual_remaining: 0 });
    expect((await app.request(`/subscriptions/${first}`, { method: "DELETE" })).status).toBe(204);
    reject(new Error("queue rejected"));
    expect((await pending).status).toBe(500);
    expect(await (await app.request("/subscriptions", { method: "GET" })).json()).toMatchObject({ manual_remaining: 1 });
    expect((await app.request(`/subscriptions/${third}/syncs`)).status).toBe(202);
    expect((await app.request(`/subscriptions/${second}/syncs`)).status).toBe(202);
    expect(await (await app.request("/subscriptions", { method: "GET" })).json()).toMatchObject({ manual_remaining: 0 });
    expect(app.send).toHaveBeenCalledTimes(3);
  });

  it("atomically admits one daily task across concurrent different subscriptions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const userId = `quota-user-${crypto.randomUUID()}`;
    const first = await seedExternalSubscription(userId, "one");
    const second = await seedExternalSubscription(userId, "two");
    const app = makeApp(userId);

    const responses = await Promise.all([
      app.request(`/subscriptions/${first}/syncs`),
      app.request(`/subscriptions/${second}/syncs`),
    ]);
    const accepted = responses.find(response => response.status === 202);
    const rejected = responses.find(response => response.status !== 202);

    expect(responses.map(response => response.status).sort()).toEqual([202, 429]);
    expect((await accepted!.json()).manual_remaining).toBe(0);
    expect((await rejected!.json()).detail.error.code).toBe("RATE_LIMITED");
    expect(app.send).toHaveBeenCalledOnce();
    expect(app.send.mock.calls[0][0]).toMatchObject({
      userId,
      sourceVersion: 1,
      targetRevision: 0,
      trigger: "manual",
    });
    expect(await env.DB.prepare(`SELECT used_count FROM external_manual_refresh_usage
      WHERE user_id=? AND quota_date='2026-09-06'`).bind(userId).first()).toEqual({ used_count: 1 });
  });
});
