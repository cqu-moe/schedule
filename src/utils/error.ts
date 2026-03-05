import { CQUAPIError } from "../services/cqu-api";

export function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { detail: { error: { code, message } } },
    { status },
  );
}

export function handleCquApiError(
  _c: unknown,
  e: unknown,
  fallbackMsg: string,
): Response {
  if (e instanceof CQUAPIError) {
    if (e.statusCode === 401) {
      return errorResponse("TOKEN_EXPIRED", "CQU token expired, please re-login", 401);
    }
    return errorResponse("UPSTREAM_ERROR", e.message, 502);
  }
  return errorResponse("UPSTREAM_ERROR", fallbackMsg, 502);
}
