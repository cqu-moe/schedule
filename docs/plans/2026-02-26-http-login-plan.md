# HTTP Login Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Playwright Browser Rendering login with pure HTTP CAS→OAuth flow.

**Architecture:** 5-step HTTP chain (SSO login page → POST login → CAS ticket validate → OAuth authorize → token exchange) using `node:crypto` for AES-ECB, regex for HTML parsing, and `redirect: 'manual'` for cookie/redirect tracking. All changes in `src/services/auth.ts` and its callers.

**Tech Stack:** `node:crypto` (AES-ECB via `nodejs_compat`), Cloudflare Workers fetch API

---

### Task 1: AES-ECB encryption helper

**Files:**
- Modify: `src/services/auth.ts` (add helper at top, before `login`)
- Modify: `src/services/auth.test.ts` (add test block)

**Step 1: Write the failing test**

Add to `src/services/auth.test.ts`:

```typescript
import { refreshToken, login, AuthError, encryptAesEcb } from "./auth";

describe("encryptAesEcb", () => {
  it("should encrypt plaintext with AES-128-ECB and return base64", () => {
    // 16-byte key (AES-128) as base64
    const keyBase64 = Buffer.from("0123456789abcdef").toString("base64");
    const result = encryptAesEcb("hello", keyBase64);
    // Result should be a valid base64 string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Verify it's valid base64
    expect(() => Buffer.from(result, "base64")).not.toThrow();
  });

  it("should produce consistent output for same input", () => {
    const keyBase64 = Buffer.from("0123456789abcdef").toString("base64");
    const r1 = encryptAesEcb("test", keyBase64);
    const r2 = encryptAesEcb("test", keyBase64);
    expect(r1).toBe(r2);
  });

  it("should produce different output for different keys", () => {
    const key1 = Buffer.from("0123456789abcdef").toString("base64");
    const key2 = Buffer.from("fedcba9876543210").toString("base64");
    expect(encryptAesEcb("test", key1)).not.toBe(encryptAesEcb("test", key2));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --reporter=verbose src/services/auth.test.ts`
Expected: FAIL — `encryptAesEcb` is not exported from `./auth`

**Step 3: Write minimal implementation**

Add to `src/services/auth.ts` (after imports, before `refreshToken`):

```typescript
import { createCipheriv } from "node:crypto";

export function encryptAesEcb(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const algo =
    key.length <= 16
      ? "aes-128-ecb"
      : key.length <= 24
        ? "aes-192-ecb"
        : "aes-256-ecb";
  const cipher = createCipheriv(algo, key, null);
  return Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --reporter=verbose src/services/auth.test.ts`
Expected: All `encryptAesEcb` tests PASS

**Step 5: Commit**

```
git add src/services/auth.ts src/services/auth.test.ts
git commit -m "feat(auth): add AES-ECB encryption helper for SSO password"
```

---

### Task 2: HTML parsing helper

**Files:**
- Modify: `src/services/auth.ts`
- Modify: `src/services/auth.test.ts`

**Step 1: Write the failing test**

Add to `src/services/auth.test.ts`:

```typescript
import { refreshToken, login, AuthError, encryptAesEcb, parseLoginPage } from "./auth";

describe("parseLoginPage", () => {
  const sampleHtml = `
    <html>
      <input type="hidden" id="login-page-flowkey" value="e1s1" />
      <span id="login-croypto">d9XYfl9siLfxBU+Ze1LxSQ==</span>
      <input id="captchaId" value="cap-123" />
    </html>
  `;

  it("should extract execution, croypto, and captchaId", () => {
    const result = parseLoginPage(sampleHtml);
    expect(result.execution).toBe("e1s1");
    expect(result.croypto).toBe("d9XYfl9siLfxBU+Ze1LxSQ==");
    expect(result.captchaId).toBe("cap-123");
  });

  it("should return null captchaId when not present", () => {
    const html = `
      <html>
        <input type="hidden" id="login-page-flowkey" value="e1s1" />
        <span id="login-croypto">key123==</span>
      </html>
    `;
    const result = parseLoginPage(html);
    expect(result.execution).toBe("e1s1");
    expect(result.croypto).toBe("key123==");
    expect(result.captchaId).toBeNull();
  });

  it("should throw AuthError when execution is missing", () => {
    const html = `<html><span id="login-croypto">key==</span></html>`;
    expect(() => parseLoginPage(html)).toThrow(AuthError);
  });

  it("should throw AuthError when croypto is missing", () => {
    const html = `<html><input id="login-page-flowkey" value="e1s1" /></html>`;
    expect(() => parseLoginPage(html)).toThrow(AuthError);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --reporter=verbose src/services/auth.test.ts`
Expected: FAIL — `parseLoginPage` is not exported

**Step 3: Write minimal implementation**

Add to `src/services/auth.ts` (after `encryptAesEcb`):

```typescript
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

  // Try value attribute within the matched tag
  const valueMatch = match[0].match(/\bvalue="([^"]*)"/);
  if (valueMatch) return valueMatch[1];

  // Fall back to inner text content
  const innerText = match[1]?.trim();
  return innerText || null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --reporter=verbose src/services/auth.test.ts`
