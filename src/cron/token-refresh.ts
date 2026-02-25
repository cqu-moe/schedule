import { drizzle } from "drizzle-orm/d1";
import { lt, isNotNull, eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env } from "../types";
import { decrypt } from "../services/crypto";
import {
  refreshToken,
  login,
  WorkerError,
} from "../services/worker-client";

export async function refreshExpiringTokens(env: Env): Promise<void> {
  console.log("cron: starting token refresh");
  const db = drizzle(env.DB);

  // Find users with tokens expiring within 1 hour
  const threshold = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const expiring = await db
    .select()
    .from(users)
    .where(lt(users.tokenExpiresAt, threshold));

  console.log(`cron: ${expiring.length} users need token refresh`);

  for (const user of expiring) {
    try {
      const now = new Date().toISOString();

      // Try refresh token first
      if (user.refreshToken) {
        try {
          const result = await refreshToken(env, user.refreshToken);
          await db
            .update(users)
            .set({
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              tokenExpiresAt: result.expiresAt,
              lastRefreshAt: now,
              loginError: null,
              updatedAt: now,
            })
            .where(eq(users.id, user.id));
          console.log(`cron: token refreshed for ${user.studentId}`);
          continue;
        } catch (e) {
          if (e instanceof WorkerError && e.code !== "TOKEN_EXPIRED") throw e;
          console.warn(
            `cron: refresh token expired for ${user.studentId}, trying login`,
          );
        }
      }

      // Fallback: re-login with decrypted password
      const password = await decrypt(
        user.encryptedPassword,
        env.ENCRYPTION_KEY,
      );
      const result = await login(env, user.studentId, password);
      await db
        .update(users)
        .set({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          tokenExpiresAt: result.expiresAt,
          lastLoginAt: now,
          lastRefreshAt: now,
          loginError: null,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      console.log(`cron: re-login successful for ${user.studentId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`cron: token refresh failed for ${user.studentId}: ${msg}`);
      await db
        .update(users)
        .set({
          loginError: msg,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, user.id));
    }
  }

  console.log("cron: token refresh complete");
}
