# 1Password Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the frontend Token input compatible with 1Password autofill and add "Save in 1Password" buttons on Register/Recover success pages.

**Architecture:** Add `type="password"` + `autocomplete="current-password"` to Login token input for autofill. Install `@1password/save-button` and render the custom element after token display in Register/Recover views, encoding the token as a login save request.

**Tech Stack:** Vue 3, `@1password/save-button` npm package

**Design doc:** `docs/plans/2026-02-26-1password-integration-design.md`

---

### Task 1: Install `@1password/save-button`

**Files:**
- Modify: `frontend/package.json`

**Step 1: Install the package**

Run from `frontend/` directory:
```bash
cd /Users/uu/Documents/Coding/cqu-moe/schedule-cloudflare/frontend && npm install @1password/save-button
```

**Step 2: Verify installation**

```bash
ls frontend/node_modules/@1password/save-button/index.js
```
Expected: file exists

**Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat: add @1password/save-button dependency"
```

---

### Task 2: Optimize Login token input for 1Password autofill

**Files:**
- Modify: `frontend/src/views/Login.vue:13`

**Step 1: Add password type and autocomplete attributes**

In `Login.vue` line 13, change:
```html
<Input id="token" v-model="tokenInput" placeholder="请输入你的 Token" />
```
to:
```html
<Input id="token" v-model="tokenInput" type="password" autocomplete="current-password" spellcheck="false" placeholder="请输入你的 Token" />
```

These attributes are passed through to the native `<input>` via Vue's attribute inheritance (the Input component doesn't explicitly define `type`/`autocomplete` props, but Vue forwards them to the root `<input>` element).

**Step 2: Verify dev server renders correctly**

Run `npm run dev:frontend`, navigate to `/login`, inspect the `<input>` element in DevTools:
- `type="password"` — input shows dots
- `autocomplete="current-password"` — attribute present
- `spellcheck="false"` — attribute present

**Step 3: Commit**

```bash
git add frontend/src/views/Login.vue
git commit -m "feat: add password type and autocomplete to login token input"
```

---

### Task 3: Add Save in 1Password button to Register success dialog

**Files:**
- Modify: `frontend/src/views/Register.vue`

**Step 1: Add the import and helper**

In `Register.vue` `<script setup>`, add after the existing imports (after line 99):

```js
import { encodeOPSaveRequest, activateOPButton } from '@1password/save-button'
```

Add a computed/function to generate the encoded save request. After `const hcaptchaRef = ref(null)` (line 116), add:

```js
const opSaveValue = ref('')
```

**Step 2: Generate save request when token is displayed**

In the `handleRegister()` function, after `displayToken.value = result.token` (line 174), add:

```js
opSaveValue.value = encodeOPSaveRequest({
  title: 'CQU Schedule',
  fields: [{ autocomplete: 'current-password', value: result.token }],
})
```

After `showTokenDialog.value = true` (line 175), add:

```js
nextTick(() => activateOPButton())
```

Also add `nextTick` to the imports on line 84:
```js
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
```

**Step 3: Add the button to the Token Dialog template**

In the Token Dialog (between the token display `<div>` closing tag on line 72 and `<DialogFooter>` on line 73), add:

```html
<onepassword-save-button
  v-if="opSaveValue"
  data-onepassword-type="login"
  :value="opSaveValue"
  lang="zh-CN"
  padding="none"
/>
```

Use `padding="none"` so the button sits naturally in the dialog layout without extra margin.

**Step 4: Verify in dev server**

Run `npm run dev:frontend`, register a test account, verify:
- Token dialog shows the Save in 1Password button below the token display
- Button renders (may be disabled if no 1Password extension — that's expected)
- Layout looks clean with the button between token and "我已保存"

**Step 5: Commit**

```bash
git add frontend/src/views/Register.vue
git commit -m "feat: add Save in 1Password button to register success dialog"
```

---

### Task 4: Add Save in 1Password button to Recover success page

**Files:**
- Modify: `frontend/src/views/Recover.vue`

**Step 1: Add the import and state**

In `Recover.vue` `<script setup>`, add after existing imports (after line 88):

```js
import { encodeOPSaveRequest, activateOPButton } from '@1password/save-button'
```

After `const hcaptchaRef = ref(null)` (line 102), add:

```js
const opSaveValue = ref('')
```

Add `nextTick` to Vue imports on line 77:
```js
import { ref, reactive, onMounted, nextTick } from 'vue'
```

**Step 2: Generate save request on token recovery**

In `handleRecover()`, after `recoveredToken.value = data.calendar_token` (line 137), add:

```js
opSaveValue.value = encodeOPSaveRequest({
  title: 'CQU Schedule',
  fields: [{ autocomplete: 'current-password', value: data.calendar_token }],
})
```

After `step.value = 'success'` (line 139), add:

```js
nextTick(() => activateOPButton())
```

Do the same in `handleVerify()` — after `recoveredToken.value = data.calendar_token` (line 167), add the same `opSaveValue.value = ...` line. After `step.value = 'success'` (line 169), add the same `nextTick(...)` call.

**Step 3: Add the button to the success template**

In the success section (`step === 'success'`), between the token display `<div>` closing tag (line 64) and the "进入仪表盘" `<Button>` (line 65), add:

```html
<onepassword-save-button
  v-if="opSaveValue"
  data-onepassword-type="login"
  :value="opSaveValue"
  lang="zh-CN"
  padding="none"
/>
```

**Step 4: Verify in dev server**

Run `npm run dev:frontend`, test recover flow, verify:
- Success page shows Save in 1Password button between token and "进入仪表盘"
- Button renders correctly

**Step 5: Commit**

```bash
git add frontend/src/views/Recover.vue
git commit -m "feat: add Save in 1Password button to recover success page"
```

---

### Task 5: Build and verify

**Step 1: Build frontend**

```bash
cd /Users/uu/Documents/Coding/cqu-moe/schedule-cloudflare && npm run build:frontend
```

Expected: build succeeds with no errors.

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors (frontend is JS, so this mainly checks Worker code isn't broken).

**Step 3: Final commit (if any changes needed)**

If build revealed issues, fix and commit. Otherwise, task complete.
