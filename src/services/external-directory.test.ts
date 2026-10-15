import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { applyD1Migrations, env } from "cloudflare:test"
import type { ScheduleSyncMessage } from "../cron/schedule-sync"
import type { Env } from "../types"
import type { DirectoryArgs, DirectoryRecipe, DirectoryResult } from "./external-directory-contract"
import type { ExternalSearchResult } from "./external-search"
import { searchExternal } from "./external-search"
import {
  cacheDirectoryCourse,
  lookupDirectory,
  observeDirectorySession,
  processExternalDirectory,
  scheduleExternalDirectory,
} from "./external-directory"

const OWNER = "directory-owner"
const WEEK = 7 * 24 * 60 * 60_000
const NOW = Date.parse("2026-10-12T02:00:00.000Z")
const TERM = { id: "term-26", name: "2026秋" }

type DirectoryRpc = (args: DirectoryArgs) => Promise<DirectoryResult | { error: string }>
type SearchRpc = NonNullable<Env["AUTH"]["cquExternalSearch"]>

function harness(directory: DirectoryRpc, search?: SearchRpc) {
  const send = vi.fn(async () => undefined)
  const testEnv = {
    ...env,
    EXTERNAL_DIRECTORY_USER_ID: OWNER,
    CALENDAR_CLIENT_ID: "calendar-client",
    CALENDAR_CLIENT_SECRET: "calendar-secret",
    AUTH: {
      cquExternalDirectory: directory,
      ...(search ? { cquExternalSearch: search } : {}),
    },
    SCHEDULE_SYNC_QUEUE: { send },
  } as unknown as Env
  return { env: testEnv, send }
}

function message(runId: string) {
  return {
    body: { purpose: "external_directory", subscriptionId: "directory", userId: OWNER, runId, trigger: "cron" },
    ack: vi.fn(),
  } as unknown as Message<ScheduleSyncMessage>
}

function failObservedSessionUpdate(db: D1Database): D1Database {
  const failRun = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "run") return async () => { throw new Error("D1_UNAVAILABLE") }
      if (property === "bind") {
        return (...values: Parameters<D1PreparedStatement["bind"]>) => failRun(target.bind(...values))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => query.startsWith("UPDATE external_directory_state SET observed_session_id=")
          ? failRun(target.prepare(query))
          : target.prepare(query)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function state() {
  return env.DB.prepare(`SELECT * FROM external_directory_state WHERE id=1`).first<Record<string, unknown>>()
}

async function run(id: string) {
  return env.DB.prepare("SELECT * FROM external_directory_runs WHERE id=?").bind(id).first<Record<string, unknown>>()
}

async function insertActive(id: string, overrides: Record<string, unknown> = {}) {
  await env.DB.prepare(`INSERT INTO external_directory_runs
    (id,owner_id,status,phase,started_at,next_attempt_at,session_id,session_name,departments_json)
    VALUES (?,?,'running',0,?,?,NULL,NULL,NULL)`)
    .bind(id, OWNER, NOW, NOW)
    .run()
  if (Object.keys(overrides).length) {
    const assignments = Object.keys(overrides).map(key => `${key}=?`).join(",")
    await env.DB.prepare(`UPDATE external_directory_runs SET ${assignments} WHERE id=?`)
      .bind(...Object.values(overrides), id).run()
  }
  await env.DB.prepare("UPDATE external_directory_state SET active_run_id=? WHERE id=1").bind(id).run()
}

async function insertCatalog(id: string, sessionId = TERM.id) {
  await env.DB.prepare(`INSERT INTO external_directory_runs
    (id,owner_id,status,phase,started_at,finished_at,session_id,session_name,departments_json,next_attempt_at)
    VALUES (?,?,'complete',5,?,?,?,?,'[]',?)`)
    .bind(id, OWNER, NOW - WEEK, NOW, sessionId, "2026秋", NOW).run()
  await env.DB.prepare(`UPDATE external_directory_state
    SET catalog_run_id=?,observed_session_id=?,observed_at=? WHERE id=1`)
    .bind(id, sessionId, NOW).run()
}

const item = (id: string, name: string, extra = "", extraFields: Record<string, string> = {}) =>
  ({ id, name, extra, ...extraFields })

async function resetDirectory() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subscriptions WHERE user_id=?").bind(OWNER),
    env.DB.prepare("DELETE FROM external_directory_items"),
    env.DB.prepare("DELETE FROM external_directory_course_cache"),
    env.DB.prepare("DELETE FROM external_directory_runs"),
    env.DB.prepare("DELETE FROM external_directory_state"),
    env.DB.prepare("INSERT INTO external_directory_state (id) VALUES (1)"),
  ])
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] })
  return resetDirectory()
})

