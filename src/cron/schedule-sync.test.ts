import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../db/schema";
import { encrypt } from "../services/crypto";
import { enqueueScheduleSync } from "./schedule-sync";
import type { Env } from "../types";

// Test encryption key: 32 bytes base64-encoded
const TEST_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

/** Insert a test user into D1 with the given accessToken */
async function insertUser(
  db: ReturnType<typeof drizzle>,
  opts: {
    studentId: string;
    accessToken: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const encryptedPassword = await encrypt("test-password", TEST_KEY);
  const calendarToken = crypto.randomUUID() + crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id,
    studentId: opts.studentId,
    encryptedPassword,
    accessToken: opts.accessToken,
    refreshToken: opts.accessToken ? "test-refresh-token" : null,
    tokenExpiresAt: opts.accessToken ? new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() : null,
    calendarToken,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

describe("enqueueScheduleSync (producer)", () => {
  const db = drizzle(env.DB);

  beforeAll(async () => {
    // Create the users table in the ephemeral D1 test database
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL,
        student_id text NOT NULL,
        encrypted_password text,
        auth_user_id text,
        auth_refresh_token text,
        auth_refresh_issued_at text,
        access_token text,
        refresh_token text,
        token_expires_at text,
        calendar_token text NOT NULL,
        pending_calendar_token text,
        pending_token_expires_at text,
        last_login_at text,
        last_refresh_at text,
        login_error text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_unique ON users (auth_user_id)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_password_student_id ON users (student_id) WHERE auth_user_id IS NULL`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_calendar_token_unique ON users (calendar_token)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_pending_calendar_token_unique ON users (pending_calendar_token)`,
    ).run();
  });

  beforeEach(async () => {
    // Clean users table before each test
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("should not call sendBatch when no users exist", async () => {
    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      SCHEDULE_SYNC_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should enqueue users with access tokens", async () => {
    const userId = await insertUser(db, {
      studentId: "20210001",
      accessToken: "valid-token",
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      SCHEDULE_SYNC_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body).toEqual({
      userId,
      studentId: "20210001",
    });
    expect(batch[0].delaySeconds).toBe(0);
  });

  it("should not enqueue users with null access tokens", async () => {
    await insertUser(db, {
      studentId: "20210002",
      accessToken: null,
    });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      SCHEDULE_SYNC_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should enqueue only users with access tokens in a mixed set", async () => {
    // User A: has access token (should be enqueued)
    const activeId = await insertUser(db, {
      studentId: "20210003",
      accessToken: "valid-token-a",
    });

    // User B: null access token (should NOT be enqueued)
    await insertUser(db, {
      studentId: "20210004",
      accessToken: null,
    });

    // User C: has access token (should be enqueued)
    const activeId2 = await insertUser(db, {
      studentId: "20210005",
      accessToken: "valid-token-c",
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      SCHEDULE_SYNC_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(2);

    const userIds = batch.map(
      (m: { body: { userId: string } }) => m.body.userId,
    );
    expect(userIds).toContain(activeId);
    expect(userIds).toContain(activeId2);

    const studentIds = batch.map(
      (m: { body: { studentId: string } }) => m.body.studentId,
    );
    expect(studentIds).not.toContain("20210004");
  });

  it("should enqueue multiple active users in a single batch", async () => {
    const id1 = await insertUser(db, {
      studentId: "20210010",
      accessToken: "token-1",
    });
    const id2 = await insertUser(db, {
      studentId: "20210011",
      accessToken: "token-2",
    });
    const id3 = await insertUser(db, {
      studentId: "20210012",
      accessToken: "token-3",
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      SCHEDULE_SYNC_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(3);

    const userIds = batch.map(
      (m: { body: { userId: string } }) => m.body.userId,
    );
    expect(userIds).toContain(id1);
    expect(userIds).toContain(id2);
    expect(userIds).toContain(id3);

    // Verify delaySeconds is set with increasing intervals
    // Interval = floor(21600 / 3) = 7200, clamped by max(10, ...)
    expect(batch[0].delaySeconds).toBe(0);
    expect(batch[1].delaySeconds).toBe(7200);
    expect(batch[2].delaySeconds).toBe(14400);
  });
});
