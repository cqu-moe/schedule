import { PostHog, type EventMessage } from "posthog-node";
import type { Env } from "../types";

type Lifecycle = { waitUntil(promise: Promise<unknown>): void };

const REDACTED = "[redacted]";
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LABELED_SECRET = /\b(password|cookie|authorization|token|student_?id|email|otp|code|ticket)\s*[:=]\s*[^\s,;&]+/gi;
const BEARER = /\bBearer\s+[^\s,;&]+/gi;

const ALLOWED_PROPERTIES = new Set([
  "telemetry_version",
  "product",
  "surface",
  "environment",
  "release",
  "actor_type",
  "trigger",
  "outcome",
  "operation",
  "flow",
  "stage",
  "duration_ms",
  "end_to_end_duration_ms",
  "duration_basis",
  "error_code",
  "warning_code",
  "no_op",
  "is_test",
  "run_id",
  "subscription_id",
  "delivery_attempt",
  "session_recovery_attempts",
  "format",
  "source_type",
  "view_type",
]);

const ALLOWED_SDK_PROPERTIES = new Set([
  "$process_person_profile",
  "$exception_list",
]);

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

function sanitizeValue(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)])
    );
  }
  return value;
}

function isExceptionDetailKey(key: string): boolean {
  return key === "$exception_list";
}

export function sanitizePostHogProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => ALLOWED_PROPERTIES.has(key) || ALLOWED_SDK_PROPERTIES.has(key))
      .map(([key, value]) => [
        key,
        isExceptionDetailKey(key) ? [{ type: "Error", value: "Worker error", mechanism: { type: "generic", handled: true } }] : sanitizeValue(value, key),
      ]),
  );
}

function createClient(env: Env): PostHog | null {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) return null;
  const explicitEnablement = env.POSTHOG_ENABLED?.trim().toLowerCase();
  // Development and test deployments never upload by default. An explicit
  // cloud variable is required for controlled internal acceptance; production
  // remains best-effort whenever the public token is configured.
  const enabled = explicitEnablement !== undefined
    ? explicitEnablement === "true" || explicitEnablement === "1"
    : env.ENVIRONMENT === "production";
  if (!enabled) return null;
  return new PostHog(token, {
    host: env.POSTHOG_HOST?.trim() || "https://p.cqu.moe",
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
  const declaredEnvironment = env.ENVIRONMENT === "production"
    ? "production"
    : env.ENVIRONMENT === "test" || Boolean((env as { VITEST?: string }).VITEST)
      ? "test"
      : "development";
  return {
    telemetry_version: 2,
    product: "schedule",
    surface: "worker",
    environment: declaredEnvironment,
    release: env.RELEASE || env.GIT_COMMIT || "development",
    actor_type: "system",
    ...(declaredEnvironment === "test" ? { is_test: true } : {}),
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
        ...(processPersonProfile ? {} : { $process_person_profile: false }),
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
    const safe = new Error("Worker error");
    safe.name = error instanceof TypeError ? "TypeError" : "Error";
    safe.stack = "";
    client.captureException(safe, distinctId, sanitizePostHogProperties({
      ...baseProperties(env),
      actor_type: "system",
      trigger: "automatic",
      operation: "exception",
      outcome: "failure",
      ...properties,
      $process_person_profile: false,
    }));
    finish(client, lifecycle);
  } catch {
    // Telemetry must never change a business result.
  }
}
