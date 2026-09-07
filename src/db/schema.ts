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

    /**
     * Whether this subscription is currently entitled (owner still holds the
     * required calendar cap). Reconciled from caps by the cron producer and by
     * manual refresh; public calendar endpoints serve only active subscriptions.
     * Revoking a cap flips this false (hard revocation); re-granting flips it back.
     */
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true),

    /** Cached ICS calendar content */
    icsContent: text("ics_content"),

    /** JSON stored as TEXT -- use JSON.parse/stringify at app level */
    coursesJson: text("courses_json"),
    /** JSON stored as TEXT -- use JSON.parse/stringify at app level */
    examsJson: text("exams_json"),

    /** ISO 8601 datetime string */
    lastSyncedAt: text("last_synced_at"),

    /** Persisted lifecycle for the latest sync attempt. */
    syncStatus: text("sync_status").notNull().default("idle").$type<SyncStatus>(),
    syncRunId: text("sync_run_id"),
    syncTrigger: text("sync_trigger").$type<SyncTrigger>(),
    syncRequestedAt: text("sync_requested_at"),
    syncStartedAt: text("sync_started_at"),
    syncFinishedAt: text("sync_finished_at"),
    syncErrorCode: text("sync_error_code"),
    syncErrorMessage: text("sync_error_message"),

    /** Last accepted manual refresh. Personal trio rows share the same value. */
    manualRefreshAt: text("manual_refresh_at"),

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
    // Personal subscriptions identify by (user, type, source) ONLY — session_id is
    // informational and gets overwritten to the current semester on first sync, so
    // it must not be part of their uniqueness. (uq_user_source_session can't enforce
    // this: it includes session_id, and SQLite treats NULLs as distinct.) This
    // partial unique index covers the personal source types regardless of session_id,
    // so a user can hold at most one of each personal calendar.
    uniqueIndex("uq_user_source_personal")
      .on(table.userId, table.sourceType, table.sourceId)
      .where(sql`${table.sourceType} in ('personal_all', 'personal_courses', 'personal_exams')`),
    index("idx_subscriptions_user_id").on(table.userId), // Dedicated index for userId-only queries; composite uq_user_source_session also covers this prefix but with wider entries
  ],
);

export const notificationState = sqliteTable("notification_state", {
  userId: text("user_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  snapshotJson: text("snapshot_json"),
  snapshotHash: text("snapshot_hash"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

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

export type SyncStatus = "idle" | "queued" | "running" | "success" | "error";
export type SyncTrigger = "cron" | "manual" | "initial" | "admin";

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
export type NotificationState = typeof notificationState.$inferSelect;
export type CalendarLink = typeof calendarLinks.$inferSelect;
export type NewCalendarLink = typeof calendarLinks.$inferInsert;
