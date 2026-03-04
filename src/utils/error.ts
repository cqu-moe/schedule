import type { Context } from "hono";
import { CQUAPIError } from "../services/cqu-api";

export function handleCquApiError(
  c: Context,
  e: unknown,
  fallbackMsg: string,
): Response {
  if (e instanceof CQUAPIError) {
    if (e.statusCode === 401) {
      return c.json({ detail: "CQU token expired, please re-login" }, 401);
    }
    return c.json({ detail: e.message }, 502);
  }
  return c.json({ detail: fallbackMsg }, 502);
}
