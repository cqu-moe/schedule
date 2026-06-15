import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

// ── Subscriptions table ──────────────────────────────────────────────────────

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** auth user.id（来自 cqu-moe-auth，~32 字符随机串，非 UUID） */
    userId: text("user_id").notNull(),

    /** Source type: see SourceType union */
    sourceType: text("source_type").notNull().$type<SourceType>(),
    sourceId: text("source_id").notNull(),
    sourceName: text("source_name").notNull(),

    sessionId: text("session_id"),
    sessionName: text("session_name"),
    /** Date string in YYYY-MM-DD format */
    semesterStart: text("semester_start"),

    /** Boolean stored as 0/1 integer in SQLite */
    isPersonal: integer("is_personal", { mode: "boolean" })
      .notNull()
      .default(false),

    /** Cached ICS calendar content */
    icsContent: text("ics_content"),

    /** JSON stored as TEXT -- use JSON.parse/stringify at app level */
    coursesJson: text("courses_json"),
    /** JSON stored as TEXT -- use JSON.parse/stringify at app level */
    examsJson: text("exams_json"),

    /** ISO 8601 datetime string */
    lastSyncedAt: text("last_synced_at"),

    // Timestamps (ISO 8601 strings)
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("uq_user_source_session").on(
      table.userId,
      table.sourceType,
      table.sourceId,
      table.sessionId,
    ),
    // SQLite treats NULL as distinct in unique indexes, so uq_user_source_session
    // does NOT prevent duplicate rows when session_id is NULL (the normal case for
    // personal subscriptions). This partial unique index closes that gap so two
    // concurrent identical personal creates cannot both insert.
    uniqueIndex("uq_user_source_personal")
      .on(table.userId, table.sourceType, table.sourceId)
      .where(sql`${table.sessionId} is null`),
    index("idx_subscriptions_user_id").on(table.userId), // Dedicated index for userId-only queries; composite uq_user_source_session also covers this prefix but with wider entries
  ],
);

// ── Calendar links（一个订阅的多条链接，统一同构）─────────────────────────────

export const LINK_FORMATS = ["ics", "origin_json", "data_json", "csv", "web"] as const;
export type LinkFormat = (typeof LINK_FORMATS)[number];

export const calendarLinks = sqliteTable(
  "calendar_links",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    label: text("label"),
    /** JSON array of LinkFormat */
    formats: text("formats").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_calendar_links_subscription_id").on(t.subscriptionId)],
);

// ── Source type constants ────────────────────────────────────────────────────

export const SOURCE_TYPES = [
  "personal_all",
  "personal_courses",
  "personal_exams",
  "instructor",
  "room",
  "laboratory",
  "course",
  "admin_class",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export type PersonalSourceType = Extract<SourceType, "personal_all" | "personal_courses" | "personal_exams">;
export type ExternalSourceType = Extract<SourceType, "instructor" | "room" | "laboratory" | "course" | "admin_class">;

export const PERSONAL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<PersonalSourceType>([
  "personal_all",
  "personal_courses",
  "personal_exams",
]);

export const EXTERNAL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<ExternalSourceType>([
  "instructor",
  "room",
  "laboratory",
  "course",
  "admin_class",
]);

// ── Type exports ─────────────────────────────────────────────────────────────

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type CalendarLink = typeof calendarLinks.$inferSelect;
export type NewCalendarLink = typeof calendarLinks.$inferInsert;