Expected: All `parseLoginPage` tests PASS

**Step 5: Commit**

```
git add src/services/auth.ts src/services/auth.test.ts
git commit -m "feat(auth): add login page HTML parser for CAS parameters"
```

---

### Task 3: Rewrite login() to pure HTTP

**Files:**
- Modify: `src/services/auth.ts` (replace `login` function entirely)
- Modify: `src/services/auth.test.ts` (replace login test block entirely)

**Step 1: Write the failing tests**

Replace the entire `describe("login", ...)` block and the Playwright mock at the top of `src/services/auth.test.ts`.

Remove these lines from the top of the test file:
- The `vi.hoisted` block (lines 5-9)
- The `vi.mock("@cloudflare/playwright", ...)` block (lines 12-14)
- The `createMockPage` helper (lines 36-80)

Add new login test helper and tests:

```typescript
// ── Login flow mock helpers ─────────────────────────────────────

const SAMPLE_LOGIN_HTML = `
<html>
  <input type="hidden" id="login-page-flowkey" value="e1s1" />
  <span id="login-croypto">${Buffer.from("0123456789abcdef").toString("base64")}</span>
</html>
`;

const SAMPLE_ERROR_HTML = `
<html><span id="login-error-msg">用户名或密码错误</span></html>
`;

/** Create a sequential mock fetch for the 5-step login flow. */
function createLoginFetchMock(overrides: {
  loginPageHtml?: string;
  loginStatus?: number;
  loginLocation?: string;
  loginBody?: string;
  casStatus?: number;
  casCookie?: string;
  authorizeStatus?: number;
  authorizeLocation?: string;
  tokenStatus?: number;
  tokenBody?: object;
} = {}) {
  const {
    loginPageHtml = SAMPLE_LOGIN_HTML,
    loginStatus = 302,
    loginLocation = "https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-test123",
    loginBody = "",
    casStatus = 302,
    casCookie = "SESSION=test-session; Path=/",
    authorizeStatus = 302,
    authorizeLocation = "https://my.cqu.edu.cn/workspace/token-index?code=test-code&state=",
    tokenStatus = 200,
    tokenBody = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 14400 },
  } = overrides;

  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    callIndex++;
    switch (callIndex) {
      case 1: // GET login page
        return Promise.resolve(new Response(loginPageHtml, { status: 200 }));
      case 2: // POST login
        return Promise.resolve(
          new Response(loginBody, {
            status: loginStatus,
            headers: loginStatus === 302
              ? { Location: loginLocation }
              : { "Content-Type": "text/html" },
          }),
        );
      case 3: // GET CAS validate
        return Promise.resolve(
          new Response(null, {
            status: casStatus,
            headers: { "Set-Cookie": casCookie, Location: "/workspace/cas" },
          }),
        );
      case 4: // GET OAuth authorize
        return Promise.resolve(
          new Response(null, {
            status: authorizeStatus,
            headers: { Location: authorizeLocation },
          }),
        );
      case 5: // POST token exchange
        return Promise.resolve(
          new Response(JSON.stringify(tokenBody), {
            status: tokenStatus,
            headers: { "Content-Type": "application/json" },
          }),
        );
      default:
        return Promise.reject(new Error(`Unexpected fetch call #${callIndex}`));
    }
  });
}

// ── login tests ─────────────────────────────────────────────────

describe("login", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return TokenResult on successful 5-step login", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    globalThis.fetch = createLoginFetchMock();

    const result = await login("user1", "pass1");

    expect(result.accessToken).toBe("test-access");
    expect(result.refreshToken).toBe("test-refresh");
    expect(result.expiresAt).toBe(new Date(now + 14400 * 1000).toISOString());
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
  });

  it("should throw INVALID_CREDENTIALS on 401", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginStatus: 401,
      loginBody: SAMPLE_ERROR_HTML,
    });

    try {
      await login("bad-user", "bad-pass");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("INVALID_CREDENTIALS");
      expect(e.message).toContain("用户名或密码错误");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE when login page is unparseable", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginPageHtml: "<html>broken page</html>",
    });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE when no ticket in redirect", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginLocation: "https://my.cqu.edu.cn/authserver/authentication/cas",
    });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No ticket");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose src/services/auth.test.ts`
Expected: FAIL — `login` still expects `BrowserWorker` as first argument

**Step 3: Replace login() implementation**

In `src/services/auth.ts`, replace everything from `// ── Browser login constants` through the end of file with the new HTTP implementation.

Remove:
- Line 1: `import { launch, type BrowserWorker, type Page } from "@cloudflare/playwright";`
- Lines 11-24: All browser login constants (`LOGIN_URL` through `MAX_TOKEN_RETRIES`)
- Lines 104-105: `ERROR_SELECTOR`
- Lines 107-270: Old `login()` function and `getLocalStorageItem` helper

