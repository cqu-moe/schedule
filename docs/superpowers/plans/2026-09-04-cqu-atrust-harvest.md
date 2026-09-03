# CQU aTrust Dual-Session Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing direct-CAS ticket session while adding an independent, on-demand aTrust browser session for personal timetable harvest, with serialized ownership of the shared email verification code.

**Architecture:** `auth` owns both browser states, independent login locks, and an account-level verification-code lease. The login node exposes fixed aTrust login and permit endpoints; harvest chooses state by the canonical recipe host and retries exactly once after an aTrust-session expiry. `schedule-cloudflare` only changes its personal-harvest recipe to the aTrust rewritten host and keeps its existing no-empty-overwrite behavior.

**Tech Stack:** Cloudflare Workers, Durable Objects, TypeScript 6, Vitest/workerd, Python 3, aiohttp, patchright, pytest.

**Spec:** `docs/superpowers/specs/2026-09-04-cqu-atrust-harvest-design.md`

## Global Constraints

- Direct CAS and aTrust storage states remain separate and may be logged in concurrently.
- A verification code is shared by the account backend but is consumed by the first successful login; only one login may request and consume a code at a time.
- aTrust login uses fixed code-owned URLs and returns a storage state, never a Service Ticket.
- aTrust harvest recovery performs at most one re-login and one retry in one logical/rate-limited call.
- Allowed harvest hosts are exactly `my.cqu.edu.cn` and `my-cqu-edu-cn-s.atrust.cqu.edu.cn`; every URL in one recipe must use the same host.
- Harvest requests are HTTPS on default port 443, contain no userinfo or backslash, and in-page fetches remain GET-only.
- Failed harvests never become empty successful results and never overwrite the last successful timetable.
- Passwords, verification codes, Service Tickets, cookies, storage states, and timetable bodies never enter logs or persisted test artifacts.
- Do not deploy either repository as part of this plan.

---

### Task 1: Dual-host harvest validation and aTrust expiry protocol

**Files:**
- Modify: `auth/src/services/harvest-url.ts`
- Modify: `auth/src/services/harvest-url.test.ts`
- Modify: `auth/container/cqu_data_harvest.py`
- Modify: `auth/container/test_cqu_data_harvest.py`
- Modify: `auth/container/server.py`
- Modify: `auth/container/test_data_harvest.py`
- Modify: `auth/src/services/cqu-node-protocol.ts`
- Modify: `auth/src/services/cqu-node-protocol.test.ts`

**Interfaces:**
- Produces: `type CquHarvestHost = "direct" | "atrust"`.
- Produces: `validateCquHarvestUrl(input: string): string` for either exact host.
- Produces: `validateCquHarvestRecipeHosts(navUrl: string, fetchUrls: string[]): CquHarvestHost`, returning the selected state kind and rejecting mixed hosts.
- Produces: Python `classify_harvest_host(url: str) -> Literal["direct", "atrust"] | None` and `AtrustHarvestExpiredError`.
- Produces: `NodeHarvestKind = "ok" | "expired" | "atrust_expired" | "transient"` and exact matching of the controlled `ATRUST_SESSION_EXPIRED` response marker.

- [ ] **Step 1: Write failing TypeScript URL tests**

Add tests that accept the two exact hosts, canonicalize default port 443, reject suffix tricks/userinfo/non-443/backslashes, and reject mixed recipes:

```ts
expect(validateCquHarvestUrl("https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"))
  .toBe("https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum");
expect(() => validateCquHarvestRecipeHosts(
  "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum",
  ["https://my.cqu.edu.cn/api/exam/x"],
)).toThrow("same host");
```

- [ ] **Step 2: Run the TypeScript tests and confirm the new cases fail**

Run: `npm test -- src/services/harvest-url.test.ts src/services/cqu-node-protocol.test.ts`

Expected: the aTrust host and `atrust_expired` expectations fail because only direct CAS is currently modeled.

- [ ] **Step 3: Implement the TypeScript validators and node classification**

Use an exact hostname map and return canonical URLs only:

