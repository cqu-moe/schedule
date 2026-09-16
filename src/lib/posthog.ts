import { PostHog, type EventMessage } from "posthog-node";
import type { Env } from "../types";

type Lifecycle = { waitUntil(promise: Promise<unknown>): void };

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

function templatePath(pathname: string): string {
  if (/^\/view\/[^/]+$/.test(pathname)) return "/view/:token";
  if (/^\/api\/v2\/calendar\/[^/]+/.test(pathname)) return "/api/v2/calendar/:token";
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
    url.pathname = templatePath(url.pathname);
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

export function sanitizePostHogProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(properties) as Record<string, unknown>;
}

function createClient(env: Env): PostHog | null {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) return null;
  return new PostHog(token, {
    host: env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 2_000,
    fetchRetryCount: 1,
    privacyMode: true,
    enableExceptionAutocapture: false,
    before_send: (event: EventMessage | null) => event ? {
      ...event,
      properties: sanitizePostHogProperties(event.properties ?? {}),
    } : null,
  });
}

function finish(client: PostHog, lifecycle?: Lifecycle): void {
  const closing = client.shutdown(2_000).catch(() => undefined);
  try {
    lifecycle?.waitUntil(closing);
  } catch {
    void closing;
  }
}

function baseProperties(env: Env): Record<string, unknown> {
  return {
    service: "schedule-worker",
    environment: env.ENVIRONMENT || "development",
    release: env.RELEASE || env.GIT_COMMIT || "development",
  };
}

export function captureScheduleEvent(
  env: Env,
  lifecycle: Lifecycle | undefined,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
  processPersonProfile = true
): void {
  try {
    const client = createClient(env);
    if (!client) return;
    client.capture({
      distinctId,
      event,
      properties: sanitizePostHogProperties({
        ...baseProperties(env),
        ...properties,
        ...(!processPersonProfile ? { $process_person_profile: false } : {}),
      }),
    });
    finish(client, lifecycle);
  } catch {
    // Telemetry must never change a business result.
  }
}

export function captureScheduleException(
  env: Env,
  lifecycle: Lifecycle | undefined,
  error: unknown,
  properties: Record<string, unknown> = {},
  distinctId = crypto.randomUUID()
): void {
  try {
    const client = createClient(env);
    if (!client) return;
    const original = error instanceof Error ? error : new Error(String(error));
    const safe = new Error(redactText(original.message));
    safe.name = original.name;
    if (original.stack) safe.stack = redactText(original.stack);
    client.captureException(safe, distinctId, sanitizePostHogProperties({
      ...baseProperties(env),
      ...properties,
      $process_person_profile: false,
    }));
    finish(client, lifecycle);
  } catch {
    // Telemetry must never change a business result.
  }
}
