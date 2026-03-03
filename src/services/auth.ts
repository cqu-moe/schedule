import { createCipheriv } from "node:crypto";

// ── OAuth constants ──────────────────────────────────────────────
// CQU 公开 OAuth 客户端凭据，从 CQU 官方移动端/Web 前端提取，非本项目私有机密。
// 所有接入 CQU 教务 API 的第三方应用均使用同一组凭据。
const TOKEN_REFRESH_URL = "https://my.cqu.edu.cn/authserver/oauth/token";
const OAUTH_CLIENT_ID = "personal-prod";
const OAUTH_CLIENT_SECRET = "app-a-1234";
const TOKEN_EXPIRY_HOURS = 4;
const REFRESH_TIMEOUT_MS = 30_000;

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

// ── AES-ECB encryption helper ────────────────────────────────────
export function encryptAesEcb(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  let algo: string;
  if (key.length <= 16) {
    algo = "aes-128-ecb";
  } else if (key.length <= 24) {
    algo = "aes-192-ecb";
  } else {
    algo = "aes-256-ecb";
  }
  const cipher = createCipheriv(algo, key, "");
  return Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

// ── HTML parsing helper ─────────────────────────────────────────
export function parseLoginPage(html: string): {
  execution: string;
  croypto: string;
  captchaId: string | null;
} {
  const execution = extractElementValue(html, "login-page-flowkey");
  const croypto = extractElementValue(html, "login-croypto");
  const captchaId = extractElementValue(html, "captchaId");

  if (!execution || !croypto) {
    throw new AuthError(
      "UPSTREAM_UNREACHABLE",
      "Failed to parse SSO login page (missing execution or croypto)",
    );
  }

  return { execution, croypto, captchaId };
}

function extractElementValue(html: string, id: string): string | null {
  const tagRegex = new RegExp(`<[^>]*\\bid="${id}"[^>]*>([^<]*)`, "s");
  const match = tagRegex.exec(html);
  if (!match) return null;

  const valueMatch = match[0].match(/\bvalue="([^"]*)"/);
  if (valueMatch) return valueMatch[1];

  const innerText = match[1]?.trim();
  return innerText || null;
}

