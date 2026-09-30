import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  LINK_FORMATS,
  PERSONAL_VIEW_TYPES,
  subscriptions,
  type Subscription,
} from "../../src/db/schema";

export async function seedPersonal(
  db: D1Database,
  userId: string,
): Promise<{ id: string; viewIds: string[] }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const viewIds = PERSONAL_VIEW_TYPES.map(() => crypto.randomUUID());
  await db.batch([
    db.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1,?,?)`)
      .bind(id, userId, "personal", userId, "个人课表", now, now),
    ...PERSONAL_VIEW_TYPES.map((sourceType, index) => db.prepare(`INSERT INTO personal_subscription_views
      (id,subscription_id,source_type,source_name,created_at) VALUES (?,?,?,?,?)`)
      .bind(viewIds[index], id, sourceType, sourceType, now)),
    ...PERSONAL_VIEW_TYPES.map((sourceType, index) => db.prepare(`INSERT INTO calendar_links
      (id,subscription_id,token,formats,is_default,personal_view_type,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?,?)`)
      .bind(
        crypto.randomUUID(),
        id,
        `test-${crypto.randomUUID()}`,
        JSON.stringify(LINK_FORMATS),
        sourceType,
        now,
        now,
      )),
  ]);
  return { id, viewIds };
}

export async function readPersonalRows(
  db: D1Database,
  userId: string,
): Promise<Subscription[]> {
  return drizzle(db)
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
}

export async function resetPersonalData(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM calendar_links"),
    db.prepare("DELETE FROM personal_subscription_views"),
    db.prepare("DELETE FROM personal_subscription_setup"),
    db.prepare("DELETE FROM subscriptions"),
  ]);
}
