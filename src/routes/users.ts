import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import { encrypt, verifyPassword } from "../services/crypto";
import { login, WorkerError } from "../services/worker-client";
import { verifyCaptcha, CaptchaError } from "../services/captcha";
import { rateLimit } from "../middleware/rate-limit";
import { requireAuth } from "../middleware/auth";
import type { User } from "../db/schema";

type AuthEnv = { Bindings: Env; Variables: { user: User } };

const app = new Hono<AuthEnv>();

function generateCalendarToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function handleWorkerError(e: WorkerError): Response {
  if (e.code === "INVALID_CREDENTIALS") {
    return Response.json(
      { code: "INVALID_CREDENTIALS", message: e.message },
      { status: 401 },
    );
  }
  return Response.json(
    { code: "UPSTREAM_ERROR", message: e.message },
    { status: 502 },
  );
}

// POST /api/v1/users (register)
app.post("/", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
  } catch (e) {
    if (e instanceof CaptchaError) {
      return c.json({ detail: e.message }, 403);
    }
    throw e;
  }

  const body = await c.req.json<{ student_id: string; password: string }>();
  if (!body.student_id || !body.password) {
    return c.json({ detail: "student_id and password required" }, 400);
  }

  const db = drizzle(c.env.DB);

  // Check if user already exists
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.studentId, body.student_id))
    .limit(1);

  if (existing) {
    return c.json(
      { code: "USER_EXISTS", message: "User already registered" },
      409,
    );
  }

  // Verify via Playwright login
  let tokenResult;
  try {
    tokenResult = await login(c.env, body.student_id, body.password);
  } catch (e) {
    if (e instanceof WorkerError) return handleWorkerError(e);
    throw e;
  }

  const encryptedPw = await encrypt(body.password, c.env.ENCRYPTION_KEY);
  const calendarToken = generateCalendarToken();
  const now = new Date().toISOString();

  // Create user
  const [newUser] = await db
    .insert(users)
    .values({
      studentId: body.student_id,
      encryptedPassword: encryptedPw,
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      calendarToken,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Create 3 personal subscriptions
  const personalTypes = [
    { sourceType: "personal_all", sourceName: "全部课表" },
    { sourceType: "personal_courses", sourceName: "仅课程" },
    { sourceType: "personal_exams", sourceName: "仅考试" },
  ];

  for (const { sourceType, sourceName } of personalTypes) {
    await db.insert(subscriptions).values({
      userId: newUser.id,
      sourceType,
      sourceId: body.student_id,
      sourceName,
      calendarToken: generateCalendarToken(),
      isPersonal: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return c.json({ calendar_token: calendarToken });
});

// GET /api/v1/users/:token (get user info)
app.get("/:token", async (c) => {
  const token = c.req.param("token");
  const db = drizzle(c.env.DB);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return c.json(
      { code: "TOKEN_NOT_FOUND", message: "Calendar token not found" },
      404,
    );
  }

  return c.json({
    student_id: user.studentId,
    calendar_token: user.calendarToken,
    created_at: user.createdAt,
    last_sync: user.lastRefreshAt,
  });
});

// DELETE /api/v1/users/:token
app.delete("/:token", async (c) => {
  const token = c.req.param("token");
  const db = drizzle(c.env.DB);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return c.json(
      { code: "TOKEN_NOT_FOUND", message: "Calendar token not found" },
      404,
    );
  }

  await db.delete(users).where(eq(users.id, user.id));
  return c.body(null, 204);
});

// POST /api/v1/users/recover (recover by stored password)
app.post("/recover", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
  } catch (e) {
    if (e instanceof CaptchaError) {
      return c.json({ detail: e.message }, 403);
    }
    throw e;
  }

  const body = await c.req.json<{ student_id: string; password: string }>();
  const db = drizzle(c.env.DB);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.studentId, body.student_id))
    .limit(1);

  if (
    !user ||
    !(await verifyPassword(body.password, user.encryptedPassword, c.env.ENCRYPTION_KEY))
  ) {
    return c.json(
      { code: "PASSWORD_MISMATCH", message: "Password does not match" },
      422,
    );
  }

  return c.json({ calendar_token: user.calendarToken });
});

// POST /api/v1/users/recover/verify (recover via Playwright login)
app.post("/recover/verify", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
  } catch (e) {
    if (e instanceof CaptchaError) {
      return c.json({ detail: e.message }, 403);
    }
    throw e;
  }

  const body = await c.req.json<{ student_id: string; password: string }>();
  const db = drizzle(c.env.DB);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.studentId, body.student_id))
    .limit(1);

  if (!user) {
    return c.json(
      { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
      401,
    );
  }

  let tokenResult;
  try {
    tokenResult = await login(c.env, body.student_id, body.password);
  } catch (e) {
    if (e instanceof WorkerError) return handleWorkerError(e);
    throw e;
  }

  const encryptedPw = await encrypt(body.password, c.env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  await db
    .update(users)
    .set({
      encryptedPassword: encryptedPw,
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      lastLoginAt: now,
      loginError: null,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return c.json({ calendar_token: user.calendarToken });
});

export default app;
