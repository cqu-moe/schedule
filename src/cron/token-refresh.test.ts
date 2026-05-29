import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../db/schema";
import { encrypt } from "../services/crypto";
import {
  enqueueTokenRefresh,
  processTokenRefreshBatch,
  type TokenRefreshMessage,
} from "./token-refresh";
import type { Env } from "../types";

// Test encryption key: 32 bytes base64-encoded
const TEST_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

/** Insert a test user into D1 with the given tokenExpiresAt */
async function insertUser(
  db: ReturnType<typeof drizzle>,
  opts: {
    studentId: string;
    tokenExpiresAt: string | null;
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
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpiresAt: opts.tokenExpiresAt,
    calendarToken,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

describe("enqueueTokenRefresh (producer)", () => {
  const db = drizzle(env.DB);

  beforeAll(async () => {
    // Create the users table in the ephemeral D1 test database
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL,
        student_id text NOT NULL,
        encrypted_password text NOT NULL,
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

  it("should not call sendBatch when no users need refresh", async () => {
    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should not call sendBatch when users have null tokenExpiresAt", async () => {
    await insertUser(db, {
      studentId: "20210001",
      tokenExpiresAt: null,
    });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should not enqueue users whose tokens expire more than 2 hours from now", async () => {
    // Token expires 3 hours from now - well outside the 2h window
    const futureExpiry = new Date(
      Date.now() + 3 * 60 * 60 * 1000,
    ).toISOString();

    await insertUser(db, {
      studentId: "20210002",
      tokenExpiresAt: futureExpiry,
    });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should enqueue users whose tokens expire within 2 hours", async () => {
    // Token expires 1 hour from now - inside the 2h window
    const soonExpiry = new Date(
      Date.now() + 1 * 60 * 60 * 1000,
    ).toISOString();

    const userId = await insertUser(db, {
      studentId: "20210003",
      tokenExpiresAt: soonExpiry,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body).toEqual({
      userId,
      studentId: "20210003",
    });
    expect(batch[0].delaySeconds).toBe(0);
  });

  it("should enqueue users whose tokens have already expired", async () => {
    // Token expired 1 hour ago
    const pastExpiry = new Date(
      Date.now() - 1 * 60 * 60 * 1000,
    ).toISOString();

    const userId = await insertUser(db, {
      studentId: "20210004",
      tokenExpiresAt: pastExpiry,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body.userId).toBe(userId);
  });

  it("should enqueue only expiring users in a mixed set", async () => {
    // User A: expires in 30 minutes (should be enqueued)
    const expiringId = await insertUser(db, {
      studentId: "20210005",
      tokenExpiresAt: new Date(
        Date.now() + 30 * 60 * 1000,
      ).toISOString(),
    });

    // User B: expires in 5 hours (should NOT be enqueued)
    await insertUser(db, {
      studentId: "20210006",
      tokenExpiresAt: new Date(
        Date.now() + 5 * 60 * 60 * 1000,
      ).toISOString(),
    });

    // User C: null expiry (should NOT be enqueued)
    await insertUser(db, {
      studentId: "20210007",
      tokenExpiresAt: null,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body.userId).toBe(expiringId);
    expect(batch[0].body.studentId).toBe("20210005");
  });

  it("should enqueue multiple expiring users in a single batch", async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const id1 = await insertUser(db, {
      studentId: "20210010",
      tokenExpiresAt: soon,
    });
    const id2 = await insertUser(db, {
      studentId: "20210011",
      tokenExpiresAt: soon,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(2);

    const userIds = batch.map(
      (m: { body: { userId: string } }) => m.body.userId,
    );
    expect(userIds).toContain(id1);
    expect(userIds).toContain(id2);

    // Verify delaySeconds is set with increasing intervals
    expect(batch[0].delaySeconds).toBe(0);
    expect(batch[1].delaySeconds).toBeGreaterThan(0);
    // Interval = floor(3600 / 2) = 1800, clamped by max(5, ...)
    expect(batch[1].delaySeconds).toBe(1800);
  });
});

function mockMessage(body: TokenRefreshMessage) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function mockBatch(messages: ReturnType<typeof mockMessage>[]) {
  return {
    messages,
    queue: "test",
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<TokenRefreshMessage>;
}

describe("processTokenRefreshBatch (consumer)", () => {
  const db = drizzle(env.DB);

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL,
        student_id text NOT NULL,
        encrypted_password text NOT NULL,
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
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("should ack messages for non-existent users", async () => {
    const msg = mockMessage({ userId: "nonexistent", studentId: "00000000" });
    await processTokenRefreshBatch(mockBatch([msg]), {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);
    expect(msg.ack).toHaveBeenCalled();
  });

  it("should ack messages for users that no longer need refresh", async () => {
    // Token expires in 3 hours (> 2h threshold = no refresh needed)
    const id = await insertUser(db, {
      studentId: "20210030",
      tokenExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });
    const msg = mockMessage({ userId: id, studentId: "20210030" });
    await processTokenRefreshBatch(mockBatch([msg]), {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);
    expect(msg.ack).toHaveBeenCalled();
  });
});
