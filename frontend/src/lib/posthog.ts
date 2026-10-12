type EventLike = {
  event: string;
  properties: Record<string, unknown>;
};

type PostHogClient = typeof import("posthog-js")["default"];
type DeferredCapture =
  | { kind: "pageview"; path: string }
  | { kind: "exception"; error: unknown; properties: Record<string, unknown> };

const REDACTED = "[redacted]";
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LABELED_SECRET = /\b(password|cookie|authorization|token|student_?id|email|otp|code|ticket)\s*[:=]\s*[^\s,;&]+/gi;
const BEARER = /\bBearer\s+[^\s,;&]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "password"
    || normalized === "authorization"
    || normalized === "studentid"
    || normalized === "email"
    || normalized === "otp"
    || normalized === "code"
    || normalized === "ticket"
    || normalized === "schedule"
    || normalized === "subscriptionurl"
    || normalized.endsWith("password")
    || normalized.endsWith("cookie")
    || normalized.endsWith("token")
    || (normalized.endsWith("code") && normalized !== "errorcode");
}

function redactText(value: string): string {
  return value
    .replace(EMAIL, REDACTED)
    .replace(LABELED_SECRET, (_match, label: string) => `${label}=${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`);
}

export function templateRoutePath(pathname: string): string {
  if (/^\/view\/[^/]+$/.test(pathname)) return "/view/:token";
  if (/^\/calendar\/[^/]+$/.test(pathname)) return "/calendar/:sub_token";
  return pathname
    .split("/")
    .map((segment) => {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return ":id";
      if (/^\d{6,}$/.test(segment)) return ":id";
      if (/^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{16,}$/i.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

function sanitizeUrl(value: string): string {
  try {
    const relative = value.startsWith("/");
    const url = new URL(value, "https://redacted.invalid");
    url.pathname = templateRoutePath(url.pathname);
    url.search = "";
    url.hash = "";
    return relative ? url.pathname : url.toString();
  } catch {
    return redactText(value.split(/[?#]/, 1)[0] ?? "");
  }
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return normalized.includes("url") || normalized.includes("referrer")
      ? sanitizeUrl(value)
      : redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)])
    );
  }
  return value;
}

export function sanitizePostHogEvent<T extends EventLike>(event: T | null): T | null {
  if (!event) return null;
  return { ...event, properties: sanitizeValue(event.properties) as Record<string, unknown> };
}

const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
const host = import.meta.env.VITE_POSTHOG_HOST?.trim() || "https://p.cqu.moe";
const environment = import.meta.env.PROD ? "production" : import.meta.env.MODE === "test" ? "test" : "development";
const release = import.meta.env.VITE_RELEASE?.trim() || "development";
let client: PostHogClient | null = null;
let initialization: Promise<boolean> | null = null;
let initializationFailed = false;
let identityRequest: { userId: string | null } | null = null;
let replayPath: string | null = null;
let deferredCaptures: DeferredCapture[] = [];

function clearLegacyPostHogCookie(projectToken: string): void {
  const encodedToken = projectToken.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ");
  const name = `ph_${encodedToken}_posthog`;
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  if (window.location.hostname === "cqu.moe" || window.location.hostname.endsWith(".cqu.moe")) {
    document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.cqu.moe; Secure; SameSite=Lax`;
  }
}

function applyIdentity(posthog: PostHogClient, userId: string | null): void {
  // posthog-js persists "$user_id" across page loads; a module-level flag
  // misses it after reload and identify() would merge the previous account's
  // person into the new user.
  const persistedUserId = posthog.get_property("$user_id");
  if (typeof persistedUserId === "string" && persistedUserId !== userId) {
    posthog.reset();
  }
  if (userId) posthog.identify(userId);
}

function captureDeferred(posthog: PostHogClient, capture: DeferredCapture): void {
  if (capture.kind === "pageview") {
    const path = templateRoutePath(capture.path);
    posthog.capture("$pageview", {
      $current_url: `${window.location.origin}${path}`,
      route: path,
    });
    return;
  }
  posthog.captureException(capture.error, capture.properties);
}

function syncReplay(posthog: PostHogClient, pathname: string): void {
  const safe = pathname === "/" || pathname === "/api-docs";
  if (safe) posthog.startSessionRecording();
  else posthog.stopSessionRecording();
}

export function initPostHog(): Promise<boolean> {
  if (client) return Promise.resolve(true);
  if (!token) {
    if (import.meta.env.DEV) console.info("VITE_POSTHOG_PROJECT_TOKEN is not configured; PostHog is disabled.");
    return Promise.resolve(false);
  }
  if (initializationFailed) return Promise.resolve(false);
  if (initialization) return initialization;

  const request = (async (): Promise<boolean> => {
    try {
      clearLegacyPostHogCookie(token);
      const { default: loadedPostHog } = await import("posthog-js");
      loadedPostHog.init(token, {
        api_host: host,
        asset_host: host,
        ui_host: "https://us.posthog.com",
        persistence: "localStorage",
        cross_subdomain_cookie: false,
        defaults: "2026-05-30",
        capture_pageview: false,
        capture_pageleave: false,
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        autocapture: {
          dom_event_allowlist: ["click"],
          element_allowlist: ["a", "button"],
          url_allowlist: [
            /^https?:\/\/[^/]+\/$/,
            /^https?:\/\/[^/]+\/api-docs$/,
          ],
          css_selector_ignorelist: [".ph-no-capture", "[data-ph-no-autocapture]", "[data-sensitive]"],
        },
        capture_heatmaps: true,
        disable_session_recording: true,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "*",
          blockSelector: "[data-sensitive]",
          recordHeaders: false,
          recordBody: false,
        },
        before_send: sanitizePostHogEvent,
        person_profiles: "identified_only",
        ip: false,
      });
      loadedPostHog.register({ service: "schedule-web", environment, release });
      client = loadedPostHog;

      // Replay only the newest identity and recording state. Earlier requests
      // are deliberately superseded so a slow chunk cannot activate stale state.
      if (identityRequest) applyIdentity(client, identityRequest.userId);
      const captures = deferredCaptures;
      deferredCaptures = [];
      for (const capture of captures) captureDeferred(client, capture);
      if (replayPath !== null) syncReplay(client, replayPath);
      initialization = null;
      return true;
    } catch (error) {
      client = null;
      initializationFailed = true;
      initialization = null;
      identityRequest = null;
      replayPath = null;
      deferredCaptures = [];
      if (import.meta.env.DEV) {
        console.warn("PostHog failed to load; analytics is disabled for this page load.", error);
      }
      return false;
    }
  })();

  initialization = request;
  return request;
}

export function syncPostHogIdentity(userId: string | null): void {
  identityRequest = { userId };
  if (client) applyIdentity(client, userId);
}

export function captureSchedulePageview(pathname: string): void {
  if (!token || initializationFailed) return;
  if (client) {
    captureDeferred(client, { kind: "pageview", path: pathname });
    return;
  }
  // A route can change while the SDK chunk loads; only the latest pageview is
  // relevant once analytics becomes available.
  deferredCaptures = [
    ...deferredCaptures.filter((capture) => capture.kind !== "pageview"),
    { kind: "pageview", path: pathname },
  ];
}

export function syncPostHogReplay(pathname: string): void {
  replayPath = pathname;
  if (client) syncReplay(client, pathname);
}

export function captureScheduleException(error: unknown, properties: Record<string, unknown> = {}): void {
  if (!token || initializationFailed) return;
  const capture = {
    kind: "exception",
    error,
    properties: sanitizeValue(properties) as Record<string, unknown>,
  } satisfies DeferredCapture;
  if (client) {
    captureDeferred(client, capture);
    return;
  }
  // Bound startup buffering when the SDK chunk is slow or stalled.
  deferredCaptures = [...deferredCaptures.slice(-19), capture];
}
