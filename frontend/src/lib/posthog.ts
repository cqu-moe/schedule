import posthog from "posthog-js";

type EventLike = {
  event: string;
  properties: Record<string, unknown>;
};

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
let initialized = false;
let identifiedUserId: string | null | undefined = undefined;

function clearLegacyPostHogCookie(projectToken: string): void {
  const encodedToken = projectToken.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ");
  const name = `ph_${encodedToken}_posthog`;
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  if (window.location.hostname === "cqu.moe" || window.location.hostname.endsWith(".cqu.moe")) {
    document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.cqu.moe; Secure; SameSite=Lax`;
  }
}

export function initPostHog(): boolean {
  if (initialized) return true;
  if (!token) {
    if (import.meta.env.DEV) console.info("VITE_POSTHOG_PROJECT_TOKEN is not configured; PostHog is disabled.");
    return false;
  }
  clearLegacyPostHogCookie(token);
  posthog.init(token, {
    api_host: host,
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
        /^https?:\/\/[^/]+\/changelog$/,
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
  posthog.register({ service: "schedule-web", environment, release });
  initialized = true;
  return true;
}

export function syncPostHogIdentity(userId: string | null): void {
  if (!initialized) return;
  if (userId) {
    if (typeof identifiedUserId === "string" && identifiedUserId !== userId) posthog.reset();
    posthog.identify(userId);
  } else if (typeof identifiedUserId === "string") {
    posthog.reset();
  }
  identifiedUserId = userId;
}

export function captureSchedulePageview(pathname: string): void {
  if (!initialized) return;
  const path = templateRoutePath(pathname);
  posthog.capture("$pageview", {
    $current_url: `${window.location.origin}${path}`,
    route: path,
  });
}

export function syncPostHogReplay(pathname: string): void {
  if (!initialized) return;
  const safe = pathname === "/" || pathname === "/api-docs" || pathname === "/changelog";
  if (safe) posthog.startSessionRecording();
  else posthog.stopSessionRecording();
}

export function captureScheduleException(error: unknown, properties: Record<string, unknown> = {}): void {
  if (!initialized) return;
  posthog.captureException(error, sanitizeValue(properties) as Record<string, unknown>);
}