```ts
const HARVEST_HOSTS = new Map([
  ["my.cqu.edu.cn", "direct"],
  ["my-cqu-edu-cn-s.atrust.cqu.edu.cn", "atrust"],
] as const);

export function validateCquHarvestRecipeHosts(
  navUrl: string,
  fetchUrls: string[],
): CquHarvestHost {
  const nav = new URL(validateCquHarvestUrl(navUrl));
  const kind = HARVEST_HOSTS.get(nav.hostname)!;
  for (const raw of fetchUrls) {
    if (new URL(validateCquHarvestUrl(raw)).hostname !== nav.hostname) {
      throw new Error("harvest recipe URLs must use the same host");
    }
  }
  return kind;
}
```

In `classifyNodeHarvestResponse`, treat only `status === 409 && body?.error === "ATRUST_SESSION_EXPIRED"` as `atrust_expired`; retain the existing direct 409 behavior for every other body.

- [ ] **Step 4: Write failing Python validation and expiry tests**

Cover exact-host classification, mixed-host rejection, and redirects to the aTrust portal/rewritten SSO:

```py
assert classify_harvest_host(
    "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
) == "atrust"

with pytest.raises(HarvestRecipeError):
    parse_harvest_recipe({
        "navUrl": "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum",
        "capture": [],
        "fetch": [{"method": "GET", "url": "https://my.cqu.edu.cn/api/x"}],
    })
```

- [ ] **Step 5: Run the Python tests and confirm failure**

Run: `pytest -q container/test_cqu_data_harvest.py container/test_data_harvest.py`

Expected: aTrust URL acceptance and aTrust-specific expiry response cases fail.

- [ ] **Step 6: Implement Python host parity and the controlled 409 marker**

Store `hostKind` in the normalized recipe. When an aTrust recipe ends on the portal host or rewritten SSO host, raise `AtrustHarvestExpiredError`; map it in `server.py` to:

```py
return web.json_response(
    {"ok": False, "error": "ATRUST_SESSION_EXPIRED"}, status=409
)
```

Keep direct CAS expiry mapped to the existing generic 409 path.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npm test -- src/services/harvest-url.test.ts src/services/cqu-node-protocol.test.ts
npm run typecheck
pytest -q container/test_cqu_data_harvest.py container/test_data_harvest.py
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the auth validator/protocol slice**

```bash
git add src/services/harvest-url.ts src/services/harvest-url.test.ts \
  src/services/cqu-node-protocol.ts src/services/cqu-node-protocol.test.ts \
  container/cqu_data_harvest.py container/test_cqu_data_harvest.py \
  container/server.py container/test_data_harvest.py
git commit -S -m "feat(cqu): support aTrust harvest host classification"
```

---

### Task 2: Login-node code permit and fixed aTrust login

**Files:**
- Create: `auth/container/cqu_atrust.py`
- Create: `auth/container/test_cqu_atrust.py`
- Modify: `auth/container/cqu_login.py`
- Modify: `auth/container/test_run_login_proxy.py`
- Modify: `auth/container/server.py`
- Create: `auth/container/test_atrust_login_server.py`

**Interfaces:**
- Consumes: existing `do_first_factor`, `switch_2fa_tab`, `request_code`, `classify_send_code`, `submit_code`, and browser-launch settings from `cqu_login.py`.
- Produces: `run_atrust_login(student_id, password, method, code_provider, permit_provider, proxy=None) -> {"state": object}`.
- Produces: `POST /atrust-login` with `{studentId,password,method,session}` and no caller-supplied URLs.
- Produces: `POST /code-permit` with `{session}`.
- Produces: per-session permit events with early-arrival caching and cleanup in the login request `finally` block.

- [ ] **Step 1: Write failing permit tests for the existing CAS login**

Extend the `run_login` tests with an async permit provider and assert ordering:

```py
events = []

async def permit_provider():
    events.append("permit")

async def code_provider():
    events.append("code")
    return "123456"

# request_code is stubbed to append "request".
assert events == ["permit", "request", "code"]
```

- [ ] **Step 2: Run the focused CAS-login test and confirm failure**

Run: `pytest -q container/test_run_login_proxy.py`

Expected: `run_login` does not accept/invoke `permit_provider` yet.

- [ ] **Step 3: Add the optional permit seam to `run_login`**