Add new login constants and implementation:

```typescript
// ── Login constants ─────────────────────────────────────────────
const SSO_LOGIN_URL = "https://sso.cqu.edu.cn/login";
const CAS_SERVICE_URL =
  "https://my.cqu.edu.cn/authserver/authentication/cas";
const OAUTH_AUTHORIZE_URL =
  "https://my.cqu.edu.cn/authserver/oauth/authorize";
const OAUTH_REDIRECT_URI =
  "https://my.cqu.edu.cn/workspace/token-index";
const OAUTH_BASIC_AUTH = "cGVyc29uYWwtcHJvZDphcHAtYS0xMjM0";
const LOGIN_TIMEOUT_MS = 30_000;

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
      { signal: controller.signal },
    );
    const loginPageHtml = await loginPageRes.text();
    const { execution, croypto } = parseLoginPage(loginPageHtml);

    // Step 2: Encrypt password, POST login form
    const encryptedPassword = encryptAesEcb(password, croypto);
    const captchaPayload = encryptAesEcb("{}", croypto);

    const loginRes = await fetch(
      `${SSO_LOGIN_URL}?service=${encodeURIComponent(CAS_SERVICE_URL)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

    // Step 3: Validate CAS ticket → get SESSION cookie
    const casRes = await fetch(`${CAS_SERVICE_URL}?ticket=${ticket}`, {
      redirect: "manual",
      signal: controller.signal,
    });
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
      headers: { Cookie: sessionCookie },
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
      throw new AuthError(
        "UPSTREAM_UNREACHABLE",
        `Token exchange failed: HTTP ${tokenRes.status}`,
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

function extractLoginError(html: string): string | null {
  const match = html.match(/id="login-error-msg"[^>]*>([^<]*)</);
  return match?.[1]?.trim() || null;
}
```

Note: `TOKEN_REFRESH_URL` is reused for step 5 since it's the same OAuth token endpoint (`https://my.cqu.edu.cn/authserver/oauth/token`).

**Step 4: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose src/services/auth.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```
git add src/services/auth.ts src/services/auth.test.ts
git commit -m "feat(auth): replace Playwright login with pure HTTP CAS→OAuth flow"
```

---

### Task 4: Remove Browser Rendering dependencies

**Files:**
- Modify: `src/types.ts` — remove `BrowserWorker` import and `MYBROWSER` property
- Modify: `src/routes/users.ts:66,225` — remove `c.env.MYBROWSER` from `login()` calls
- Modify: `src/cron/token-refresh.ts:58` — remove `env.MYBROWSER` from `login()` call
- Modify: `wrangler.jsonc` — remove `"browser"` block
- Modify: `package.json` — remove `@cloudflare/playwright` from dependencies

**Step 1: Update `src/types.ts`**

Remove `import type { BrowserWorker } from "@cloudflare/playwright";` and `MYBROWSER: BrowserWorker;`.

New file should be:

```typescript
export interface Env {
  // Static Assets
  ASSETS: Fetcher;

  // D1 Database
  DB: D1Database;

  // Rate Limiting
  UNAUTH_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  EXPLORE_LIMITER: RateLimit;

  // Secrets
  ENCRYPTION_KEY: string;
  HCAPTCHA_SECRET: string;

  // Environment Variables
  PUBLIC_URL: string;
  HCAPTCHA_ENABLED: string;
  HCAPTCHA_SITEKEY: string;
  MAX_SUBSCRIPTIONS: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
}
```

**Step 2: Update `src/routes/users.ts`**

Line 66: `login(c.env.MYBROWSER, body.student_id, body.password)` → `login(body.student_id, body.password)`
Line 225: `login(c.env.MYBROWSER, body.student_id, body.password)` → `login(body.student_id, body.password)`

Also update comments:
- Line 62: "Verify via Playwright login" → "Verify via SSO login"
- Line 193: "recover via Playwright login" → "recover via SSO login"

**Step 3: Update `src/cron/token-refresh.ts`**

Line 58: `login(env.MYBROWSER, user.studentId, password)` → `login(user.studentId, password)`

**Step 4: Update `wrangler.jsonc`**

Remove the browser binding block:
```jsonc
  // Browser Rendering
  "browser": {
    "binding": "MYBROWSER"
  },
```

**Step 5: Remove `@cloudflare/playwright` dependency**

Run: `npm uninstall @cloudflare/playwright`

**Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: Zero errors

**Step 7: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 8: Commit**

```
git add src/types.ts src/routes/users.ts src/cron/token-refresh.ts wrangler.jsonc package.json package-lock.json
git commit -m "refactor: remove Browser Rendering dependency

BREAKING: login() no longer requires BrowserWorker parameter.
Removed @cloudflare/playwright, MYBROWSER binding, and browser config."
```

---

### Task 5: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Zero errors

**Step 3: Verify no stale Playwright references remain in source**

Search `src/` and `wrangler.jsonc` for: `playwright`, `MYBROWSER`, `BrowserWorker`, `browser.*binding`
Expected: No matches
