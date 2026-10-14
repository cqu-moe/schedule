import type { Env } from "../types";
import type { ExternalSearchResult } from "./external-search";
import { EntitlementError } from "../middleware/entitlements";

type Search = Extract<ExternalSearchResult, { sourceType: "admin_class" }>;
interface Selection { userId: string; expiresAt: number; search: Search }

/** A short-lived, owner-bound receipt for a real result; no browser credentials. */
export async function issueExternalSelection(env: Env, userId: string, search: Search): Promise<string> {
  const token = crypto.randomUUID();
  await env.CACHE.put(`external-selection:v1:${token}`, JSON.stringify({ userId, expiresAt: Date.now() + 600_000, search } satisfies Selection), { expirationTtl: 600 });
  return token;
}
export async function resolveExternalSelection(env: Env, userId: string, body: Record<string, unknown>) {
  const expired = () => new EntitlementError("EXTERNAL_SELECTION_EXPIRED", 409, "目标选择已过期，请重新搜索当前学期课表");
  if (typeof body.selectionToken !== "string" || body.selectionToken.length > 100) throw expired();
  const selection = await env.CACHE.get<Selection>(`external-selection:v1:${body.selectionToken}`, "json").catch(() => null);
  if (!selection || selection.userId !== userId || selection.expiresAt <= Date.now() || selection.search.sourceType !== body.sourceType || selection.search.session.id !== body.sessionId) throw expired();
  const target = selection.search.items.find(item => item.id === body.sourceId);
  if (!target) throw expired();
  return { sourceType: selection.search.sourceType, target, session: selection.search.session };
}