Add `permit_provider=None`; after the first factor reaches 2FA and after selecting the mail tab, call `await permit_provider()` before `request_code`. Existing CLI behavior remains unchanged by treating `None` as immediate permission.

- [ ] **Step 4: Write failing fixed-URL aTrust-login tests**

Mock patchright and assert:

```py
assert ATRUST_APP_URL == "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
assert result.keys() == {"state"}
assert "ticket" not in result
```

Also assert the portal selector uses exact visible text `统一身份认证`, the first-factor page has hostname `sso-cqu-edu-cn-s.atrust.cqu.edu.cn`, and success ends on `my-cqu-edu-cn-s.atrust.cqu.edu.cn`.

- [ ] **Step 5: Implement `cqu_atrust.py`**

Define fixed constants and the exact orchestration signature
`run_atrust_login(student_id, password, method="mail", code_provider=None,
permit_provider=None, proxy=None) -> dict`. The implementation opens the fixed
app URL, selects the exact portal entry, validates each navigation host, reuses
the existing first-factor/2FA helpers, exports `context.storage_state()`, closes
the browser in `finally`, and returns exactly `{ "state": state }`.

```py
ATRUST_APP_URL = "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
ATRUST_SSO_HOST = "sso-cqu-edu-cn-s.atrust.cqu.edu.cn"
ATRUST_APP_HOST = "my-cqu-edu-cn-s.atrust.cqu.edu.cn"
```

The function must not accept service/passport/entry URLs and must not return a ticket.

- [ ] **Step 6: Write failing aiohttp endpoint tests**

Test that `/atrust-login` rejects missing credentials, ignores/rejects caller URL fields by never forwarding them, waits for `/code-permit`, accepts a permit that arrived before event registration, and clears code/permit dictionaries after success, failure, and timeout.

- [ ] **Step 7: Implement `/atrust-login` and `/code-permit`**

Use separate dictionaries:

```py
PERMIT_EVENTS: dict[str, asyncio.Event] = {}
PERMIT_VALUES: dict[str, float] = {}
```

`/code-permit` records an early permit before looking up the event. Both `/run` and `/atrust-login` register a permit waiter; `/atrust-login` calls `cqu_atrust.run_atrust_login`; every request removes its own permit and code state in `finally`.

- [ ] **Step 8: Run the container test suite**

Run: `pytest -q container`

Expected: all container tests pass with no credential-bearing logs.

- [ ] **Step 9: Commit the login-node slice**

```bash
git add container/cqu_login.py container/cqu_atrust.py container/server.py \
  container/test_run_login_proxy.py container/test_cqu_atrust.py \
  container/test_atrust_login_server.py
git commit -S -m "feat(cqu): add isolated aTrust browser login"
```

---

### Task 3: Durable Object verification-code lease

**Files:**
- Create: `auth/src/services/cqu-2fa/code-lease.ts`
- Create: `auth/src/services/cqu-2fa/code-lease.test.ts`
- Modify: `auth/src/durable-objects/cqu-session.ts`
- Modify: `auth/test/do/helpers.ts`
- Modify: `auth/test/do/cqu-session.do.test.ts`

**Interfaces:**
- Produces: `type LoginKind = "cas" | "atrust"`.
- Produces: `CodeLease`, `CodeLeaseEntry`, `acquireCodeLease`, `releaseCodeLease`, and `pruneCodeLease` as pure immutable helpers.
- Produces: separate storage records `loginInFlight` and `atrustLoginInFlight`.
- Produces: DO side effect `grantCodePermit(ownerToken)` calling node `POST /code-permit`.
- Changes: `depositCode` pushes `/code` only to `codeLease.ownerToken`; the existing live-panel broadcast remains, but no code is broadcast to both node sessions.

- [ ] **Step 1: Write failing pure lease tests**

Cover first-owner acquisition, FIFO queueing, idempotent enqueue by token, release/promotion, and pruning at `LOGIN_LOCK_TTL_MS`:

```ts
const first = acquireCodeLease(null, { token: "cas-1", kind: "cas", queuedAt: 1 }, 1);
const second = acquireCodeLease(first, { token: "atrust-1", kind: "atrust", queuedAt: 2 }, 2);
expect(second.ownerToken).toBe("cas-1");
expect(second.queue.map((entry) => entry.token)).toEqual(["atrust-1"]);
expect(releaseCodeLease(second, "cas-1", 3).ownerToken).toBe("atrust-1");
```

