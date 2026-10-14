import { errorResponse } from "../utils/error";

/** The retired source-version-0 path remains frozen. New providers use the
 * independent EXTERNAL_SUBSCRIPTION_TYPES rollout allowlist below. */
export const EXTERNAL_DISABLED = true;

/** 统一错误码:对用户表达"暂时不可用",绝不暴露 WAF/瑞数细节。 */
export const EXTERNAL_UNAVAILABLE_CODE = "EXTERNAL_UNAVAILABLE";
export const EXTERNAL_UNAVAILABLE_MESSAGE = "外部订阅功能暂不可用";

/**
 * 当外部功能软禁用时返回的统一 503 响应;未禁用时返回 null(放行)。
 * 503 表达"暂时性不可用",与 handleCquApiError 对 WAF 的语义一致,但不提原因。
 */
export function externalUnavailableResponse(): Response | null {
  if (!EXTERNAL_DISABLED) return null;
  return errorResponse(EXTERNAL_UNAVAILABLE_CODE, EXTERNAL_UNAVAILABLE_MESSAGE, 503);
}


export type ExternalSourceType = "instructor" | "room" | "laboratory" | "course" | "admin_class";

/** New-version capabilities are independent from the permanently retired legacy path. */
export function externalAvailability(env: {
  EXTERNAL_SUBSCRIPTION_TYPES?: string;
  EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS?: string;
}, userId?: string) {
  // An explicitly empty pilot setting closes admission, including public config.
  if (env.EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS !== undefined) {
    const pilots = env.EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS.split(",").map(id => id.trim()).filter(Boolean);
    if (!userId || !pilots.includes(userId)) return { search_types: [], create_types: [] };
  }
  const configured = new Set((env.EXTERNAL_SUBSCRIPTION_TYPES ?? "").split(",").map(s => s.trim()));
  const search: ExternalSourceType[] = ["admin_class", "instructor", "room", "laboratory", "course"];
  const create: ExternalSourceType[] = ["admin_class", "instructor", "room", "laboratory", "course"];
  return {
    search_types: search.filter(type => configured.has(type)),
    create_types: create.filter(type => configured.has(type)),
  };
}
