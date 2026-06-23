import { errorResponse } from "../utils/error";

/**
 * 外部课表(按教师/教室/课程/行政班加别人的课表)软禁用开关 —— 可逆。
 *
 * 背景:my.cqu.edu.cn 全站瑞数化后,外部课表的 `{type}/table-detail` POST 同属
 * 写专守,且必须交互选中后才查、无深链可自动 fire,organic harvest 无法覆盖
 * (详见 docs/plans/2026-06-23-cqu-organic-harvest-design.md §6/§9)。本期外部
 * 课表软禁用:前端隐藏入口 + 后端端点返回"暂不可用" + 已有外部订阅停止同步。
 *
 * 恢复:把 EXTERNAL_DISABLED 改回 false(或删除引用),数据从未删除,即时复活。
 */
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
