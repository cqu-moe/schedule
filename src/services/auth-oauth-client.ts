import { AUTH_BASE } from "./oauth-constants";
import type { Env } from "../types";

// ── Endpoints ────────────────────────────────────────────────────
const TOKEN_URL = `${AUTH_BASE}/api/auth/oauth2/token`;
const USERINFO_URL = `${AUTH_BASE}/api/auth/oauth2/userinfo`;
const CQU_STATUS_URL = `${AUTH_BASE}/api/cqu/status`;
const SERVICE_TICKET_URL = `${AUTH_BASE}/api/cqu/service-ticket?service=jwxt`;

const REQUEST_TIMEOUT_MS = 30_000;

// ── Error classification ─────────────────────────────────────────
//
// Failures are bucketed so the refresh cron can decide what to do:
//   - "user":      the user must re-OAuth (their grant/refresh token is dead).
//   - "operator":  our client/scope is misconfigured — no user action helps.
//   - "transient": upstream/network hiccup — safe to retry later.
export type PermanentKind = "user" | "operator" | "transient";

export class AuthOAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public kind: PermanentKind,
  ) {
    super(message);
    this.name = "AuthOAuthError";
  }
}

// ── Types ────────────────────────────────────────────────────────
export interface AuthTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn: number;
}

export type CquStatus = "unbound" | "active" | "expired" | "error";

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface UserInfoResponse {
  sub?: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
}

interface CquStatusResponse {
  status?: CquStatus;
  studentId?: string;
}

interface ServiceTicketResponse {
  ticket?: string;
}

// ── fetch helper (30s timeout, transient on abort/network) ───────
//
// Mirrors src/services/auth.ts's AbortController timeout pattern. On
// AbortError → transient "timeout"; on any other network error →
// transient "network_error".
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new AuthOAuthError("timeout", `Request to ${url} timed out`, "transient");
    }
    throw new AuthOAuthError(
      "network_error",
      `Network error calling ${url}: ${e}`,
      "transient",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort JSON parse; returns undefined on non-JSON bodies. */
async function safeJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

// ── Token endpoint error mapping ─────────────────────────────────
//
// OAuth error code → kind:
//   invalid_grant                  → "user"     (refresh token revoked/expired; re-OAuth)
//   invalid_client / invalid_scope → "operator" (client_id/secret or scope misconfig)
//   HTTP 5xx                       → "transient"
//   other 4xx                      → "user"     (safe default: assume the grant is no
//                                                longer usable and re-auth is required;
//                                                avoids silently dropping a user whose
//                                                token died for an unmapped reason)
function classifyTokenError(
  status: number,
  body: OAuthTokenResponse | undefined,
): AuthOAuthError {
  const code = body?.error ?? `http_${status}`;
  const message = body?.error_description ?? body?.error ?? `HTTP ${status}`;

  if (status >= 500) {
    return new AuthOAuthError(code, message, "transient");
  }
  if (code === "invalid_grant") {
    return new AuthOAuthError(code, message, "user");
  }
  if (code === "invalid_client" || code === "invalid_scope") {
    return new AuthOAuthError(code, message, "operator");
  }
  return new AuthOAuthError(code, message, "user");
}

async function postToken(
  env: Env,
  params: Record<string, string>,
): Promise<AuthTokenSet> {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: env.AUTH_OAUTH_CLIENT_ID,
      client_secret: env.AUTH_OAUTH_CLIENT_SECRET,
      ...params,
    }).toString(),
  });

  if (!response.ok) {
    const body = await safeJson<OAuthTokenResponse>(response);
    throw classifyTokenError(response.status, body);
  }

  const data = (await safeJson<OAuthTokenResponse>(response)) ?? {};
  if (!data.access_token) {
    throw new AuthOAuthError(
      "invalid_response",
      "Token response missing access_token",
      "transient",
    );
  }

  return {
    accessToken: data.access_token,
    // Refresh-token rotation may or may not return a new value. We pass through
    // the response value, defaulting to "" — the caller treats "" as "unchanged"
    // and keeps the existing stored refresh token.
    refreshToken: data.refresh_token ?? "",
    idToken: data.id_token,
    expiresIn: data.expires_in ?? 0,
  };
}

// ── Public API ───────────────────────────────────────────────────

/** Exchange an authorization code (with PKCE verifier) for a token set. */
export function exchangeCode(
  env: Env,
  args: { code: string; redirectUri: string; codeVerifier: string },
): Promise<AuthTokenSet> {
  return postToken(env, {
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
}

/** Exchange a refresh token for a fresh token set. */
export function refreshAuthToken(
  env: Env,
  refreshToken: string,
): Promise<AuthTokenSet> {
  return postToken(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/**
 * Fetch the OIDC userinfo. Called during the interactive callback; non-OK
 * responses are transient (the route maps them to a user-facing error).
 * Guarantees at least { sub }.
 */
export async function getUserInfo(
  accessToken: string,
): Promise<{ sub: string }> {
  const response = await fetchWithTimeout(USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new AuthOAuthError(
      "userinfo_failed",
      `Userinfo request failed: HTTP ${response.status}`,
      "transient",
    );
  }

  const data = await safeJson<UserInfoResponse>(response);
  if (!data?.sub) {
    throw new AuthOAuthError(
      "userinfo_no_sub",
      "Userinfo response missing sub",
      "transient",
    );
  }
  return { sub: data.sub };
}

/**
 * Fetch the user's CQU binding status. Non-OK responses are transient (the
 * interactive route maps them to a user-facing error).
 */
export async function getCquStatus(
  accessToken: string,
): Promise<{ status: CquStatus; studentId?: string }> {
  const response = await fetchWithTimeout(CQU_STATUS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new AuthOAuthError(
      "cqu_status_failed",
      `CQU status request failed: HTTP ${response.status}`,
      "transient",
    );
  }

  const data = (await safeJson<CquStatusResponse>(response)) ?? {};
  return { status: data.status ?? "error", studentId: data.studentId };
}

/**
 * Fetch a CQU jwxt CAS service ticket on behalf of the user. A 403 means our
 * client lacks the cqu:ticket:jwxt scope (operator misconfig); any other
 * failure (incl. a body without a ticket) is transient. Returns the ticket.
 */
export async function getServiceTicket(
  accessToken: string,
): Promise<string> {
  const response = await fetchWithTimeout(SERVICE_TICKET_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (response.status === 403) {
    throw new AuthOAuthError(
      "scope_forbidden",
      "Missing cqu:ticket:jwxt scope on the OAuth client",
      "operator",
    );
  }
  if (!response.ok) {
    throw new AuthOAuthError(
      "service_ticket_failed",
      `Service ticket request failed: HTTP ${response.status}`,
      "transient",
    );
  }

  const data = await safeJson<ServiceTicketResponse>(response);
  if (!data?.ticket) {
    throw new AuthOAuthError(
      "service_ticket_no_ticket",
      "Service ticket response missing ticket",
      "transient",
    );
  }
  return data.ticket;
}
