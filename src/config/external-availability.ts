import { errorResponse } from "../utils/error";

/**
 * 外部课表(按教师/教室/课程/行政班加别人的课表)禁用开关 —— Option A:诚实禁用。
 *
 * 背景:my.cqu.edu.cn 全站瑞数化后,外部课表的 `{type}/table-detail` POST 同属
 * 写专守,且必须交互选中后才查、无深链可自动 fire,organic harvest 无法覆盖
 * (详见 docs/plans/2026-06-23-cqu-organic-harvest-design.md §6/§9)。
 *
 * ⚠️ 这个开关 **不是、也无法** 一翻即复活外部功能的可逆开关:本 PR 已**移除**外部
 * harvest 能力(搜索/同步:按 instructor/room/course/admin_class 取数),因为它过不了
 * 瑞数 WAF。因此:
 *  - EXTERNAL_DISABLED 仅控制 **面向用户的提示 / 守卫**(前端隐藏入口、外部端点回
 *    503"暂不可用"、外部订阅停止入队/同步);它 **不会、也不能** 恢复外部取数能力。
 *  - 外部订阅在 consumer/producer 中是 **无条件硬跳过**(与本开关无关),永不走个人
 *    harvest 路径——否则会把订阅主人自己的个人课表写进对外公开链接,污染数据
 *    (见 src/cron/schedule-sync.ts)。
 *  - 外部路由保持 503 是 **预期行为**,不是 bug。
 *
 * 重新启用外部:是一个 **未来的跨仓任务**,需要重新实现外部 search/sync 的取数路径
 * (能过瑞数),而不仅仅是把此处翻回 false。数据从未删除,但仅翻此 flag 不能复活功能。
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