- [ ] **Step 2: Run the pure tests and confirm failure**

Run: `npm test -- src/services/cqu-2fa/code-lease.test.ts`

Expected: module/functions do not exist.

- [ ] **Step 3: Implement immutable lease helpers**

Use exact interfaces:

```ts
export interface CodeLeaseEntry {
  token: string;
  kind: LoginKind;
  queuedAt: number;
}

export interface CodeLease {
  ownerToken: string;
  ownerKind: LoginKind;
  acquiredAt: number;
  queue: CodeLeaseEntry[];
}
```

Return `null` when pruning removes the owner and no valid queued entry remains.

- [ ] **Step 4: Write failing workerd tests for independent locks and delivery**

Seed both lock keys, acquire both lease entries, and assert:

```ts
expect(await readStorage(stub, "loginInFlight")).toMatchObject({ token: "cas-1" });
expect(await readStorage(stub, "atrustLoginInFlight")).toMatchObject({ token: "atrust-1" });
expect(pathsOf(spy)).toContain("/code-permit");
expect(codeBodies(spy)).toEqual([{ session: "cas-1", code: "123456" }]);
```

After releasing `cas-1`, assert that `/code-permit` is called for `atrust-1`, not that the old code is forwarded again.

- [ ] **Step 5: Implement DO lease orchestration**

Before either login may request a code, enqueue `{token, kind}` in `codeLease`. If it becomes owner, call `/code-permit`. In `finally`, release only the completing token, delete a consumed `pendingCode` after success, promote the FIFO head, persist the new lease, and grant the promoted owner a fresh permit.

Prune stale owners and queue entries using the existing `LOGIN_LOCK_TTL_MS`; never log tokens or codes.

- [ ] **Step 6: Run pure and workerd tests**

Run:

```bash
npm test -- src/services/cqu-2fa/code-lease.test.ts
npm run test:do -- test/do/cqu-session.do.test.ts
npm run typecheck
npm run typecheck:do
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the lease slice**

```bash
git add src/services/cqu-2fa/code-lease.ts src/services/cqu-2fa/code-lease.test.ts \
  src/durable-objects/cqu-session.ts test/do/helpers.ts test/do/cqu-session.do.test.ts
