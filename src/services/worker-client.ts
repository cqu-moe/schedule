import type { Env } from "../types";

const LOGIN_TIMEOUT_MS = 90_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class WorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkerError";
    this.code = code;
  }
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
}

async function workerRequest(
  env: Env,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const url = `${env.PLAYWRIGHT_URL.replace(/\/$/, "")}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new WorkerError("WORKER_TIMEOUT", "Worker 请求超时");
    }
    throw new WorkerError("WORKER_UNREACHABLE", `无法连接 Worker: ${e}`);
  } finally {
    clearTimeout(timer);
  }

  let responseBody: any;
  try {
    responseBody = await response.json();
  } catch {
    throw new WorkerError(
      "WORKER_UNREACHABLE",
      `Worker 返回非 JSON 响应 (HTTP ${response.status})`,
    );
  }

  if (!responseBody.success) {
    const error = responseBody.error ?? {};
    throw new WorkerError(
      error.code ?? "UNKNOWN",
      error.message ?? "Unknown error",
    );
  }

  return responseBody.data;
}

export async function login(
  env: Env,
  username: string,
  password: string,
): Promise<TokenResult> {
  const data = await workerRequest(
    env,
    "/api/v1/auth/login",
    { username, password },
    LOGIN_TIMEOUT_MS,
  );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  };
}

export async function refreshToken(
  env: Env,
  refreshTokenStr: string,
): Promise<TokenResult> {
  const data = await workerRequest(env, "/api/v1/auth/refresh-token", {
    refresh_token: refreshTokenStr,
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  };
}
