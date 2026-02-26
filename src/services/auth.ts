import { launch, type BrowserWorker } from "@cloudflare/playwright";

// ── OAuth constants ──────────────────────────────────────────────
const TOKEN_REFRESH_URL = "https://my.cqu.edu.cn/authserver/oauth/token";
const OAUTH_CLIENT_ID = "personal-prod";
const OAUTH_CLIENT_SECRET = "app-a-1234";
const TOKEN_EXPIRY_HOURS = 4;

// ── Browser login constants ──────────────────────────────────────
const LOGIN_URL = "https://sso.cqu.edu.cn/login";
const SUCCESS_URL_PATTERN = "self.cqu.edu.cn/cas-success";
const WORKSPACE_URL = "https://my.cqu.edu.cn/workspace/home";
const FALLBACK_URL = "https://my.cqu.edu.cn/enroll";
const TOKEN_KEY = "cqu_edu_ACCESS_TOKEN";
const REFRESH_TOKEN_KEY = "cqu_edu_REFRESH_TOKEN";
const USERNAME_SELECTOR = "input[placeholder*='统一身份认证号']";
const PASSWORD_SELECTOR = "input[type='password']:visible";
const LOGIN_BUTTON_SELECTOR = ".login-button";
const LOGIN_TIMEOUT_MS = 55_000;
const ANGULAR_RENDER_WAIT = 2_000;
const BUTTON_CLICK_WAIT = 500;
const RETRY_WAIT = 1_000;
const MAX_TOKEN_RETRIES = 5;

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

// ── refreshToken (direct HTTP) ───────────────────────────────────
export async function refreshToken(refreshTokenStr: string): Promise<TokenResult> {
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
    });
  } catch (e) {
    throw new AuthError("UPSTREAM_UNREACHABLE", `Network error: ${e}`);
  }

  if (!response.ok) {
    const code = response.status === 401 ? "TOKEN_EXPIRED" : "UPSTREAM_UNREACHABLE";
    throw new AuthError(code, `Token refresh failed: HTTP ${response.status}`);
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

// ── login (CF Browser Rendering) ─────────────────────────────────
export async function login(
  browser: BrowserWorker,
  username: string,
  password: string,
): Promise<TokenResult> {
  const instance = await launch(browser);
  try {
    const page = await instance.newPage();

    // Navigate to SSO login page
    await page.goto(LOGIN_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(ANGULAR_RENDER_WAIT);

    // Fill credentials
    await page.fill(USERNAME_SELECTOR, username);
    await page.fill(PASSWORD_SELECTOR, password);
    await page.waitForTimeout(BUTTON_CLICK_WAIT);

    // Click login
    await page.click(LOGIN_BUTTON_SELECTOR);

    // Wait for CAS redirect
    try {
      await page.waitForURL(`**/${SUCCESS_URL_PATTERN}**`, {
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch {
      // Check for error message on page
      const errorElem = page.locator(".error-message, .ant-message, .alert").first();
      if (await errorElem.isVisible().catch(() => false)) {
        const errorText = await errorElem.textContent();
        if (errorText) {
          throw new AuthError("INVALID_CREDENTIALS", `Login failed: ${errorText}`);
        }
      }
      throw new AuthError("UPSTREAM_TIMEOUT", `Login timeout, URL: ${page.url()}`);
    }

    // Navigate to workspace to get tokens from localStorage
    await page.goto(WORKSPACE_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(ANGULAR_RENDER_WAIT);

    // Extract tokens with retry
    let accessToken = await getLocalStorageItem(page, TOKEN_KEY);
    let refreshTokenValue = await getLocalStorageItem(page, REFRESH_TOKEN_KEY);

    if (!accessToken) {
      for (let i = 0; i < MAX_TOKEN_RETRIES; i++) {
        await page.waitForTimeout(RETRY_WAIT);
        accessToken = await getLocalStorageItem(page, TOKEN_KEY);
        if (accessToken) {
          refreshTokenValue = await getLocalStorageItem(page, REFRESH_TOKEN_KEY);
          break;
        }
      }
    }

    // Fallback URL
    if (!accessToken) {
      await page.goto(FALLBACK_URL);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(ANGULAR_RENDER_WAIT);
      accessToken = await getLocalStorageItem(page, TOKEN_KEY);
      refreshTokenValue = await getLocalStorageItem(page, REFRESH_TOKEN_KEY);
    }

    if (!accessToken) {
      throw new AuthError("BROWSER_ERROR", "Unable to retrieve access token");
    }

    const expiresAt = new Date(
      Date.now() + TOKEN_EXPIRY_HOURS * 3600 * 1000,
    ).toISOString();

    return {
      accessToken,
      refreshToken: refreshTokenValue ?? "",
      expiresAt,
    };
  } finally {
    await instance.close();
  }
}

// ── Helper ───────────────────────────────────────────────────────
async function getLocalStorageItem(
  page: { evaluate: (fn: string) => Promise<unknown> },
  key: string,
): Promise<string | null> {
  const value = await page.evaluate(`localStorage.getItem('${key}')`);
  if (typeof value === "string") {
    return value.replace(/^"|"$/g, "");
  }
  return null;
}
