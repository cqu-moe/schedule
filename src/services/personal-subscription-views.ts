import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  personalSubscriptionViews,
  subscriptions,
  type PersonalSubscriptionView,
  type Subscription,
} from "../db/schema";

export const PERSONAL_VIEWS = [
  { sourceType: "personal_all", sourceName: "我的全部课表" },
  { sourceType: "personal_courses", sourceName: "我的课程" },
  { sourceType: "personal_exams", sourceName: "我的考试" },
] as const;

export type ResolvedOwnedSubscription = {
  subscription: Subscription;
  view: PersonalSubscriptionView | null;
};

export async function resolveOwnedSubscription(
  database: D1Database,
  userId: string,
  sid: string,
): Promise<ResolvedOwnedSubscription | null> {
  const db = drizzle(database);
  const [resolvedView] = await db
    .select({ subscription: subscriptions, view: personalSubscriptionViews })
    .from(personalSubscriptionViews)
    .innerJoin(
      subscriptions,
      eq(personalSubscriptionViews.subscriptionId, subscriptions.id),
    )
    .where(and(
      eq(personalSubscriptionViews.id, sid),
      eq(subscriptions.userId, userId),
    ))
    .limit(1);
  if (resolvedView) return resolvedView;

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, sid), eq(subscriptions.userId, userId)))
    .limit(1);
  return subscription ? { subscription, view: null } : null;
}

export async function listPersonalViews(
  database: D1Database,
  subscriptionId: string,
): Promise<PersonalSubscriptionView[]> {
  return drizzle(database)
    .select()
    .from(personalSubscriptionViews)
    .where(eq(personalSubscriptionViews.subscriptionId, subscriptionId))
    .orderBy(asc(personalSubscriptionViews.createdAt), asc(personalSubscriptionViews.sourceType));
}
