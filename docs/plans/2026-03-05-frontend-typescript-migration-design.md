# Frontend TypeScript Migration Design

Issue: #37

## Problem

Frontend has `strict: true` TypeScript configured, but 6 core logic files remain as `.js`, bypassing type checking entirely:

| File | Role |
|------|------|
| `frontend/src/main.js` | App entry |
| `frontend/src/api/index.js` | API client (14 methods, all untyped) |
| `frontend/src/router/index.js` | Route definitions |
| `frontend/src/stores/auth.js` | Auth store (Composition API) |
| `frontend/src/stores/config.js` | Config store (Options API) |
| `frontend/src/stores/subscriptions.js` | Subscriptions store (Options API) |

Additionally `vite.config.js` is inconsistent with `vitest.config.ts`.

## Decisions

- **Type depth**: Lightweight — define API response interfaces in frontend only, manually maintained (no shared types with backend)
- **Route names**: Simple `RouteNames` const object, no `unplugin-vue-router`
- **API client structure**: Keep current structure, only add type annotations
- **Store style**: Unify all to Composition API (`setup()` syntax)
- **Scope**: Single PR, migrate files sequentially by dependency order

## Design

### 1. Type Definitions (`frontend/src/types/api.ts`)

New file with all API request/response interfaces:

```ts
export interface UserInfo {
  student_id: string
  calendar_token: string
  oauth_expires_at: string
  last_synced_at: string | null
}

export interface Subscription {
  calendar_token: string
  source_type: string
  source_id: string
  source_name: string
  is_personal: boolean
  session_name: string
  last_synced_at: string | null
  subscription_url: string
}

export interface SubscriptionList {
  subscriptions: Subscription[]
  max: number
}

export interface SearchResult {
  id: string
  name: string
  extra: string
}

export interface CaptchaConfig {
  enabled: boolean
  sitekey: string
}

export interface AppConfig {
  public_url: string
}

export interface HealthStatus {
  status: string
}

export interface AuthResult {
  success: boolean
  token?: string
  error?: string
}
```

### 2. API Client (`api/index.js` -> `api/index.ts`)

Keep existing structure. Add type annotations to all method signatures:
- Import types from `@/types/api`
- Add `AxiosError` type to interceptor
- Add parameter types and return types to all 14 methods
- `authHeaders` typed as `(token: string) => ...`

### 3. Stores Migration

All three stores unified to Composition API with TypeScript:

**auth.ts**: Already Composition API, just add types:
- `userInfo: Ref<UserInfo | null>`, `token: Ref<string>`, `loading: Ref<boolean>`
- `register()` / `loginWithToken()` return `Promise<AuthResult>`

**config.ts**: Options API -> Composition API:
- Convert state properties to `ref()` calls
- Convert actions to functions
- Add manual `$reset()` (Composition API stores don't auto-provide it)

**subscriptions.ts**: Options API -> Composition API:
- `subscriptions: ref<Subscription[]>([])`, `max: ref(5)`
- Add manual `$reset()`

### 4. Router (`router/index.js` -> `router/index.ts`)

Add route name constants:
```ts
export const RouteNames = {
  Home: 'Home',
  Login: 'Login',
  Register: 'Register',
  Recover: 'Recover',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
} as const
```

Use `RouteNames` in route definitions and navigation guard.

### 5. Main + Vite Config

- `main.js` -> `main.ts`: Rename only, content unchanged
- `vite.config.js` -> `vite.config.ts`: Rename only, content unchanged
- Update `index.html` script src from `main.js` to `main.ts`

### 6. Test Utils Update

- Mock factories gain type parameters: `mockUserInfo(overrides?: Partial<UserInfo>): UserInfo`
- `createMockApi()` return type aligns with API client export
- Test router uses `RouteNames` constants

### 7. Import Path Cleanup

All imports referencing `.js` extensions updated:
- `@/stores/auth.js` -> `@/stores/auth`
- `@/stores/config.js` -> `@/stores/config`
- `@/stores/subscriptions.js` -> `@/stores/subscriptions`
- `@/api/index.js` -> `@/api`

## Migration Order

1. `types/api.ts` (new file, no dependencies)
2. `api/index.ts` (depends on types)
3. `stores/config.ts` (depends on api)
4. `stores/subscriptions.ts` (depends on api, auth)
5. `stores/auth.ts` (depends on api, subscriptions)
6. `router/index.ts` (depends on auth store)
7. `main.ts` + `index.html`
8. `vite.config.ts`
9. Import path cleanup across `.vue` files
10. `test-utils.ts` update

Validate after each step: `cd frontend && npm run build && npm test`

## Out of Scope

- No changes to `.vue` file logic
- No `unplugin-vue-router`
- No API client restructuring
- No new npm dependencies
- No backend type sharing
