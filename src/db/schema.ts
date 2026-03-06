import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Users table ──────────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),

  studentId: text("student_id").unique().notNull(),

  /** AES-256-GCM encrypted password stored as base64 text */
  encryptedPassword: text("encrypted_password").notNull(),

  // OAuth Tokens
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  /** ISO 8601 datetime string */
  tokenExpiresAt: text("token_expires_at"),

  /** 64-char random token for calendar subscription URL */
  calendarToken: text("calendar_token").unique().notNull(),

  // Status tracking
  /** ISO 8601 datetime string */
  lastLoginAt: text("last_login_at"),
  /** ISO 8601 datetime string */
  lastRefreshAt: text("last_refresh_at"),
  loginError: text("login_error"),

  // Timestamps (ISO 8601 strings)
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── Subscriptions table ──────────────────────────────────────────────────────

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Source type: see SourceType union */
    sourceType: text("source_type").notNull().$type<SourceType>(),
    sourceId: text("source_id").notNull(),
    sourceName: text("source_name").notNull(),

    /** 64-char random token for subscription calendar URL */
    calendarToken: text("calendar_token").unique().notNull(),

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
    index("idx_subscriptions_user_id").on(table.userId),
  ],
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
export type ExploreSourceType = Extract<SourceType, "instructor" | "room" | "laboratory" | "course" | "admin_class">;

export const PERSONAL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<PersonalSourceType>([
  "personal_all",
  "personal_courses",
  "personal_exams",
]);

export const EXPLORE_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<ExploreSourceType>([
  "instructor",
  "room",
  "laboratory",
  "course",
  "admin_class",
]);

// ── Type exports ─────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