afterEach(async () => {
  await resetDirectory()
  vi.useRealTimers()
})

describe("weekly shared directory generation", () => {
  it("collects five core catalogs, publishes atomically, and never requests classes or teachers", async () => {
    const recipes: DirectoryRecipe[] = []
    const directory = vi.fn(async (args: DirectoryArgs): Promise<DirectoryResult | { error: string }> => {
      recipes.push(args)
      if (args.sourceType === "department") {
        return { contractVersion: 1, kind: "catalog", sourceType: args.sourceType, session: TERM, departments: [{ id: "dept-a", name: "计算机学院" }] }
      }
      const rows = args.sourceType === "admin_class"
        ? [item("admin-1", "电气1班", "电气学院 · 2026级", { departmentId: "dept-a", grade: "2026" })]
        : args.sourceType === "course_catalog"
          ? [item("course-1", "大学物理", "PHYS1001", { courseCode: "PHYS1001" })]
          : [item(`${args.sourceType}-1`, `${args.sourceType}目标`)]
      return { contractVersion: 1, kind: "catalog", sourceType: args.sourceType, session: TERM, items: rows }
    })
    const { env: testEnv, send } = harness(directory)
    await insertCatalog("old-core")
    await env.DB.prepare(`UPDATE external_directory_state SET published_run_id='legacy-teacher-run' WHERE id=1`).run()
    await env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name) VALUES ('old-core','admin_class','old','旧班级')`).run()
    const runId = "generation-run"
    await insertActive(runId, { started_at: NOW, failure_count: 2, last_error: "SCHOOL_UNAVAILABLE" })

    for (let phase = 0; phase < 5; phase += 1) {
      await processExternalDirectory(testEnv, message(runId))
      if (phase < 4) vi.setSystemTime(Number((await run(runId))!.next_attempt_at))
    }

    expect(recipes).toHaveLength(5)
    expect(recipes.map(recipe => recipe.kind === "catalog" ? recipe.sourceType : recipe.kind)).toEqual([
      "department", "room", "laboratory", "admin_class", "course_catalog",
    ])
    expect(send).toHaveBeenCalledTimes(4)
    expect(await run(runId)).toMatchObject({
      status: "complete",
      phase: 5,
      lease_token: null,
      failure_count: 0,
      last_error: null,
    })
    expect(await state()).toMatchObject({
      active_run_id: null,
      catalog_run_id: runId,
      published_run_id: "legacy-teacher-run",
      observed_session_id: TERM.id,
      next_due_at: NOW + WEEK,
    })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM external_directory_items WHERE run_id=? AND kind IN ('teaching_class','instructor')`)
      .bind(runId).first()).toEqual({ count: 0 })
    expect(await lookupDirectory(testEnv, "early-reader", { sourceType: "department" })).toMatchObject({
      departments: [{ id: "dept-a", name: "计算机学院" }],
    })
    expect(await lookupDirectory(testEnv, "early-reader", { sourceType: "room", keyword: "room" })).toMatchObject({
      items: [{ id: "room-1", name: "room目标" }],
    })
    expect(await lookupDirectory(testEnv, "early-reader", { sourceType: "course_catalog", keyword: "大学物理" })).toMatchObject({
      items: [{ id: "course-1", name: "大学物理" }],
    })
    expect(await lookupDirectory(testEnv, "early-reader", { sourceType: "instructor", keyword: "教师" })).toBeNull()
  })

  it("terminates a queued legacy teacher-phase run before any Auth RPC", async () => {
    const directory = vi.fn<DirectoryRpc>()
    const { env: testEnv } = harness(directory)
    await insertActive("legacy-teacher-run", {
      phase: 5,
      session_id: TERM.id,
      session_name: TERM.name,
      departments_json: "[]",
    })

    await processExternalDirectory(testEnv, message("legacy-teacher-run"))

    expect(directory).not.toHaveBeenCalled()
    expect(await run("legacy-teacher-run")).toMatchObject({ status: "failed", last_error: "TEACHER_CRAWL_CANCELLED" })
    expect(await state()).toMatchObject({ active_run_id: null })
  })

  it("keeps the previous catalog when an active core stage returns invalid schema", async () => {
    await insertCatalog("old-run")
    await env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name) VALUES ('old-run','admin_class','old','旧班级')`).run()
    const directory = vi.fn(async () => ({ contractVersion: 1, kind: "catalog", sourceType: "room", session: TERM, items: [] }))
    const { env: testEnv } = harness(directory)
    await insertActive("partial-run", {
      phase: 1,
      session_id: TERM.id,
      session_name: TERM.name,
      departments_json: "[]",
    })

    await processExternalDirectory(testEnv, message("partial-run"))

    expect(await lookupDirectory(testEnv, "any-reader", { sourceType: "admin_class", keyword: "旧" })).toMatchObject({
      sourceType: "admin_class",
      session: TERM,
      items: [{ id: "old", name: "旧班级", extra: "" }],
    })
    expect(await state()).toMatchObject({ catalog_run_id: "old-run" })
    expect(await run("partial-run")).toMatchObject({
      status: "running",
      phase: 1,
      failure_count: 1,
      last_error: "BATCH_FAILED",
    })
  })

  it("aborts an old-term generation, invalidates its cache, and retries after the short cooldown", async () => {
    await insertCatalog("old-run", "old-term")
    await env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name) VALUES
      ('old-run','admin_class','old','旧班级')`).run()
    const directory = vi.fn(async () => ({ error: "unexpected-directory-call" }))
    const { env: testEnv, send } = harness(directory)
    await observeDirectorySession(testEnv, "new-term", NOW + 1)
    await insertActive("old-generation", { phase: 1, session_id: "old-term", session_name: "旧学期", departments_json: "[]" })

    expect(await lookupDirectory(testEnv, "any-reader", { sourceType: "admin_class", keyword: "旧" })).toBeNull()
    expect(await lookupDirectory(testEnv, "any-reader", { sourceType: "instructor", keyword: "旧" })).toBeNull()
    await processExternalDirectory(testEnv, message("old-generation"))

    expect(directory).not.toHaveBeenCalled()
    expect(await run("old-generation")).toMatchObject({ status: "failed", last_error: "CURRENT_SESSION_CHANGED" })
    expect(await state()).toMatchObject({ active_run_id: null, catalog_run_id: "old-run", observed_session_id: "new-term", next_due_at: NOW + 15 * 60_000 })

    await scheduleExternalDirectory(testEnv)
    expect(send).not.toHaveBeenCalled()
    vi.setSystemTime(NOW + 15 * 60_000)
    await scheduleExternalDirectory(testEnv)
    expect(send).toHaveBeenCalledOnce()
    const next = await state()
    expect(next?.active_run_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await lookupDirectory(testEnv, "any-reader", { sourceType: "admin_class", keyword: "旧" })).toBeNull()
  })

  it("does not advance twice for a concurrent duplicate or a reply arriving after lease expiry", async () => {
    let releaseOld!: (result: DirectoryResult) => void
    const directory = vi.fn(async (args: DirectoryArgs): Promise<DirectoryResult | { error: string }> => {
      if (directory.mock.calls.length === 1) {
        return new Promise(resolve => { releaseOld = resolve })
      }
      return {
        contractVersion: 1,
        kind: "catalog",
        sourceType: args.sourceType,
        session: TERM,
        departments: [{ id: "dept", name: "学院" }],
      }
    })
    const { env: testEnv } = harness(directory)
    await insertActive("lease-run")

    const oldDelivery = processExternalDirectory(testEnv, message("lease-run"))
    await vi.waitFor(() => expect(directory).toHaveBeenCalledOnce())
    const duplicate = processExternalDirectory(testEnv, message("lease-run"))
    await duplicate
    expect(directory).toHaveBeenCalledOnce()

    vi.setSystemTime(NOW + 121_000)
    const replacement = processExternalDirectory(testEnv, message("lease-run"))
    await replacement
    expect(directory).toHaveBeenCalledTimes(2)
    releaseOld({
      contractVersion: 1,
      kind: "catalog",
      sourceType: "department",
      session: TERM,
      departments: [{ id: "stale-dept", name: "过期学院" }],
    })
    await oldDelivery

    expect(await run("lease-run")).toMatchObject({ status: "running", phase: 1, failure_count: 0 })
    const current = await run("lease-run")
    expect(JSON.parse(String(current?.departments_json))).toEqual([{ id: "dept", name: "学院" }])
    expect(await state()).toMatchObject({ active_run_id: "lease-run", published_run_id: null })
  })

  it("pauses before any school RPC when foreground work shares the owner's browser", async () => {
    const directory = vi.fn(async () => ({ error: "unexpected-school-call" }))
    const { env: testEnv, send } = harness(directory)
    await insertActive("paused-run")

    for (const [status, updatedAt] of [
      ["running", new Date(NOW - 11 * 60_000).toISOString()],
      ["queued", new Date(NOW - 16 * 60_000).toISOString()],
    ] as const) {
      await env.DB.prepare(`INSERT INTO subscriptions
        (id,user_id,source_type,source_id,source_name,sync_status,created_at,updated_at)
        VALUES (?,?,'admin_class','busy-source','繁忙订阅',?,datetime('now'),?)`)
        .bind(`busy-${status}`, OWNER, status, updatedAt).run()
      await processExternalDirectory(testEnv, message("paused-run"))
      expect(directory).not.toHaveBeenCalled()
      expect(await run("paused-run")).toMatchObject({ status: "running", phase: 0, lease_token: null })
      await env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(`busy-${status}`).run()
      await env.DB.prepare(`UPDATE external_directory_runs SET next_attempt_at=?,dispatch_until=0,lease_token=NULL,lease_until=0`)
        .bind(NOW).run()
    }
    expect(send).toHaveBeenCalledTimes(2)

    await processExternalDirectory(testEnv, message("paused-run"), true)

    expect(directory).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[2][1]).toMatchObject({ delaySeconds: expect.any(Number) })
    expect(send.mock.calls[2][1].delaySeconds).toBeGreaterThanOrEqual(120)
    expect(await run("paused-run")).toMatchObject({ status: "running", phase: 0, lease_token: null })
    expect(await state()).toMatchObject({ active_run_id: "paused-run" })
  })

  it("starts a paced weekly run only at the stable due time and honors the owner opt-in", async () => {
    await insertCatalog("previous-run")
    await env.DB.prepare(`UPDATE external_directory_state SET next_due_at=?`).bind(NOW + WEEK).run()
    const directory = vi.fn(async (args: DirectoryArgs): Promise<DirectoryResult | { error: string }> => ({
      contractVersion: 1,
      kind: "catalog",
      sourceType: args.sourceType,
      session: TERM,
      departments: [{ id: "dept", name: "学院" }],
    }))
    const enabled = harness(directory)

    await scheduleExternalDirectory(enabled.env)
    expect(enabled.send).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ active_run_id: null, catalog_run_id: "previous-run" })

    vi.setSystemTime(NOW + WEEK)
    const paddedOwner = { ...enabled.env, EXTERNAL_DIRECTORY_USER_ID: ` \t${OWNER}\n ` } as Env
    await scheduleExternalDirectory(paddedOwner)
    expect(enabled.send).toHaveBeenCalledOnce()
    expect(enabled.send.mock.calls[0][0]).toMatchObject({ userId: OWNER })
    expect(enabled.send.mock.calls[0][1].delaySeconds).toBeGreaterThan(0)
    const started = await state()
    expect(started?.active_run_id).not.toBe("previous-run")
    const scheduled = await run(String(started?.active_run_id))
    vi.setSystemTime(Number(scheduled?.next_attempt_at))
    await processExternalDirectory(enabled.env, message(String(started?.active_run_id)))
    expect(directory).toHaveBeenCalledOnce()
    expect(await run(String(started?.active_run_id))).toMatchObject({ status: "running", phase: 1 })

    await resetDirectory()
    for (const disabled of [
      { EXTERNAL_DIRECTORY_USER_ID: undefined },
      { AUTH: { cquExternalDirectory: undefined } },
    ]) {
      const testEnv = { ...enabled.env, ...disabled } as unknown as Env
      await scheduleExternalDirectory(testEnv)
    }
    expect((await state())?.active_run_id).toBeNull()
  })

  it("cleanup retains the catalog pointer and ignores the retired teacher pointer", async () => {
    await insertCatalog("catalog-run")
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name) VALUES
        ('catalog-run','room','room','教室'),
        ('catalog-run','laboratory','lab','实验室'),
        ('catalog-run','admin_class','admin','班级'),
        ('catalog-run','course_catalog','course','课程')`),
      env.DB.prepare(`INSERT INTO external_directory_runs
        (id,owner_id,status,phase,started_at,finished_at,session_id,session_name,departments_json,next_attempt_at)
        VALUES ('teacher-run',?,'complete',6,?,?,?,'旧学期','[]',0)`).bind(OWNER, NOW - 3 * WEEK, NOW - 2 * WEEK, TERM.id),
      env.DB.prepare(`INSERT INTO external_directory_runs (id,owner_id,started_at)
        VALUES ('unreferenced-run',?,?)`).bind(OWNER, NOW - 3 * WEEK),
      env.DB.prepare(`UPDATE external_directory_runs SET started_at=? WHERE id='catalog-run'`).bind(NOW - 3 * WEEK),
      env.DB.prepare(`UPDATE external_directory_state
        SET active_run_id=NULL,published_run_id='teacher-run',catalog_run_id='catalog-run',next_due_at=? WHERE id=1`)
        .bind(NOW + WEEK),
    ])
    const { env: testEnv } = harness(vi.fn(async () => ({ error: "unexpected-school-call" })))

    await scheduleExternalDirectory(testEnv)

    expect(await env.DB.prepare(`SELECT count(*) AS count FROM external_directory_runs WHERE id='catalog-run'`).first())
      .toEqual({ count: 1 })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM external_directory_runs WHERE id IN ('teacher-run','unreferenced-run')`).first())
      .toEqual({ count: 0 })
    expect(await state()).toMatchObject({ catalog_run_id: "catalog-run", published_run_id: "teacher-run" })
    expect(await lookupDirectory(testEnv, "reader", { sourceType: "admin_class", keyword: "班级" })).toMatchObject({ items: [{ id: "admin" }] })
    expect(await lookupDirectory(testEnv, "reader", { sourceType: "instructor", keyword: "教师" })).toBeNull()
  })
})