git commit -S -m "feat(cqu): serialize shared verification-code use"
```

---

### Task 4: Independent aTrust state and one-shot harvest recovery

**Files:**
- Modify: `auth/src/durable-objects/cqu-session.ts`
- Modify: `auth/src/services/cqu-error-status.ts`
- Modify: `auth/src/services/cqu-error-status.test.ts`
- Modify: `auth/test/do/helpers.ts`
- Modify: `auth/test/do/cqu-session.do.test.ts`

**Interfaces:**
- Produces: storage key `atrustSession` with `AtrustSessionRecord`.
- Produces: `containerAtrustLogin(): Promise<"in_flight" | "ok" | "failed">` using `/atrust-login` and `atrustLoginInFlight`.
- Produces: `ensureAtrustSession(): Promise<AtrustSessionRecord>` for on-demand login.
- Produces local aliases `CanonicalHarvestRecipe = { navUrl: string; capture: string[]; fetch: { method?: string; url: string }[] }` and `HarvestResult = { captures: HarvestCapture[]; fetches: HarvestFetch[] }` so selection/recovery helpers share one signature.
- Changes: `dataHarvest` selects `state.storageState` for `direct` and `atrustSession.storageState` for `atrust`.
- Produces errors: `ATRUST_SESSION_EXPIRED`, `ATRUST_NEEDS_REAUTH`, `ATRUST_LOGIN_IN_FLIGHT`, and `ATRUST_TRANSIENT` with explicit HTTP mappings.

- [ ] **Step 1: Write failing workerd tests for on-demand state selection**

Cover:

1. An aTrust recipe with no `atrustSession` calls `/atrust-login` then `/data-harvest`.
2. The normal `state.storageState` remains byte-for-byte unchanged.
3. A second aTrust harvest reuses `atrustSession` and does not call `/atrust-login`.
4. A direct recipe still uses normal state and does not read/modify `atrustSession`.

- [ ] **Step 2: Run the focused workerd tests and confirm failure**

Run: `npm run test:do -- test/do/cqu-session.do.test.ts`

Expected: aTrust calls are rejected or use the direct state.

- [ ] **Step 3: Implement guarded independent state persistence**

Add:

```ts
interface AtrustSessionRecord {
  status: "missing" | "active" | "needs_reauth";
  storageState: CquStorageState | null;
  loginAt: number;
  lastUsedAt: number;
  consecutiveFailures: number;
}
```

Use `serializedStateBytes(record)` and `stateExceedsHardLimit` before each put. Never call `putStateGuarded` with an aTrust record.

- [ ] **Step 4: Implement on-demand `/atrust-login`**

Decrypt the existing stored credentials, create `atrustLoginInFlight`, join the verification-code lease as kind `atrust`, call the fixed node endpoint, require a non-null storage state, persist only `atrustSession`, and release the lock/lease in `finally`.

Only three explicit password rejections increment `consecutiveFailures` into `needs_reauth`; code failures, DOM drift, timeouts, and network errors map to `ATRUST_TRANSIENT` and preserve potentially valid state.

- [ ] **Step 5: Write failing one-recovery and one-accounting tests**

Mock node responses in order:

```ts
// saved aTrust state attempt -> expired; relogin -> state; retry -> success
["/data-harvest:409 ATRUST_SESSION_EXPIRED", "/atrust-login:200", "/data-harvest:200"]
```

Assert there is one rate-limit/audit record, `attempts === 2`, no third `/data-harvest` call, no direct-state mutation, and only the aTrust lock/session is replaced.

- [ ] **Step 6: Implement exactly-one recovery inside `dataHarvest`**

Validate and account before starting attempts. Isolate the non-recursive retry
in a helper with this exact shape:

```ts
private async harvestAtrustWithOneRecovery(
  initial: AtrustSessionRecord,
  recipe: CanonicalHarvestRecipe,
): Promise<{ result: HarvestResult; attempts: 1 | 2; recovered: boolean }> {
  try {
    const result = await this.harvestViaNode(initial.storageState, recipe);
    return { result, attempts: 1, recovered: false };
  } catch (error) {
    if (!(error instanceof CquSsoError) || error.code !== "ATRUST_SESSION_EXPIRED") {
      throw error;
    }
  }
  await this.ctx.storage.delete("atrustSession");
  const fresh = await this.ensureAtrustSession();
  const result = await this.harvestViaNode(fresh.storageState, recipe);
  return { result, attempts: 2, recovered: true };
}
```

Do not recurse. Emit one final audit line containing only `attempts` and `recovered`, never response bodies.

- [ ] **Step 7: Clear aTrust state at credential/security boundaries**

Extend credential update/rebind, unbind/destroy, revoke, and relevant reset paths to delete `atrustSession`, `atrustLoginInFlight`, and any lease entry owned by the removed aTrust token. Keep direct CAS state semantics unchanged.

- [ ] **Step 8: Run all auth checks**

Run:

```bash
npm test
npm run test:do
npm run typecheck
npm run typecheck:do
pytest -q container
```

Expected: Node tests, workerd integration tests, both typechecks, and container pytest all exit 0.

- [ ] **Step 9: Commit the DO session/recovery slice**

```bash
git add src/durable-objects/cqu-session.ts src/services/cqu-error-status.ts \
  src/services/cqu-error-status.test.ts test/do/helpers.ts test/do/cqu-session.do.test.ts
