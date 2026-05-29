import { Hono } from "hono";
import type { Env } from "../types";
import { rateLimit } from "../middleware/rate-limit";
import { errorResponse } from "../utils/error";
import {
  AUTH_BASE,
  OAUTH_SCOPE,
  OAUTH_TX_COOKIE,
  OAUTH_TX_TTL_MS,
  OAUTH_COOKIE_PATH,
  resolveOrigin,
} from "../services/oauth-constants";
import { generatePkce, generateState, sealTx } from "../services/oauth-tx";

const app = new Hono<{ Bindings: Env }>();

// GET /api/v1/auth/oauth/login — start Authorization Code + PKCE against auth.cqu.moe
app.get("/login", rateLimit("UNAUTH_LIMITER"), async (c) => {
  // resolveOrigin calls new URL(...) which throws on a malformed URL; never 500.
  let origin: string | null;
  try {
    origin = resolveOrigin(c.req.url);
  } catch {
    origin = null;
  }
  if (!origin) {
    return errorResponse("BAD_REQUEST", "unsupported host", 400);
  }

  const { verifier, challenge } = await generatePkce();
  const state = generateState();

  const sealed = await sealTx(
    { state, verifier, origin },
    c.env.OAUTH_STATE_KEY,
    Date.now() + OAUTH_TX_TTL_MS,
  );

  // Secure only on https — the browser drops a Secure cookie over http://localhost.
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${OAUTH_TX_COOKIE}=${sealed}; HttpOnly${secure}; SameSite=Lax; Path=${OAUTH_COOKIE_PATH}; Max-Age=600`,
  );

  const params = new URLSearchParams({
    client_id: c.env.AUTH_OAUTH_CLIENT_ID,
    redirect_uri: `${origin}/api/v1/auth/oauth/callback`,
    response_type: "code",
    scope: OAUTH_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return c.redirect(`${AUTH_BASE}/api/auth/oauth2/authorize?${params.toString()}`, 302);
});

export default app;
