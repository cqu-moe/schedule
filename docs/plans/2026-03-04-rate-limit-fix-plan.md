# Rate Limit 缺失修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给 `GET /api/v1/subscriptions` 和 `DELETE /api/v1/subscriptions/:sub_token` 添加 `AUTH_LIMITER` rate limiting。

**Architecture:** 在已有中间件链中插入 `rateLimit("AUTH_LIMITER")`，与其他认证端点保持一致。`rateLimit` 中间件已存在于 `src/middleware/rate-limit.ts`，无需新增代码。

**Tech Stack:** Hono middleware, Cloudflare Rate Limiting binding

**Design doc:** `docs/plans/2026-03-04-rate-limit-fix-design.md`

---

### Task 1: Add AUTH_LIMITER to two endpoints

**Files:**
- Modify: `src/routes/subscriptions.ts:31` — GET handler
- Modify: `src/routes/subscriptions.ts:195` — DELETE handler

**Step 1: Add rate limit middleware to GET /**

In `src/routes/subscriptions.ts`, change line 31 from:

```typescript
app.get("/", requireAuth, async (c) => {
```

to:

```typescript
app.get("/", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
```

**Step 2: Add rate limit middleware to DELETE /:sub_token**

In `src/routes/subscriptions.ts`, change line 195 from:

```typescript
app.delete("/:sub_token", requireAuth, async (c) => {
```

to:

```typescript
app.delete("/:sub_token", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors)

**Step 4: Run tests**

Run: `npx vitest run src/`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add src/routes/subscriptions.ts
git commit -m "fix(security): add rate limiting to GET /subscriptions and DELETE /subscriptions/:sub_token

Closes #33"
```
