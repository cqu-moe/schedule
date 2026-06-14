// ── OAuth constants ──────────────────────────────────────────────
// CQU 公开 OAuth 客户端凭据，从 CQU 官方移动端/Web 前端提取，非本项目私有机密。
// 所有接入 CQU 教务 API 的第三方应用均使用同一组凭据。
const OAUTH_TOKEN_URL = "https://my.cqu.edu.cn/authserver/oauth/token";
const OAUTH_CLIENT_ID = "personal-prod";
const OAUTH_CLIENT_SECRET = "app-a-1234";
const TOKEN_EXPIRY_HOURS = 4;

// ── Error class ──────────────────────────────────────────────────
export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

// ── Types ────────────────────────────────────────────────────────
export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

// ── Exchange constants ──────────────────────────────────────────
const CAS_SERVICE_URL = "https://my.cqu.edu.cn/authserver/authentication/cas";
const OAUTH_AUTHORIZE_URL = "https://my.cqu.edu.cn/authserver/oauth/authorize";
const OAUTH_REDIRECT_URI = "https://my.cqu.edu.cn/workspace/token-index";
const OAUTH_BASIC_AUTH = btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`);
const EXCHANGE_TIMEOUT_MS = 30_000;
// Workers fetch 默认 UA 会被 SSO 识别为机器人，请求须带浏览器 User-Agent。
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── exchangeTicketForCquToken (pure HTTP) ───────────────────────
//
// 输入一张已签发的 CAS service ticket（由 auth.cqu.moe 经 RPC 出），
// 走「ticket → SESSION cookie → OAuth authorization code → bearer token」
// 三步换取 CQU 教务 OAuth token。schedule 本身不再持有任何登录凭据。
export async function exchangeTicketForCquToken(
  ticket: string,
): Promise<TokenResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);

  try {
    // Step 1: Validate CAS ticket → get SESSION cookie
    const casRes = await fetch(
      `${CAS_SERVICE_URL}?ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: controller.signal,
      },
    );
    const sessionCookie = extractCookie(casRes, "SESSION");
    if (!sessionCookie) {
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        "No SESSION cookie from CAS validation",
      );
    }

    // Step 2: OAuth authorize → get authorization code
    const authorizeUrl =
      `${OAUTH_AUTHORIZE_URL}?client_id=${OAUTH_CLIENT_ID}` +
      `&response_type=code&scope=all&state=` +
      `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`;
    const authorizeRes = await fetch(authorizeUrl, {
      headers: { "User-Agent": USER_AGENT, Cookie: sessionCookie },
      redirect: "manual",
      signal: controller.signal,
    });
    const authLocation = authorizeRes.headers.get("location") ?? "";
    const codeMatch = authLocation.match(/code=([^&]+)/);
    if (!codeMatch) {
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        "No authorization code in OAuth redirect",
      );
    }

    // Step 3: Exchange code for tokens
    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${OAUTH_BASIC_AUTH}`,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        code: codeMatch[1],
        redirect_uri: OAUTH_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
      signal: controller.signal,
    });

    if (!tokenRes.ok) {
      let detail = `HTTP ${tokenRes.status}`;
      try {
        const errBody = (await tokenRes.json()) as OAuthTokenResponse;
        detail = errBody.error_description ?? errBody.error ?? detail;
      } catch {
        // non-JSON error response, keep defaults
      }
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        `Token exchange failed: ${detail}`,
      );
    }

    const data = (await tokenRes.json()) as OAuthTokenResponse;
    if (!data.access_token) {
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        "No access_token in token response",
      );
    }

    const expiresIn = data.expires_in ?? TOKEN_EXPIRY_HOURS * 3600;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? "",
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new AuthError("UPSTREAM_TIMEOUT", "Ticket exchange timeout");
    }
    throw new AuthError(
      "UPSTREAM_UNREACHABLE",
      `Ticket exchange failed: ${e}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function extractCookie(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]+)`));
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}
