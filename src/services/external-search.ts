import type { Env } from "../types";
import { errorResponse } from "../utils/error";

export interface ExternalSearchArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  sourceType: "department" | "admin_class" | "instructor";
  departmentId?: string;
  departmentName?: string;
  grade?: string;
  keyword?: string;
  deadlineAt?: number;
}
export interface ExternalSession { id: string; name: string }
export interface ExternalDepartment { id: string; name: string; children?: ExternalDepartment[] }
export interface ExternalItem { id: string; name: string; extra: string }
export type ExternalSearchResult =
  | { contractVersion: 1; sourceType: "department"; session: ExternalSession; departments: ExternalDepartment[] }
  | { contractVersion: 1; sourceType: "admin_class" | "instructor"; session: ExternalSession; items: ExternalItem[]; truncated: boolean };

type RecordValue = Record<string, unknown>;
function record(v: unknown): v is RecordValue { return typeof v === "object" && v !== null && !Array.isArray(v); }
function text(v: unknown, max = 200): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}
function departments(value: unknown, depth = 0): ExternalDepartment[] | null {
  if (!Array.isArray(value) || value.length > 1000 || depth > 8) return null;
  const output: ExternalDepartment[] = [];
  for (const item of value) {
    if (!record(item) || !text(item.id, 100) || !text(item.name)) return null;
    const children = item.children === undefined ? undefined : departments(item.children, depth + 1);
    if (children === null) return null;
    output.push({ id: item.id, name: item.name, ...(children ? { children } : {}) });
  }
  return output;
}
function parseResult(value: unknown, sourceType: ExternalSearchArgs["sourceType"]): ExternalSearchResult | null {
  if (!record(value) || value.contractVersion !== 1 || value.sourceType !== sourceType || !record(value.session)) return null;
  if (!text(value.session.id, 100) || !text(value.session.name, 100)) return null;
  const session = { id: value.session.id, name: value.session.name };
  if (sourceType === "department") {
    const nodes = departments(value.departments);
    return nodes ? { contractVersion: 1, sourceType, session, departments: nodes } : null;
  }
  if (!Array.isArray(value.items) || typeof value.truncated !== "boolean") return null;
  const items: ExternalItem[] = [];
  for (const row of value.items.slice(0, 200)) {
    if (!record(row) || !text(row.id, 100) || !text(row.name) || typeof row.extra !== "string" || row.extra.length > 200 || /[\u0000-\u001f\u007f]/.test(row.extra)) return null;
    items.push({ id: row.id, name: row.name, extra: row.extra });
  }
  return { contractVersion: 1, sourceType, session, items, truncated: value.truncated || value.items.length > 200 };
}
function searchError(code: unknown): Response {
  switch (code) {
    case "TGT_EXPIRED": case "SESSION_INACTIVE": case "NO_CQU_BINDING": case "CQU_SESSION_INACTIVE": case "needs_reauth": case "NEEDS_REAUTH":
      return errorResponse("CQU_SESSION_INACTIVE", "重庆大学统一认证登录状态已失效，请重新绑定", 409);
    case "FORBIDDEN":
      return errorResponse("FEATURE_NOT_ENABLED", "外部订阅功能未开通", 403);
    case "PAGE_PERMISSION_DENIED": case "SOURCE_FORBIDDEN": case "SEARCH_FORBIDDEN":
      return errorResponse("EXTERNAL_TARGET_FORBIDDEN", "当前账号无权查看该目标", 403);
    case "BUSY": case "BROWSER_BUSY": case "SESSION_BUSY": case "RATE_LIMITED":
      return errorResponse("EXTERNAL_BUSY", "学校会话正在处理其他请求，请稍后重试", 503);
    case "SCHEMA_INVALID":
      return errorResponse("EXTERNAL_INVALID_RESPONSE", "学校返回的数据暂时无法识别，请稍后重试", 502);
    default:
      return errorResponse("EXTERNAL_UNAVAILABLE", "外部课表暂时无法查询，请稍后重试", 503);
  }
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Call only after current user capability and binding checks. The trusted term pointer
 * expires with the response after 60s; a term transition cannot inherit a long-lived directory. */
export async function searchExternal(env: Env, userId: string, input: Omit<ExternalSearchArgs, "clientId" | "clientSecret" | "userId">): Promise<ExternalSearchResult | Response> {
  if (!env.AUTH.cquExternalSearch) return searchError("UNAVAILABLE");
  const fingerprint = await digest([userId, input.sourceType, input.departmentId ?? "", input.grade ?? "", input.keyword ?? ""]);
  const prefix = `external-search:v1:${fingerprint}`;
  try {
    const term = await env.CACHE.get(`${prefix}:current`);
    if (term) {
      const cached = await env.CACHE.get(`${prefix}:${await digest(term)}`, "json");
      if (record(cached) && typeof cached.expiresAt === "number" && cached.expiresAt > Date.now()) {
        const result = parseResult(cached.result, input.sourceType);
        if (result?.session.id === term) return result;
      }
    }
  } catch { /* A cache outage must not prevent a fresh authorized search. */ }
  let raw: unknown;
  try {
    raw = await env.AUTH.cquExternalSearch({ ...input, clientId: env.CALENDAR_CLIENT_ID, clientSecret: env.CALENDAR_CLIENT_SECRET, userId, deadlineAt: Date.now() + 90_000 });
  } catch { return searchError("UNAVAILABLE"); }
  if (record(raw) && "error" in raw) return searchError(raw.error);
  const result = parseResult(raw, input.sourceType);
  if (!result) return searchError("SCHEMA_INVALID");
  try {
    await env.CACHE.put(`${prefix}:${await digest(result.session.id)}`, JSON.stringify({ expiresAt: Date.now() + 60_000, result }), { expirationTtl: 60 });
    await env.CACHE.put(`${prefix}:current`, result.session.id, { expirationTtl: 60 });
  } catch { /* The successful school response remains usable without the cache. */ }
  return result;
}

export function findDepartment(nodes: ExternalDepartment[], id: string): ExternalDepartment | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findDepartment(node.children ?? [], id);
    if (child) return child;
  }
}