describe("published shared-directory lookup", () => {
  beforeEach(async () => {
    await insertCatalog("lookup-run")
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name,extra,department_id,grade) VALUES
        ('lookup-run','admin_class','percent','%班','特殊','dept-a','2026'),
        ('lookup-run','admin_class','underscore','_班','特殊','dept-a','2026'),
        ('lookup-run','admin_class','ordinary','普通班','普通','dept-b','2025')`),
    ])
  })

  it("searches percent and underscore literals with department and grade filters without Auth RPC", async () => {
    const directory = vi.fn(async () => ({ error: "unexpected-school-call" }))
    const { env: testEnv } = harness(directory)
    const input = { sourceType: "admin_class" as const, departmentId: "dept-a", grade: "2026" }

    expect(await lookupDirectory(testEnv, "reader-a", { ...input, keyword: "%" })).toMatchObject({ items: [{ id: "percent" }] })
    expect(await lookupDirectory(testEnv, "reader-a", { ...input, keyword: "_" })).toMatchObject({ items: [{ id: "underscore" }] })
    expect(await lookupDirectory(testEnv, "reader-a", { ...input, keyword: "" })).toMatchObject({
      items: [{ id: "percent" }, { id: "underscore" }],
      truncated: false,
    })
    expect(await lookupDirectory(testEnv, "reader-a", { ...input, keyword: "", grade: "2025" })).toBeNull()
    expect(directory).not.toHaveBeenCalled()
  })

  it("isolates on-demand course-cache entries by user, course ID, and academic term", async () => {
    const { env: testEnv } = harness(vi.fn(async () => ({ error: "unexpected-school-call" })))
    await env.DB.prepare(`UPDATE external_directory_state SET observed_session_id=NULL, observed_at=0`).run()
    const result = (id: string, name: string, sessionId: string): ExternalSearchResult => ({
      contractVersion: 1,
      sourceType: "course",
      course: { id, name },
      session: { id: sessionId, name: sessionId },
      items: [{ id: `${id}-${sessionId}`, name: `${name}教学班`, extra: "" }],
      truncated: false,
    })
    for (const [sessionId, courseId, name] of [
      ["old-term", "course-a", "课程A旧"],
      ["new-term", "course-a", "课程A新"],
      ["new-term", "course-b", "课程B"],
    ]) await cacheDirectoryCourse(testEnv, "user-a", result(courseId, name, sessionId))

    expect(await lookupDirectory(testEnv, "user-a", { sourceType: "course", courseId: "course-a", courseName: "课程A旧", expectedSessionId: "old-term" }))
      .toMatchObject({ course: { id: "course-a", name: "课程A旧" } })
    expect(await lookupDirectory(testEnv, "user-a", { sourceType: "course", courseId: "course-a", courseName: "课程A新", expectedSessionId: "new-term" }))
      .toMatchObject({ course: { id: "course-a", name: "课程A新" } })
    expect(await lookupDirectory(testEnv, "user-a", { sourceType: "course", courseId: "course-b", courseName: "课程B", expectedSessionId: "new-term" }))
      .toMatchObject({ course: { id: "course-b", name: "课程B" } })
    expect(await lookupDirectory(testEnv, "user-a", { sourceType: "course", courseId: "course-a", courseName: "课程A新", expectedSessionId: "old-term" }))
      .toBeNull()
    expect(await lookupDirectory(testEnv, "user-b", { sourceType: "course", courseId: "course-a", courseName: "课程A新", expectedSessionId: "new-term" }))
      .toBeNull()
    await cacheDirectoryCourse(testEnv, "user-b", result("course-a", "用户B课程", "new-term"))
    expect(await lookupDirectory(testEnv, "user-b", { sourceType: "course", courseId: "course-a", courseName: "用户B课程", expectedSessionId: "new-term" }))
      .toMatchObject({ course: { id: "course-a", name: "用户B课程" } })
  })
})

describe("directory term cache fencing", () => {
  it("refuses a known-old per-user KV result after the shared term moves", async () => {
    const user = `stale-${crypto.randomUUID()}`
    const input = { sourceType: "admin_class" as const, keyword: "稳定" }
    const oldResult = { contractVersion: 1, sourceType: "admin_class", session: { id: "old-term", name: "旧学期" }, items: [item("old", "稳定旧班")], truncated: false }
    const newResult = { ...oldResult, session: { id: "new-term", name: "新学期" }, items: [item("new", "稳定新班")] }
    const search = vi.fn(async () => oldResult)
    const { env: testEnv } = harness(vi.fn(async () => ({ error: "unexpected-directory-call" })), search)
    await env.DB.prepare(`UPDATE external_directory_state SET observed_session_id='old-term',observed_at=?`).bind(NOW).run()

    expect(await searchExternal(testEnv, user, input)).toEqual(oldResult)
    await observeDirectorySession(testEnv, "new-term", NOW + 1_000)
    const cacheOnly = await searchExternal(testEnv, user, input, { cacheOnly: true })
    expect(cacheOnly).toBeInstanceOf(Response)
    if (cacheOnly instanceof Response) expect(cacheOnly.status).toBe(409)
    expect(search).toHaveBeenCalledOnce()

    search.mockResolvedValue(newResult)
    expect(await searchExternal(testEnv, user, input)).toEqual(newResult)
    expect(search).toHaveBeenCalledTimes(2)

    const courseUser = `observe-failure-${crypto.randomUUID()}`
    const courseResult: ExternalSearchResult = {
      contractVersion: 1,
      sourceType: "course",
      course: { id: "course-observe", name: "学期写失败课程" },
      session: { id: "new-term", name: "新学期" },
      items: [item("class-observe", "写失败教学班")],
      truncated: false,
    }
    search.mockResolvedValue(courseResult)
    const failingObserveEnv = { ...testEnv, DB: failObservedSessionUpdate(testEnv.DB) } as Env
    const courseInput = {
      sourceType: "course" as const,
      courseId: courseResult.course.id,
      courseName: courseResult.course.name,
      expectedSessionId: "new-term",
    }
    const onFreshSession = vi.fn(async () => undefined)
    const failed = await searchExternal(failingObserveEnv, courseUser, courseInput, { onFreshSession })
    expect(failed).toBeInstanceOf(Response)
    if (failed instanceof Response) {
      expect(failed.status).toBe(503)
      expect(await failed.json()).toMatchObject({ detail: { error: { code: "EXTERNAL_UNAVAILABLE" } } })
    }
    expect(search).toHaveBeenCalledTimes(3)
    expect(onFreshSession).not.toHaveBeenCalled()
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_directory_course_cache WHERE user_id=?")
      .bind(courseUser).first()).toEqual({ count: 0 })

    const retried = await searchExternal(failingObserveEnv, courseUser, courseInput, { onFreshSession })
    expect(retried).toBeInstanceOf(Response)
    expect(search).toHaveBeenCalledTimes(4)
  })
})