git commit -S -m "feat(cqu): harvest through independent aTrust sessions"
```

---

### Task 5: Switch the schedule recipe without weakening data preservation

**Files:**
- Modify: `schedule-cloudflare/src/services/cqu-harvest.ts`
- Modify: `schedule-cloudflare/src/services/cqu-harvest.test.ts`

**Interfaces:**
- Produces: personal harvest recipes whose `navUrl` and every `fetch[].url` use `my-cqu-edu-cn-s.atrust.cqu.edu.cn`.
- Preserves: `mapHarvestToSessionContext`, `mapHarvestToPersonalData`, KV success-only cache, required capture/fetch checks, D1 write flow, and ICS generation.

- [ ] **Step 1: Change the schedule tests first**

Introduce one base constant in the test and assert exact host consistency in phase 1 and phase 2:

```ts
const ATRUST_HOST = "my-cqu-edu-cn-s.atrust.cqu.edu.cn";
const urls = [args.navUrl, ...args.fetch.map(({ url }) => url)];
expect(urls.map((url) => new URL(url).hostname)).toEqual(
  urls.map(() => ATRUST_HOST),
);
```

Also assert response matching continues to use path substrings, so rewritten response URLs still map to the same parsers.

- [ ] **Step 2: Run the focused schedule test and confirm failure**

Run: `npm test -- src/services/cqu-harvest.test.ts`

Expected: current recipe still targets `my.cqu.edu.cn`.

- [ ] **Step 3: Change only the recipe base host**

Use:

```ts
const CQU_HARVEST_ORIGIN = "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn";
const NAV_URL = `${CQU_HARVEST_ORIGIN}/workspace/curriculum`;
```

Build exam and session-info URLs from the same origin. Do not alter mapping or persistence code.

- [ ] **Step 4: Run schedule regression checks**

Run:

```bash
npm test
npm run typecheck
```

Expected: all schedule tests and TypeScript checks pass, including missing/non-2xx body tests that protect prior D1/ICS data.

- [ ] **Step 5: Commit the schedule switch**

```bash
git add src/services/cqu-harvest.ts src/services/cqu-harvest.test.ts
git commit -S -m "feat(cqu): route personal harvest through aTrust"
```

---

### Task 6: Contract documentation and final acceptance

**Files:**
- Modify: `auth/docs/subsystem-integration-guide.md`
- Modify: `schedule-cloudflare/docs/superpowers/plans/2026-09-04-cqu-atrust-harvest.md` (checkboxes only as tasks complete)

**Interfaces:**
- Documents: the two allowed hosts, independent session behavior, on-demand aTrust login, shared-code lease ordering, one-shot recovery, and stable caller-facing error behavior.

- [ ] **Step 1: Update the integration guide**

Document that `cquHarvest` accepts only a single-host recipe on one of the two exact hosts; the aTrust host triggers independent state establishment/recovery; errors preserve the caller's last successful timetable; no aTrust Service Ticket is exposed.

- [ ] **Step 2: Run fresh full automated verification in auth**

Run:

```bash
npm test
npm run test:do
npm run typecheck
npm run typecheck:do
pytest -q container
```

Record pass/fail counts from current output.

- [ ] **Step 3: Run fresh full automated verification in schedule-cloudflare**

Run:

```bash
npm test
npm run typecheck
```

Record pass/fail counts from current output.

- [ ] **Step 4: Run the real-browser acceptance script without persisting secrets**

Using the existing ephemeral script/harness, verify:

1. Direct CAS can still mint a Service Ticket.
2. First aTrust harvest reaches `my-table-detail` with HTTP 200.
3. A second harvest reuses the saved aTrust state and sends no new verification code.
4. Forced aTrust expiry reauthenticates only aTrust, retries harvest exactly once, and leaves direct ticket minting intact.
5. Captured logs contain no password, code, ticket, cookie, storage state, or timetable body.

Keep credentials/code in memory only and remove ephemeral browser states when the process exits.

- [ ] **Step 5: Commit documentation and plan completion**

In `auth`:

```bash
git add docs/subsystem-integration-guide.md
git commit -S -m "docs(cqu): document aTrust harvest contract"
```

In `schedule-cloudflare`:

```bash
git add docs/superpowers/plans/2026-09-04-cqu-atrust-harvest.md
git commit -S -m "docs(cqu): add aTrust harvest implementation plan"
```

- [ ] **Step 6: Verify every new commit is signed and both worktrees are clean**

Run in each repository:

```bash
git log --show-signature --oneline origin/main..HEAD
git status --short --branch
```

Expected: every new commit shows a good SSH signature; both branches are only ahead of `origin/main` with no uncommitted files. Stop before push or deployment and report the two commit ranges plus real-browser evidence.
