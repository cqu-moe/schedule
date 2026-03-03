# User Enumeration Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate user enumeration on registration and recover/verify endpoints by moving SSO verification before DB lookup.

**Architecture:** Both vulnerable endpoints are refactored to call `login()` first, then query the DB. Registration handles existing users by updating their OAuth tokens and returning the existing `calendar_token`. recover/verify returns a unified `INVALID_CREDENTIALS` error when the user doesn't exist (indistinguishable from SSO failure).

**Tech Stack:** Hono, Drizzle ORM, D1, Web Crypto API, vitest (backend v3, frontend v4)

**Design doc:** `docs/plans/2026-03-03-user-enumeration-fix-design.md`

---

### Task 1: Refactor registration endpoint — SSO first, then DB

**Files:**
- Modify: `src/routes/users.ts:37-136`

**Step 1: Reorder the registration handler**

Replace lines 58-136 (after input validation) with this logic:

```typescript
  const db = drizzle(c.env.DB);

  // Verify via SSO login FIRST (prevents user enumeration)
  let tokenResult;
  try {
    tokenResult = await login(body.student_id, body.password);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError(e);
    throw e;
  }

  const encryptedPw = await encrypt(body.password, c.env.ENCRYPTION_KEY);
  const encryptedAccessToken = await encrypt(tokenResult.accessToken, c.env.ENCRYPTION_KEY);
  const encryptedRefreshToken = await encrypt(tokenResult.refreshToken, c.env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  // Check if user already exists
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.studentId, body.student_id))
    .limit(1);

  if (existing) {
    // User exists — update OAuth tokens (keeps them fresh), return existing calendar_token
    await db
      .update(users)
      .set({
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: tokenResult.expiresAt,
        lastLoginAt: now,
        loginError: null,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id));

    return c.json({ calendar_token: existing.calendarToken });
  }

  // New user — create with subscriptions (unchanged from current logic)
  const calendarToken = generateToken();

  const [newUser] = await db
    .insert(users)
    .values({
      studentId: body.student_id,
      encryptedPassword: encryptedPw,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      calendarToken,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Create 3 personal subscriptions (unchanged)
  const personalSubValues = [
    { sourceType: "personal_all", sourceName: "全部课表" },
    { sourceType: "personal_courses", sourceName: "仅课程" },
    { sourceType: "personal_exams", sourceName: "仅考试" },
  ].map(({ sourceType, sourceName }) => ({
    userId: newUser.id,
    sourceType,
    sourceId: body.student_id,
    sourceName,
    calendarToken: generateToken(),
    isPersonal: true,
    createdAt: now,
    updatedAt: now,
  }));

  const newSubs = await db
    .insert(subscriptions)
    .values(personalSubValues)
    .returning({ id: subscriptions.id, sourceType: subscriptions.sourceType });

  c.executionCtx.waitUntil(
    syncNewUserSubscriptions(
      c.env,
      newUser.id,
      body.student_id,
      tokenResult.accessToken,
      newSubs,
    ),
  );

  return c.json({ calendar_token: calendarToken });
```

Key changes from current code:
- `login()` is called **before** the DB query (was after)
- Removed the `if (existing) return 409` early return
- Added `if (existing)` branch that updates OAuth tokens and returns existing `calendar_token`
- `encryptedPw`, `encryptedAccessToken`, `encryptedRefreshToken` are computed once and used in both branches
- The `existing` branch also clears `loginError` (same as recover/verify does)

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no new type errors)

**Step 3: Run backend tests**

Run: `npm test -- src/routes/users.test.ts`
Expected: PASS (existing tests only cover `syncNewUserSubscriptions`, not the HTTP endpoint)

**Step 4: Commit**

```
fix(security): prevent user enumeration on registration (#15)

Move SSO login() before DB lookup. Existing users get their OAuth
tokens updated and receive their existing calendar_token (200),
indistinguishable from new registration.
```

---

### Task 2: Refactor recover/verify endpoint — SSO first, then DB

**Files:**
- Modify: `src/routes/users.ts:196-253`

**Step 1: Reorder the recover/verify handler**

Replace lines 213-252 (after input validation) with this logic:

```typescript
  const db = drizzle(c.env.DB);

  // Verify via SSO login FIRST (prevents user enumeration)
  let tokenResult;
  try {
    tokenResult = await login(body.student_id, body.password);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError(e);
    throw e;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.studentId, body.student_id))
    .limit(1);

  // User not registered — return same error as SSO failure
  if (!user) {
    return errorResponse("INVALID_CREDENTIALS", "Invalid credentials", 401);
  }

  const encryptedPw = await encrypt(body.password, c.env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  const encryptedAccessToken = await encrypt(tokenResult.accessToken, c.env.ENCRYPTION_KEY);
  const encryptedRefreshToken = await encrypt(tokenResult.refreshToken, c.env.ENCRYPTION_KEY);

  await db
    .update(users)
    .set({
      encryptedPassword: encryptedPw,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      lastLoginAt: now,
      loginError: null,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return c.json({ calendar_token: user.calendarToken });
```

Key change: `login()` is called **before** the DB query. If the user doesn't exist, the same `INVALID_CREDENTIALS` error is returned — but only **after** SSO verification has consumed time, eliminating timing side-channels.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run backend tests**

Run: `npm test -- src/routes/users.test.ts`
Expected: PASS

**Step 4: Commit**

```
fix(security): prevent user enumeration on recover/verify (#15)

Move SSO login() before DB lookup. Non-existent users receive
INVALID_CREDENTIALS after SSO verification, indistinguishable
from SSO auth failure.
```

---

### Task 3: Remove USER_EXISTS from frontend error mapping

**Files:**
- Modify: `frontend/src/utils/error.ts:4`
- Modify: `frontend/src/utils/__tests__/error.test.ts:20-33`
- Modify: `frontend/src/stores/__tests__/auth.test.ts:99-112`

**Step 1: Remove USER_EXISTS from CODE_MESSAGES**

In `frontend/src/utils/error.ts`, delete line 4:

```typescript
  USER_EXISTS: '该账号已注册，请使用 Token 登录',
```

**Step 2: Remove USER_EXISTS test cases from error.test.ts**

In `frontend/src/utils/__tests__/error.test.ts`, delete the two test cases:

- `it('maps USER_EXISTS error code to message', ...)` (lines 20-23)
- `it('prefers code mapping over error.message', ...)` (lines 30-33)

**Step 3: Remove USER_EXISTS test case from auth.test.ts**

In `frontend/src/stores/__tests__/auth.test.ts`, delete:

- `it('returns already registered error on USER_EXISTS', ...)` (lines 99-112)

**Step 4: Run frontend tests**

Run: `npm run test:frontend`
Expected: PASS (all remaining tests pass)

**Step 5: Commit**

```
fix(security): remove USER_EXISTS frontend error mapping (#15)

Dead code after backend no longer returns 409 USER_EXISTS.
```

---

### Task 4: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Verify no remaining USER_EXISTS references**

Run: `grep -r "USER_EXISTS" src/ frontend/src/`
Expected: No matches
