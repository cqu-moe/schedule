type EventLike = {
  event: string;
  uuid?: unknown;
  timestamp?: unknown;
  properties: Record<string, unknown>;
};

type PostHogClient = typeof import("posthog-js")["default"];
type DeferredCapture =
  | { kind: "pageview"; path: string }
  | { kind: "event"; event: string; properties: Record<string, unknown> }
  | { kind: "exception"; error: unknown; properties: Record<string, unknown> };

const REDACTED = "[redacted]";
const ORIGIN = "https://schedule.cqu.moe";
const ALLOWED_EVENTS = new Set(["app_session_ready", "$identify", "$snapshot", "$exception", "$pageview", "schedule_action_finished"]);
const KNOWN_PATHS = new Set(["/", "/signed-out", "/dashboard", "/add", "/api-docs"]);
const TRANSPORT_KEYS = new Set(["token", "distinct_id", "$device_id", "$session_id", "$window_id", "$lib", "$lib_version", "$process_person_profile"]);
const PROPERTY_ALLOWLIST = new Set(["telemetry_version", "product", "surface", "environment", "release", "actor_type", "trigger", "operation", "stage", "flow", "outcome", "error_code", "warning_code", "duration_ms", "duration_basis", "operation_id", "no_op", "is_test", "format", "source_type", "view_type", "route", "$process_person_profile"]);
const SNAPSHOT_KEYS = new Set([...TRANSPORT_KEYS, "$snapshot_data", "$snapshot_bytes", "$snapshot_host"]);
const IDENTIFY_KEYS = new Set([...TRANSPORT_KEYS, "$anon_distinct_id", "$user_id"]);
const EXCEPTION_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException", "AbortError"]);
export function templateRoutePath(pathname: string): string {
  if (KNOWN_PATHS.has(pathname)) return pathname;
  if (/^\/view\/[^/]+$/.test(pathname)) return "/view/:token";
  if (/^\/calendar\/[^/]+$/.test(pathname)) return "/calendar/:sub_token";
  return "/unknown";
}

function safeUrl(value: unknown): string {
  try {
    const url = new URL(String(value), ORIGIN);
    return url.origin === ORIGIN ? ORIGIN + templateRoutePath(url.pathname) : ORIGIN + "/unknown";
  } catch { return ORIGIN + "/unknown"; }
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "$current_url") return safeUrl(value);
    if ((key === "error_code" || key === "warning_code") && !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)) return "UNKNOWN_ERROR";
    return value.length <= 128 ? value : REDACTED;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  return REDACTED;
}

export function sanitizePostHogEvent<T extends EventLike>(event: T | null): T | null {
  if (!event || !ALLOWED_EVENTS.has(event.event)) return null;
  const source = event.properties ?? {};
  const keys = event.event === "$snapshot" ? SNAPSHOT_KEYS
    : event.event === "$identify" ? IDENTIFY_KEYS
    : new Set([...TRANSPORT_KEYS, ...PROPERTY_ALLOWLIST, "$current_url"]);
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in source)) continue;
    properties[key] = event.event === "$snapshot" || TRANSPORT_KEYS.has(key) || IDENTIFY_KEYS.has(key)
      ? source[key] : sanitizeValue(source[key], key);
  }
  {
    // reset() clears registered properties; every business event keeps its contract.
    Object.assign(properties, { telemetry_version: 2, product: "schedule", surface: "web", environment, release,
      ...(isTestEvent ? { is_test: true } : {}) });
  }
  if (event.event === "$exception") {
    const first = Array.isArray(source.$exception_list) ? source.$exception_list[0] : undefined;
    const type = first && EXCEPTION_CLASSES.has(first.type) ? first.type : "Error";
    properties.$exception_list = [{ type, value: "Unhandled browser error", mechanism: { type: "generic", handled: false } }];
    properties.$exception_type = type;
    properties.error_code = "EXCEPTION";
    properties.operation = "exception";
    properties.outcome = "failure";
  }
  // SDK-generated $set and $set_once may contain initial URLs and referrers.
  return { event: event.event, ...(event.uuid === undefined ? {} : { uuid: event.uuid }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }), properties } as T;
}

const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
const host = import.meta.env.VITE_POSTHOG_HOST?.trim() || "https://p.cqu.moe";
const isTestEvent = !import.meta.env.PROD || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("telemetry_test") === "1");
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
      $current_url: path,
      route: path,
      actor_type: "user",
      trigger: "automatic",
      operation: "pageview",
      outcome: "success",
    });
    return;
  }
  if (capture.kind === "event") {
    posthog.capture(capture.event, capture.properties);
    return;
  }
  posthog.captureException(capture.error, capture.properties);
}

function syncReplay(posthog: PostHogClient, pathname: string): void {
  const safe = window.location.origin === ORIGIN && pathname.startsWith("/");
  if (safe) posthog.startSessionRecording(true);
  else posthog.stopSessionRecording();
}

export function initPostHog(): Promise<boolean> {
  if (client) return Promise.resolve(true);
  if (!import.meta.env.PROD && import.meta.env.VITE_POSTHOG_ALLOW_NON_PRODUCTION !== "true") return Promise.resolve(false);
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
        save_referrer: false,
        save_campaign_params: false,
        defaults: "2026-05-30",
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        capture_performance: false,
        logs: { captureConsoleLogs: false },
        capture_dead_clicks: false,
        disable_scroll_properties: true,
        advanced_disable_feature_flags: true,
        disable_surveys: true,
        disable_web_experiments: true,
        disable_product_tours: true,
        disable_conversations: true,
        advanced_disable_toolbar_metrics: true,
        opt_in_site_apps: false,
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        capture_heatmaps: false,
        disable_session_recording: true,
        session_recording: {
      sampleRate: 1,
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: () => REDACTED,
      maskAllElementAttributes: true,
      blockSelector: "img,picture,svg,video,audio,canvas,iframe,[data-sensitive],[data-ph-no-capture]",
      slimDOMOptions: "all",
      collectFonts: false,
      captureJsonLd: false,
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      streamNetworkBody: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: request => Object.keys(request).length === 1
        ? { ...request, name: safeUrl(request.name) } : null,
    },
        before_send: event => event?.event === "$snapshot" && window.location.origin !== ORIGIN ? null : sanitizePostHogEvent(event),
        person_profiles: "identified_only",
        ip: false,
      });
      loadedPostHog.register({
        telemetry_version: 2,
        product: "schedule",
        surface: "web",
        environment,
        release,
        ...(environment === "test" ? { is_test: true } : {}),
      });
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

export function captureScheduleEvent(
  event: "app_session_ready" | "schedule_action_finished",
  properties: Record<string, unknown>,
): void {
  if (!token || initializationFailed) return;
  const capture = {
    kind: "event",
    event,
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => PROPERTY_ALLOWLIST.has(key)).map(([key, value]) => [key, sanitizeValue(value, key)])),
  } satisfies DeferredCapture;
  if (client) {
    captureDeferred(client, capture);
    return;
  }
  deferredCaptures = [...deferredCaptures.slice(-19), capture];
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
    properties: {
      actor_type: "system",
      trigger: "automatic",
      operation: "exception",
      outcome: "failure",
      $process_person_profile: false,
      ...properties,
    },
  } satisfies DeferredCapture;
  if (client) {
    captureDeferred(client, capture);
    return;
  }
  // Bound startup buffering when the SDK chunk is slow or stalled.
  deferredCaptures = [...deferredCaptures.slice(-19), capture];
}
