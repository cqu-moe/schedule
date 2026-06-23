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
    // 412 = my.cqu.edu.cn 的瑞数 WAF 拦截纯 HTTP 请求(返回挑战页),非业务错误。给用户
    // 一个明确的"被风控、暂时不可用、稍后再试"提示,而非暴露 "HTTP 412" 原文。503 表达
    // 暂时性不可用。
    if (e.statusCode === 412) {
      return errorResponse(
        "CQU_WAF_BLOCKED",
        "CQU 教务系统已开启风控（瑞数），暂时无法获取数据，请稍后再试",
        503,
      );
    }
    return errorResponse("UPSTREAM_ERROR", e.message, 502);
  }
  return errorResponse("UPSTREAM_ERROR", fallbackMsg, 502);
}
