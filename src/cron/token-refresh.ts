import { drizzle } from "drizzle-orm/d1";
import { lt, isNotNull, eq, and } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env } from "../types";
import { encrypt, decrypt } from "../services/crypto";
import { refreshToken, login, AuthError } from "../services/auth";
import { spreadEnqueue } from "../utils/queue";

export interface TokenRefreshMessage {
  userId: string;
  studentId: string;
}

/** Producer: query users needing refresh, send to queue */
export async function enqueueTokenRefresh(env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "cron.token_refresh.start", message: "Enqueuing token refresh" }));
  const db = drizzle(env.DB);

  const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const expiring = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(and(isNotNull(users.tokenExpiresAt), lt(users.tokenExpiresAt, threshold)));

  if (expiring.length === 0) {
    console.log(JSON.stringify({ event: "cron.token_refresh.skip", message: "No users need token refresh" }));
    return;
  }

  await spreadEnqueue(
    env.TOKEN_REFRESH_QUEUE,
    expiring,
    (u) => ({ body: { userId: u.id, studentId: u.studentId } satisfies TokenRefreshMessage }),
    3600,
    5,
  );

  console.log(JSON.stringify({ event: "cron.token_refresh.enqueued", count: expiring.length, message: `Enqueued ${expiring.length} users for token refresh` }));
}

/** Consumer: process a batch of token refresh messages */
export async function processTokenRefreshBatch(
  batch: MessageBatch<TokenRefreshMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const { userId, studentId } = message.body;
      try {
        // Read fresh user data (token may have been refreshed by another batch)
        const [user] = await db
          .select({
            id: users.id,
            studentId: users.studentId,
            refreshToken: users.refreshToken,
            encryptedPassword: users.encryptedPassword,
            tokenExpiresAt: users.tokenExpiresAt,
          })
          .from(users)
          .where(eq(users.id, userId));

        if (!user) {
          message.ack();
          return;
        }

        // Check if still needs refresh
        const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        if (!user.tokenExpiresAt || user.tokenExpiresAt >= threshold) {
          message.ack();
          return;
        }

        const now = new Date().toISOString();

        // Try refresh token first
        if (user.refreshToken) {
          try {
            const decryptedRefreshToken = await decrypt(user.refreshToken, env.ENCRYPTION_KEY);
            const result = await refreshToken(decryptedRefreshToken);
            await db
              .update(users)
              .set({
                accessToken: await encrypt(result.accessToken, env.ENCRYPTION_KEY),
                refreshToken: await encrypt(result.refreshToken, env.ENCRYPTION_KEY),
                tokenExpiresAt: result.expiresAt,
                lastRefreshAt: now,
                loginError: null,
                updatedAt: now,
              })
              .where(eq(users.id, userId));
            console.log(JSON.stringify({ event: "queue.token_refresh.success", studentId, message: "Token refreshed" }));
            message.ack();
            return;
          } catch (e) {
            if (!(e instanceof AuthError) || e.code !== "TOKEN_EXPIRED") {
              throw e;
            }
            console.warn(JSON.stringify({ event: "queue.token_refresh.fallback_login", studentId, message: "Refresh token expired, trying login" }));
          }
        }

        // Fallback: re-login
        const password = await decrypt(user.encryptedPassword, env.ENCRYPTION_KEY);
        const result = await login(user.studentId, password);
        await db
          .update(users)
          .set({
            accessToken: await encrypt(result.accessToken, env.ENCRYPTION_KEY),
            refreshToken: await encrypt(result.refreshToken, env.ENCRYPTION_KEY),
            tokenExpiresAt: result.expiresAt,
            lastLoginAt: now,
            lastRefreshAt: now,
            loginError: null,
            updatedAt: now,
          })
          .where(eq(users.id, userId));
        console.log(JSON.stringify({ event: "queue.token_refresh.login_success", studentId, message: "Re-login successful" }));
        message.ack();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ event: "queue.token_refresh.failed", studentId, error: msg, message: "Token refresh failed" }));

        // Permanent failures → ack and record error, don't retry
        if (e instanceof AuthError && (e.code === "INVALID_CREDENTIALS" || e.code === "CAPTCHA_REQUIRED")) {
          await db
            .update(users)
            .set({ loginError: msg, updatedAt: new Date().toISOString() })
            .where(eq(users.id, userId));
          message.ack();
          return;
        }

        // Transient failures → retry (timeout, network, upstream errors)
        await db
          .update(users)
          .set({ loginError: msg, updatedAt: new Date().toISOString() })
          .where(eq(users.id, userId));
        message.retry();
      }
    }),
  );
}
