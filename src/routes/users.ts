import { Hono } from "hono";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import { encrypt, verifyPassword } from "../services/crypto";
import { login, AuthError } from "../services/auth";
import { verifyCaptcha, CaptchaError } from "../services/captcha";
import { rateLimit } from "../middleware/rate-limit";
import { requireAuth } from "../middleware/auth";
import { generateToken } from "../utils/token";
import { errorResponse } from "../utils/error";
import { CQUAPIClient } from "../services/cqu-api";
import {
  fetchSessionContextCached,
  fetchPersonalSchedule,
  buildPersonalSyncResult,
  applySyncResult,
} from "../services/sync";

const STUDENT_ID_PATTERN = /^\d{8}$|^\d{17}[\dX]$/;

const app = new Hono<{ Bindings: Env }>();

function handleAuthError(e: AuthError): Response {
  if (e.code === "INVALID_CREDENTIALS") {
    return errorResponse("INVALID_CREDENTIALS", e.message, 401);
  }
  return errorResponse("UPSTREAM_ERROR", e.message, 502);
}

async function requireCaptcha(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
    return null;
  } catch (e) {
    if (e instanceof CaptchaError) {
      return errorResponse(e.message, e.message, 403);
    }
    throw e;
  }
}

async function parseCredentials(
  c: Context<{ Bindings: Env }>,
): Promise<{ student_id: string; password: string } | Response> {
  let body: { student_id: string; password: string };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
  }
  if (!body.student_id || !body.password) {
    return errorResponse("BAD_REQUEST", "student_id and password required", 400);
  }
  if (!STUDENT_ID_PATTERN.test(body.student_id)) {
    return errorResponse("BAD_REQUEST", "student_id must be 8-digit number or 18-digit ID card number", 400);
  }
  if (body.password.length > 256) {
    return errorResponse("BAD_REQUEST", "password must not exceed 256 characters", 400);
  }
  return body;
}

// POST /api/v1/users (register)
app.post("/", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaErr = await requireCaptcha(c);
  if (captchaErr) return captchaErr;
  const result = await parseCredentials(c);
  if (result instanceof Response) return result;
  const { student_id, password } = result;

  const db = drizzle(c.env.DB);

  // Verify via SSO login FIRST (prevents user enumeration)
  let tokenResult;
  try {
    tokenResult = await login(student_id, password);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError(e);
    throw e;
  }

  const encryptedPw = await encrypt(password, c.env.ENCRYPTION_KEY);
  const encryptedAccessToken = await encrypt(tokenResult.accessToken, c.env.ENCRYPTION_KEY);
  const encryptedRefreshToken = await encrypt(tokenResult.refreshToken, c.env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  // Check if user already exists
  const [existing] = await db
    .select({ id: users.id, calendarToken: users.calendarToken })
    .from(users)
    .where(eq(users.studentId, student_id))
    .limit(1);

  if (existing) {
    // User exists — update password + OAuth tokens, return existing calendar_token
    await db
      .update(users)
      .set({
        encryptedPassword: encryptedPw,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: tokenResult.expiresAt,
        lastLoginAt: now,
        loginError: null,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id));

    return c.json({ calendar_token: existing.calendarToken });
  }

  // New user — create with subscriptions
  const calendarToken = generateToken();

  const [newUser] = await db
    .insert(users)
    .values({
      studentId: student_id,
      encryptedPassword: encryptedPw,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      calendarToken,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Create 3 personal subscriptions
  const personalSubValues = [
    { sourceType: "personal_all", sourceName: "全部课表" },
    { sourceType: "personal_courses", sourceName: "仅课程" },
    { sourceType: "personal_exams", sourceName: "仅考试" },
  ].map(({ sourceType, sourceName }) => ({
    userId: newUser.id,
    sourceType,
    sourceId: student_id,
    sourceName,
    calendarToken: generateToken(),
    isPersonal: true,
    createdAt: now,
    updatedAt: now,
  }));

  const newSubs = await db
    .insert(subscriptions)
    .values(personalSubValues)
    .returning({ id: subscriptions.id, sourceType: subscriptions.sourceType });

  c.executionCtx.waitUntil(
    syncNewUserSubscriptions(
      c.env,
      newUser.id,
      student_id,
      tokenResult.accessToken,
      newSubs,
    ),
  );

  return c.json({ calendar_token: calendarToken }, 201);
});

// GET /api/v1/users/me (get current user info)
app.get("/me", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const user = c.get("user");

  return c.json({
    student_id: user.studentId,
    calendar_token: user.calendarToken,
    created_at: user.createdAt,
    last_sync: user.lastRefreshAt,
  });
});

// DELETE /api/v1/users/me (delete current user)
app.delete("/me", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  await db.delete(users).where(eq(users.id, user.id));
  return c.body(null, 204);
});

