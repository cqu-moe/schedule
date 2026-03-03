import { drizzle } from "drizzle-orm/d1";
import { lt, isNotNull, eq, and } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env } from "../types";
import { encrypt, decrypt, decryptOrPlaintext } from "../services/crypto";
import { refreshToken, login, AuthError } from "../services/auth";

export interface TokenRefreshMessage {
  userId: string;
  studentId: string;
}

/** Producer: query users needing refresh, send to queue */
export async function enqueueTokenRefresh(env: Env): Promise<void> {
  console.log("cron: enqueuing token refresh");
  const db = drizzle(env.DB);

  const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const expiring = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(and(isNotNull(users.tokenExpiresAt), lt(users.tokenExpiresAt, threshold)));

  if (expiring.length === 0) {
    console.log("cron: no users need token refresh");
    return;
  }

  // sendBatch accepts max 100 messages per call
  const BATCH_SIZE = 100;
  // Spread messages over 1 hour: interval between each message delivery
  const interval = Math.max(5, Math.floor(3600 / expiring.length));

  for (let i = 0; i < expiring.length; i += BATCH_SIZE) {
    const chunk = expiring.slice(i, i + BATCH_SIZE);
    await env.TOKEN_REFRESH_QUEUE.sendBatch(
      chunk.map((u, j) => ({
        body: { userId: u.id, studentId: u.studentId } satisfies TokenRefreshMessage,
        delaySeconds: (i + j) * interval,
      })),
    );
  }

  console.log(`cron: enqueued ${expiring.length} users for token refresh`);
}

/** Consumer: process a batch of token refresh messages */
export async function processTokenRefreshBatch(
  batch: MessageBatch<TokenRefreshMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  for (const message of batch.messages) {
    const { userId, studentId } = message.body;
    try {
      // Read fresh user data (token may have been refreshed by another batch)
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));

      if (!user) {
        message.ack();
        continue;
      }

      // Check if still needs refresh
      const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      if (!user.tokenExpiresAt || user.tokenExpiresAt >= threshold) {
        message.ack();
        continue;
      }

      const now = new Date().toISOString();

      // Try refresh token first
      if (user.refreshToken) {
        try {
          // TODO(#13): 收敛后替换为 decrypt()
          const decryptedRefreshToken = await decryptOrPlaintext(user.refreshToken, env.ENCRYPTION_KEY);
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
          console.log(`queue: token refreshed for ${studentId}`);
          message.ack();
          continue;
        } catch (e) {
          if (!(e instanceof AuthError) || e.code !== "TOKEN_EXPIRED") {
            throw e;
          }
          console.warn(`queue: refresh token expired for ${studentId}, trying login`);
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
      console.log(`queue: re-login successful for ${studentId}`);
      message.ack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`queue: token refresh failed for ${studentId}: ${msg}`);

      // Permanent failures → ack and record error, don't retry
      if (e instanceof AuthError && (e.code === "INVALID_CREDENTIALS" || e.code === "CAPTCHA_REQUIRED")) {
        await db
          .update(users)
          .set({ loginError: msg, updatedAt: new Date().toISOString() })
          .where(eq(users.id, userId));
        message.ack();
        continue;
      }

      // Transient failures → retry (timeout, network, upstream errors)
      await db
        .update(users)
        .set({ loginError: msg, updatedAt: new Date().toISOString() })
        .where(eq(users.id, userId));
      message.retry();
    }
  }
}
