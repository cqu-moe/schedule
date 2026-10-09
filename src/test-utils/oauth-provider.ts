import { vi } from "vitest";
import type { VerifiedSession } from "../services/auth-rpc";

const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export async function oauthProvider(session: VerifiedSession) {
  const origin = "https://auth.test";
  const issuer = `${origin}/api/auth`;
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test-signing-key", alg: "EdDSA", use: "sig" };
  const codes = new Map<string, URL>();
  const tokens = new Map<string, number>();
  const refreshTokens = new Set<string>();
  let active = true;
  const faults = { claims: {} as Record<string, unknown>, corruptSignature: false, authorityUnavailable: false, authority: {} as Record<string, unknown> };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${encode(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", kid: jwk.kid })))}.${encode(new TextEncoder().encode(JSON.stringify(claims)))}`;
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(input)));
    if (faults.corruptSignature) signature[0] ^= 255;
    return `${input}.${encode(signature)}`;
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) throw new Error(`Unexpected network request: ${url.origin}`);
    if (url.pathname.endsWith("/jwks")) return json({ keys: [jwk] });
    if (url.pathname.endsWith("/userinfo")) return json({ sub: session.user.id, name: session.user.name, email: session.user.email });
    if (decodeURIComponent(atob((request.headers.get("authorization") ?? "").replace(/^Basic /, ""))) !== "calendar:test-secret") return json({ error: "invalid_client" }, 401);
    const body = new URLSearchParams(await request.text());
    if (url.pathname.endsWith("/introspect") && faults.authorityUnavailable) return new Response("Unavailable", { status: 503 });
    if (url.pathname.endsWith("/introspect")) return json(active && (tokens.get(body.get("token")!) ?? 0) > Date.now() ? {
      active: true, sub: session.user.id, sid: "central-device", client_id: "calendar", exp: Math.floor(Date.now() / 1000) + 600,
      scope: "openid profile email offline_access", caps: session.caps, cquBindStatus: session.cquBindStatus ?? "active", ...faults.authority,
    } : { active: false });
    if (body.get("grant_type") === "refresh_token") {
      if (!active || !refreshTokens.delete(body.get("refresh_token")!)) return json({ error: "invalid_grant" }, 400);
      const access = crypto.randomUUID(), refresh = crypto.randomUUID(); tokens.set(access, Date.now() + 600000); refreshTokens.add(refresh);
      return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 600 });
    }
    const code = body.get("code")!;
    const authorize = codes.get(code);
    codes.delete(code);
    if (!authorize || body.get("redirect_uri") !== authorize.searchParams.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
    const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier")!))));
    if (challenge !== authorize.searchParams.get("code_challenge")) return json({ error: "invalid_grant" }, 400);
    const access = crypto.randomUUID(), refresh = crypto.randomUUID(); tokens.set(access, Date.now() + 600000); refreshTokens.add(refresh);
    return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 600,
      id_token: await sign({ iss: issuer, aud: "calendar", sub: session.user.id, nonce: authorize.searchParams.get("nonce"), iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600, ...faults.claims }),
    });
  });
  return {
    origin, issuer, session, faults,
    revoke() { active = false; },
    restore() { spy.mockRestore(); },
    authorize(location: string) {
      const url = new URL(location);
      if (url.origin !== origin || url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("nonce")) throw new Error("Invalid authorization request");
      const code = crypto.randomUUID(); codes.set(code, url);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("iss", issuer);
      return callback;
    },
  };
}
