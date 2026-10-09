import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import * as oauth from "oauth4webapi";
import type { Env } from "../types";
import { authority, cookieOptions, oauthConfiguration, oauthRequestOptions, seal, unseal, SESSION_COOKIE, TRANSACTION_COOKIE, SESSION_LIFETIME, tokenHash, type Credentials } from "../services/application-session";
import { errorResponse } from "../utils/error";

const app = new Hono<{ Bindings: Env }>();
interface Transaction { verifier: string; nonce: string; returnTo: string }
function returnPath(value: string | undefined, origin: string) {
  try { const url = new URL(value || "/dashboard", origin); return url.origin === new URL(origin).origin ? url.pathname + url.search + url.hash : "/dashboard"; }
  catch { return "/dashboard"; }
}
app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); await next(); });
app.get("/login", async c => {
  const { as, client, redirectUri } = oauthConfiguration(c.env);
  const state = oauth.generateRandomState(), browser = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier(), nonce = oauth.generateRandomNonce();
  await c.env.DB.prepare("DELETE FROM application_session WHERE expires_at <= ?").bind(Date.now()).run();
  await c.env.DB.prepare("DELETE FROM application_login WHERE expires_at <= ?").bind(Date.now()).run();
  await c.env.DB.prepare("INSERT INTO application_login (state_hash, browser_hash, payload, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await tokenHash(state), await tokenHash(browser), await seal(c.env, { verifier, nonce, returnTo: returnPath(c.req.query("returnTo"), c.env.PUBLIC_URL) }), Date.now()+600000).run();
  const url = new URL(as.authorization_endpoint!);
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: "openid profile email offline_access", state, nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" }).toString();
  setCookie(c, TRANSACTION_COOKIE, browser, { ...cookieOptions, maxAge: 600 });
  return c.redirect(url.href);
});
export async function completeLogin(c: Context<{ Bindings: Env }>) {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const state = c.req.query("state"), browser = getCookie(c, TRANSACTION_COOKIE);
  if (!state || !browser) return errorResponse("INVALID_LOGIN", "登录验证已失效，请重新登录", 400);
  const row = await c.env.DB.prepare("DELETE FROM application_login WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING payload")
    .bind(await tokenHash(state), await tokenHash(browser), Date.now()).first<{ payload: string }>();
  if (!row) return errorResponse("INVALID_LOGIN", "登录验证已失效，请重新登录", 400);
  try {
    const tx = await unseal<Transaction>(c.env, row.payload);
    const { as, client, clientAuth, redirectUri } = oauthConfiguration(c.env);
    const params = oauth.validateAuthResponse(as, client, new URL(c.req.url), state);
    const response = await oauth.authorizationCodeGrantRequest(as, client, clientAuth, params, redirectUri, tx.verifier, oauthRequestOptions(c.env));
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: tx.nonce, requireIdToken: true });
    await oauth.validateApplicationLevelSignature(as, response, oauthRequestOptions(c.env));
    if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.expires_in || tokens.expires_in <= 0) throw new Error("Invalid token response");
    const claims = oauth.getValidatedIdTokenClaims(tokens)!;
    const profile = await oauth.processUserInfoResponse(as, client, claims.sub, await oauth.userInfoRequest(as, client, tokens.access_token, oauthRequestOptions(c.env)));
    const credentials: Credentials = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessExpiresAt: Date.now()+(tokens.expires_in ?? 0)*1000, sub: claims.sub,
      user: { id: claims.sub, name: typeof profile.name === "string" ? profile.name : "", email: typeof profile.email === "string" ? profile.email : "", role: "user" } };
    if (!await authority(c.env, credentials)) throw new Error("Inactive central session");
    const token = oauth.generateRandomState();
    const old = getCookie(c, SESSION_COOKIE);
    if (old) await c.env.DB.prepare("DELETE FROM application_session WHERE token_hash = ?").bind(await tokenHash(old)).run();
    await c.env.DB.prepare("INSERT INTO application_session (token_hash, payload, expires_at) VALUES (?, ?, ?)")
      .bind(await tokenHash(token), await seal(c.env, credentials), Date.now()+SESSION_LIFETIME*1000).run();
    setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_LIFETIME });
    deleteCookie(c, TRANSACTION_COOKIE, cookieOptions);
    return c.redirect(tx.returnTo);
  } catch {
    deleteCookie(c, TRANSACTION_COOKIE, cookieOptions);
    return errorResponse("INVALID_LOGIN", "登录验证失败，请重新登录", 400);
  }
}
app.post("/logout", async c => {
  if (c.req.header("origin") !== new URL(c.env.PUBLIC_URL).origin) return errorResponse("FORBIDDEN", "请求来源无效", 403);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM application_session WHERE token_hash = ?").bind(await tokenHash(token)).run();
  deleteCookie(c, SESSION_COOKIE, cookieOptions);
  deleteCookie(c, TRANSACTION_COOKIE, cookieOptions);
  return c.redirect("/signed-out", 303);
});
export default app;