// ── refreshToken (direct HTTP) ───────────────────────────────────
export async function refreshToken(refreshTokenStr: string): Promise<TokenResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(TOKEN_REFRESH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshTokenStr,
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new AuthError("UPSTREAM_TIMEOUT", "Token refresh timeout");
    }
    throw new AuthError("UPSTREAM_UNREACHABLE", `Network error: ${e}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let code = "UPSTREAM_UNREACHABLE";
    let detail = `HTTP ${response.status}`;
    try {
      const body: any = await response.json();
      detail = body.error_description ?? body.error ?? detail;
      if (response.status === 401 || body.error === "invalid_grant") {
        code = "TOKEN_EXPIRED";
      }
    } catch {
      // non-JSON error response, keep defaults
    }
    throw new AuthError(code, `Token refresh failed: ${detail}`);
  }

  const data: any = await response.json();
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new AuthError("UPSTREAM_UNREACHABLE", "No access_token in refresh response");
  }

  const expiresIn = data.expires_in ?? TOKEN_EXPIRY_HOURS * 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  return {
    accessToken,
    refreshToken: data.refresh_token ?? refreshTokenStr,
    expiresAt,
  };
}

// ── Login constants ─────────────────────────────────────────────
const SSO_BASE_URL = "https://sso.cqu.edu.cn";
const SSO_LOGIN_URL = `${SSO_BASE_URL}/login`;
const CAS_SERVICE_URL =
  "https://my.cqu.edu.cn/authserver/authentication/cas";
const OAUTH_AUTHORIZE_URL =
  "https://my.cqu.edu.cn/authserver/oauth/authorize";
const OAUTH_REDIRECT_URI =
  "https://my.cqu.edu.cn/workspace/token-index";
const OAUTH_BASIC_AUTH = "cGVyc29uYWwtcHJvZDphcHAtYS0xMjM0";
const LOGIN_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── login (pure HTTP) ───────────────────────────────────────────
export async function login(
  username: string,
  password: string,
): Promise<TokenResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

  try {
    // Step 1: GET login page → extract execution, croypto
    const loginPageRes = await fetch(
      `${SSO_LOGIN_URL}?service=${encodeURIComponent(CAS_SERVICE_URL)}`,
      { headers: { "User-Agent": USER_AGENT }, signal: controller.signal },
    );
    const loginPageHtml = await loginPageRes.text();
    const { execution, croypto } = parseLoginPage(loginPageHtml);

    // Forward cookies from login page (e.g. JSESSIONID)
    const loginPageCookies = extractAllCookies(loginPageRes);

    // Step 2: Encrypt password, POST login form
    const encryptedPassword = encryptAesEcb(password, croypto);
    const captchaPayload = encryptAesEcb("{}", croypto);

    const step2Headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    };
    if (loginPageCookies) {
      step2Headers["Cookie"] = loginPageCookies;
    }

    const loginRes = await fetch(
      `${SSO_LOGIN_URL}?service=${encodeURIComponent(CAS_SERVICE_URL)}`,
      {
        method: "POST",
        headers: step2Headers,
        body: new URLSearchParams({
          username,
          password: encryptedPassword,
          type: "UsernamePassword",
          execution,
          _eventId: "submit",
          geolocation: "",
          croypto,
          captcha_payload: captchaPayload,
        }),
        redirect: "manual",
        signal: controller.signal,
      },
    );

    if (loginRes.status === 401) {
      // Check if CAPTCHA is now required
      try {
        const captchaCountRes = await fetch(
          `${SSO_BASE_URL}/api/protected/user/findCaptchaCount/${username}`,
          { headers: { "User-Agent": USER_AGENT }, signal: controller.signal },
        );
        if (captchaCountRes.ok) {
          const captchaData: any = await captchaCountRes.json();
          if (captchaData.data === 0) {
            throw new AuthError(
              "CAPTCHA_REQUIRED",
              "SSO login requires CAPTCHA verification due to too many failed attempts",
            );
          }
        }
      } catch (e) {
        if (e instanceof AuthError) throw e;
        // Ignore captcha check errors, fall through to credentials error
      }
      const html = await loginRes.text();
      const errorMsg = extractLoginError(html) ?? "Invalid credentials";
      throw new AuthError("INVALID_CREDENTIALS", `Login failed: ${errorMsg}`);
    }
    if (loginRes.status !== 302) {
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        `Unexpected login response: HTTP ${loginRes.status}`,
      );
    }

    const location = loginRes.headers.get("location") ?? "";
    const ticketMatch = location.match(/ticket=([^&]+)/);
    if (!ticketMatch) {
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        "No ticket in login redirect",
      );
    }
    const ticket = ticketMatch[1];

    // Forward CASTGC cookie from login response
    const castgcCookie = extractCookie(loginRes, "CASTGC");
    const step3Headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (castgcCookie) {
      step3Headers["Cookie"] = castgcCookie;
    }

    // Step 3: Validate CAS ticket → get SESSION cookie
    const casRes = await fetch(
      `${CAS_SERVICE_URL}?ticket=${encodeURIComponent(ticket)}`,
      {
        headers: step3Headers,
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

    // Step 4: OAuth authorize → get authorization code
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

    // Step 5: Exchange code for tokens
    const tokenRes = await fetch(TOKEN_REFRESH_URL, {
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
        const errBody: any = await tokenRes.json();
        detail = errBody.error_description ?? errBody.error ?? detail;
      } catch {
        // non-JSON error response, keep defaults
      }
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        `Token exchange failed: ${detail}`,
      );
    }

    const data: any = await tokenRes.json();
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
  } catch (e: any) {
    if (e instanceof AuthError) throw e;
    if (e?.name === "AbortError") {
      throw new AuthError("UPSTREAM_TIMEOUT", "Login timeout");
    }
    throw new AuthError("UPSTREAM_UNREACHABLE", `Login failed: ${e}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function extractCookie(response: Response, name: string): string | null {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : null;
}

function extractAllCookies(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookies = [...setCookie.matchAll(/([^=;\s,]+)=([^;,]+)/g)]
    .filter(m => !["Path", "Domain", "Expires", "Max-Age", "SameSite"].includes(m[1]))
    .map(m => `${m[1]}=${m[2]}`);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

function extractLoginError(html: string): string | null {
  const match = html.match(/id="login-error-msg"[^>]*>([^<]*)</);
  return match?.[1]?.trim() || null;
}
