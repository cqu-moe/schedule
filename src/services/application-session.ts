import * as oauth from "oauth4webapi";
import { getCookie } from "hono/cookie";
import type { SessionEnv } from "../middleware/session";
import type { Context } from "hono";
import type { Env } from "../types";
import type { VerifiedSession, CalendarCaps } from "./auth-rpc";

export const SESSION_COOKIE = "__Host-schedule_session";
export const TRANSACTION_COOKIE = "__Host-schedule_login";
export const SESSION_LIFETIME = 7 * 86400;
export const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function tokenHash(value: string) {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function encryptionKey(env: Env) {
  if (!env.CALENDAR_CLIENT_SECRET) throw new Error("Missing application credentials");
  const key = await crypto.subtle.digest("SHA-256", encoder.encode(`${env.CALENDAR_CLIENT_SECRET}:schedule-session:v1`));
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env: Env, data: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), encoder.encode(JSON.stringify(data)));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function unseal<T>(env: Env, value: string): Promise<T> {
  const [iv, ciphertext] = value.split(".");
  const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await encryptionKey(env), decode(ciphertext));
  return JSON.parse(new TextDecoder().decode(result));
}
export function oauthConfiguration(env: Env) {
  const origin = new URL(env.AUTH_ORIGIN ?? "https://auth.cqu.moe").origin;
  const as: oauth.AuthorizationServer = {
    issuer: `${origin}/api/auth`, authorization_endpoint: `${origin}/api/v1/auth/oauth2/authorize`,
    token_endpoint: `${origin}/api/v1/auth/oauth2/token`, introspection_endpoint: `${origin}/api/v1/auth/oauth2/introspect`,
    userinfo_endpoint: `${origin}/api/v1/auth/oauth2/userinfo`, jwks_uri: `${origin}/api/v1/auth/jwks`,
    id_token_signing_alg_values_supported: ["EdDSA"],
  };
  const client: oauth.Client = { client_id: env.CALENDAR_CLIENT_ID, id_token_signed_response_alg: "EdDSA" };
  const clientAuth = oauth.ClientSecretBasic(env.CALENDAR_CLIENT_SECRET);
  const redirectUri = new URL("/callback", env.PUBLIC_URL).href;
  return { as, client, clientAuth, redirectUri };
}
export function oauthRequestOptions(env: Env) {
  const origin = new URL(env.AUTH_ORIGIN ?? "https://auth.cqu.moe");
  const local = ["localhost", "127.0.0.1"].includes(origin.hostname) || origin.hostname.endsWith(".localhost");
  return { signal: AbortSignal.timeout(10000), ...(env.ENVIRONMENT === "development" && local ? { [oauth.allowInsecureRequests]: true as const } : {}) };
}
export interface Credentials {
  accessToken: string; refreshToken?: string; accessExpiresAt: number; sub: string; user: VerifiedSession["user"];
}
function calendarCaps(value: unknown): value is CalendarCaps {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["sync", "external", "share", "change_notification"].every(k => typeof v[k] === "boolean") &&
    ["sub_limit", "share_limit", "sync_interval", "manual_refresh"].every(k => v[k] === null || typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= 0);
}
export async function authority(env: Env, credentials: Credentials): Promise<VerifiedSession | null> {
  const { as, client, clientAuth } = oauthConfiguration(env);
  const response = await oauth.introspectionRequest(as, client, clientAuth, credentials.accessToken, {
    ...oauthRequestOptions(env), additionalParameters: { token_type_hint: "access_token" },
  });
  const status = await oauth.processIntrospectionResponse(as, client, response);
  if (!status.active) return null;
  if (status.client_id !== client.client_id || status.sub !== credentials.sub || typeof status.sid !== "string" || !status.sid ||
      typeof status.exp !== "number" || status.exp * 1000 <= Date.now()) throw new Error("Invalid authority response");
  const caps = status.caps as { calendar?: unknown } | undefined;
  if (!calendarCaps(caps?.calendar) || !["pending", "active", "revoked", "unbound"].includes(String(status.cquBindStatus))) throw new Error("Missing application authority");
  return { user: credentials.user, caps: { calendar: caps.calendar }, cquBindStatus: status.cquBindStatus as VerifiedSession["cquBindStatus"] };
}
export async function resolveApplicationSession(c: Context<SessionEnv>): Promise<VerifiedSession | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await tokenHash(token);
  const row = await c.env.DB.prepare("SELECT payload, expires_at, revision FROM application_session WHERE token_hash = ?").bind(hash).first<{ payload: string; expires_at: number; revision: number }>();
  if (!row || row.expires_at <= Date.now()) return null;
  let credentials = await unseal<Credentials>(c.env, row.payload);
  if (credentials.accessExpiresAt <= Date.now() + 30000) {
    if (!credentials.refreshToken) return null;
    const lease = await c.env.DB.prepare("UPDATE application_session SET refresh_until = ?, revision = revision + 1 WHERE token_hash = ? AND revision = ? AND refresh_until <= ? AND expires_at > ? RETURNING revision")
      .bind(Date.now()+15000, hash, row.revision, Date.now(), Date.now()).first<{ revision: number }>();
    // A concurrent request must not rotate the same refresh token or erase the winner.
    if (!lease) throw new Error("Session refresh in progress");
    try {
      const { as, client, clientAuth } = oauthConfiguration(c.env);
      const response = await oauth.refreshTokenGrantRequest(as, client, clientAuth, credentials.refreshToken, oauthRequestOptions(c.env));
      const tokens = await oauth.processRefreshTokenResponse(as, client, response);
      if (tokens.id_token) {
        await oauth.validateApplicationLevelSignature(as, response, oauthRequestOptions(c.env));
        if (oauth.getValidatedIdTokenClaims(tokens)?.sub !== credentials.sub) throw new Error("Refresh subject mismatch");
      }
      if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.expires_in || tokens.expires_in <= 0) throw new Error("Invalid token response");
      credentials = { ...credentials, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? credentials.refreshToken, accessExpiresAt: Date.now()+tokens.expires_in*1000 };
      const saved = await c.env.DB.prepare("UPDATE application_session SET payload = ?, revision = revision + 1, refresh_until = 0 WHERE token_hash = ? AND revision = ? RETURNING revision")
        .bind(await seal(c.env, credentials), hash, lease.revision).first();
      if (!saved) return null; // Local logout wins over an in-flight refresh.
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
        await c.env.DB.prepare("DELETE FROM application_session WHERE token_hash = ? AND revision = ?").bind(hash, lease.revision).run();
        return null;
      }
      throw error;
    }
  }
  const result = await authority(c.env, credentials);
  if (!result) await c.env.DB.prepare("DELETE FROM application_session WHERE token_hash = ?").bind(hash).run();
  return result;
}