// POST /api/v1/users/recover (recover by stored password)
app.post("/recover", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaErr = await requireCaptcha(c);
  if (captchaErr) return captchaErr;
  const result = await parseCredentials(c);
  if (result instanceof Response) return result;
  const { student_id, password } = result;

  const db = drizzle(c.env.DB);

  const [user] = await db
    .select({
      encryptedPassword: users.encryptedPassword,
      calendarToken: users.calendarToken,
    })
    .from(users)
    .where(eq(users.studentId, student_id))
    .limit(1);

  if (
    !user ||
    !(await verifyPassword(password, user.encryptedPassword, c.env.ENCRYPTION_KEY))
  ) {
    return errorResponse("PASSWORD_MISMATCH", "Password does not match", 422);
  }

  return c.json({ calendar_token: user.calendarToken });
});

// POST /api/v1/users/recover/verify (recover via SSO login)
app.post("/recover/verify", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaErr = await requireCaptcha(c);
  if (captchaErr) return captchaErr;
  const result = await parseCredentials(c);
  if (result instanceof Response) return result;
  const { student_id, password } = result;

  const db = drizzle(c.env.DB);

  // Verify via SSO login FIRST (prevents user enumeration)
  let tokenResult;
  try {
    tokenResult = await login(student_id, password);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError(e);
    throw e;
  }

  const [user] = await db
    .select({ id: users.id, calendarToken: users.calendarToken })
    .from(users)
    .where(eq(users.studentId, student_id))
    .limit(1);

  // User not registered — return same error as SSO failure
  if (!user) {
    return errorResponse("INVALID_CREDENTIALS", "Invalid credentials", 401);
  }

  const encryptedPw = await encrypt(password, c.env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  const encryptedAccessToken = await encrypt(tokenResult.accessToken, c.env.ENCRYPTION_KEY);
  const encryptedRefreshToken = await encrypt(tokenResult.refreshToken, c.env.ENCRYPTION_KEY);

  await db
    .update(users)
    .set({
      encryptedPassword: encryptedPw,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      lastLoginAt: now,
      loginError: null,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return c.json({ calendar_token: user.calendarToken });
});

/** Background sync: populate ICS content for newly created personal subscriptions */
export async function syncNewUserSubscriptions(
  env: Env,
  userId: string,
  studentId: string,
  accessToken: string,
  subIds: { id: string; sourceType: string }[],
): Promise<void> {
  try {
    const db = drizzle(env.DB);
    const api = new CQUAPIClient(accessToken);
    const ctx = await fetchSessionContextCached(api, env.CACHE);
    const personalData = await fetchPersonalSchedule(api, studentId, ctx);

    for (const sub of subIds) {
      const result = await buildPersonalSyncResult(sub.sourceType, personalData, studentId);
      await applySyncResult(db, sub.id, result, ctx, {
        sessionId: null,
        sessionName: null,
      });
    }

    const now = new Date().toISOString();
    await db
      .update(users)
      .set({ lastRefreshAt: now, updatedAt: now })
      .where(eq(users.id, userId));

    console.log(JSON.stringify({ event: "registration.sync_complete", studentId, count: subIds.length, message: `Synced ${subIds.length} subscriptions` }));
  } catch (e) {
    console.error(JSON.stringify({ event: "registration.sync_failed", studentId, error: e instanceof Error ? e.message : String(e), message: "Background sync failed" }));
  }
}

export default app;
