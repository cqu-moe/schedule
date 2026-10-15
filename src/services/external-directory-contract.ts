import type { ExternalDepartment, ExternalItem, ExternalSession } from "./external-search";

export const DIRECTORY_CATALOGS = ["department", "room", "laboratory", "admin_class", "course_catalog", "teaching_class"] as const;
export type DirectoryCatalog = typeof DIRECTORY_CATALOGS[number];
export interface DirectoryItem extends ExternalItem { departmentId?: string; grade?: string; courseCode?: string }
export type DirectoryRecipe =
  | { kind: "catalog"; sourceType: DirectoryCatalog; expectedSessionId?: string }
  | { kind: "instructors"; classIds: string[]; expectedSessionId: string };
export type DirectoryArgs = DirectoryRecipe & { clientId: string; clientSecret: string; userId: string; deadlineAt?: number };
export type DirectoryResult =
  | { contractVersion: 1; kind: "catalog"; sourceType: DirectoryCatalog; session: ExternalSession; items?: DirectoryItem[]; departments?: ExternalDepartment[] }
  | { contractVersion: 1; kind: "instructors"; session: ExternalSession; classes: { classId: string; items: DirectoryItem[] }[] };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 200, empty = false): v is string => typeof v === "string" && (empty || v.trim().length > 0) && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function items(value: unknown, limit: number): DirectoryItem[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const output: DirectoryItem[] = [], seen = new Set<string>();
  for (const row of value) {
    if (!record(row) || !text(row.id, 100) || !text(row.name) || !text(row.extra, 200, true) || seen.has(row.id)) return null;
    seen.add(row.id);
    const item: DirectoryItem = { id: row.id, name: row.name, extra: row.extra };
    for (const key of ["departmentId", "grade", "courseCode"] as const) {
      if (row[key] !== undefined) {
        if (!text(row[key], 100, true)) return null;
        item[key] = row[key];
      }
    }
    output.push(item);
  }
  return output;
}
function departments(value: unknown, depth = 0): ExternalDepartment[] | null {
  if (!Array.isArray(value) || value.length > 1000 || depth > 8) return null;
  const output: ExternalDepartment[] = [];
  for (const row of value) {
    if (!record(row) || !text(row.id, 100) || !text(row.name)) return null;
    const children = row.children === undefined ? undefined : departments(row.children, depth + 1);
    if (children === null) return null;
    output.push({ id: row.id, name: row.name, ...(children ? { children } : {}) });
  }
  return output;
}
/** Validate the entire bounded reply before staging any rows; never truncate it. */
export function parseDirectoryResult(raw: unknown, recipe: DirectoryRecipe): DirectoryResult | null {
  if (!record(raw) || raw.contractVersion !== 1 || raw.kind !== recipe.kind || !record(raw.session)
      || !text(raw.session.id, 100) || !text(raw.session.name, 100)
      || (recipe.expectedSessionId && raw.session.id !== recipe.expectedSessionId)) return null;
  const session = { id: raw.session.id, name: raw.session.name };
  if (recipe.kind === "catalog") {
    if (raw.sourceType !== recipe.sourceType) return null;
    if (recipe.sourceType === "department") {
      const nodes = departments(raw.departments);
      return nodes?.length ? { contractVersion: 1, kind: "catalog", sourceType: recipe.sourceType, session, departments: nodes } : null;
    }
    const rows = items(raw.items, 20_000);
    // Empty bulk catalogs are suspicious; retain the previous generation.
    return rows?.length ? { contractVersion: 1, kind: "catalog", sourceType: recipe.sourceType, session, items: rows } : null;
  }
  if (!Array.isArray(raw.classes) || raw.classes.length !== recipe.classIds.length) return null;
  const pending = new Set(recipe.classIds), classes = [];
  for (const row of raw.classes) {
    if (!record(row) || typeof row.classId !== "string" || !pending.delete(row.classId)) return null;
    const teachers = items(row.items, 200);
    if (!teachers) return null;
    classes.push({ classId: row.classId, items: teachers });
  }
  return pending.size ? null : { contractVersion: 1, kind: "instructors", session, classes };
}
