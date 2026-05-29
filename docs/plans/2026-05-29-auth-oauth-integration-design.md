# 接入 auth.cqu.moe 第三方登录(OAuth 2.1 + OIDC)— 设计方案

- 日期:2026-05-29
- 状态:已过 CodeX(gpt-5.5 / xhigh)**四轮** review,所有 findings 已纳入修订;第四轮 verdict = "ready to turn into an implementation plan; no remaining must-fix items"。**可转实现计划。**
- 关联:`/Users/uu/Documents/Coding/cqu-moe/auth/docs/oauth-integration-guide.md`(AUTH 系统接入指南)
- 目标:在保留现有「学号+密码」注册/登录路径的前提下,新增一条「使用 auth.cqu.moe 登录」的第三方登录路径(类比 "Sign in with Google")。新接入账号获取 CAS ticket 等操作全部通过 auth.cqu.moe 完成,schedule 不再自行处理这部分。

> **Review 修订记录(2026-05-29,CodeX gpt-5.5/xhigh,两轮)**:核心接缝、`/api/cqu/status`、bearer-only 下游、crypto IV 均经源码核实通过。
> - **第一轮** must-fix 已纳入:密码流按 `auth_user_id IS NULL` 收口(High 1)、回调 origin 按请求 host 匹配以兼容 beta 域名(High 2)、刷新失败分类(High 3)、迁移叙述纠正(student_id 唯一是独立索引,重建源自 `encrypted_password` 可空化,Medium 4)。新增决策 D7/D8/D9。
> - **第二轮** must-fix 已纳入:D8 主动轮换的并发/stale-`invalid_grant` 守卫(重读最新 + 良性竞态判定,先持久化 CQU 再轮换)、OAuth 建用户 + 个人订阅副作用幂等(`ON CONFLICT(auth_user_id) DO NOTHING RETURNING` + 仅插入路径建订阅);并修:status `expired`/`error` 不当 unbound(Low)、失败分类加 operator-permanent 桶(`invalid_client`/`invalid_scope`,Low)、host→origin 精确映射表消歧(Low)、service-ticket 形状改 `{ ticket }`(Nit)。
> - **第三轮** must-fix 已纳入(均为第二轮修复的连带项):D8 早退门同时计算 `needsAuthRotation`(否则中断/重试会跳过仍 stale 的 auth 轮换)、`DO NOTHING` 命中后补 read-after-conflict 的 `SELECT id, calendarToken`(否则更新分支拿不到 id/calendar_token)、§9 错误表 status 触发条件对齐 §4.2(消除回归)。第三轮零 Critical/High。
> - **第四轮(确认性)**:三处 Round3 修复全部 RESOLVED,零 Critical/High/Medium/Nit。唯一 Low(改绑后缓存 `icsContent`/JSON 陈旧到下次 sync)已作为"已知可接受行为"文档化(§4.2 step 9)。**Verdict:可转实现计划,无剩余 must-fix。**
> - **实现期(T2 代码审查)**:发现 `encrypted_password` 可空化的整表重建会在 D1 生产库**级联删光 `subscriptions`**(D1 迁移内关不掉外键,CF 文档证实)。**反转 D7**:改为保持 `NOT NULL` + AUTH 账号哨兵 `""`,迁移无重建。已更新 D7 / §3 / §3.2 / §4.2 step9 / §13。

---

## 1. 背景与核心判断

### 1.1 现有 schedule 的认证模型(「bearer token 模型」)

`src/services/auth.ts` 的 `login()` 自行完成完整 5 步,最终得到 `my.cqu.edu.cn` 的 OAuth access_token;`CQUAPIClient`(`src/services/cqu-api.ts:225`)全程只用 `Authorization: Bearer <accessToken>` 调课表/考试/搜索 API:

1. GET 登录页 → 取 `execution` / `croypto`
2. AES-ECB 加密密码 POST 登录 → 拿 **CAS service ticket(ST-…)**
3. 验 ticket(`CAS_SERVICE_URL?ticket=…`)→ `SESSION` cookie
4. OAuth authorize → authorization code
5. code 换 token → `my.cqu.edu.cn` access_token + refresh_token

存储:`encryptedPassword`(用于重登/找回)、`accessToken`/`refreshToken`/`tokenExpiresAt`(均 AES-256-GCM 加密)。

### 1.2 AUTH 系统恰好补上第 1-2 步

auth.cqu.moe 是标准 OAuth 2.1 + OIDC Provider,且为每个绑定用户用 Durable Object 维持 CQU CAS 会话(15 分钟 keepalive)。它对外暴露 `GET /api/cqu/service-ticket?service=jwxt`,从该会话**签发一张 CAS ST**。

**关键验证(本设计的技术命门,已确认成立):**

- `auth/src/durable-objects/cqu-session.ts:9` —
  ```
  SERVICE_URLS.jwxt = "https://my.cqu.edu.cn/authserver/authentication/cas"
  ```
  与 schedule 的 `CAS_SERVICE_URL`(`src/services/auth.ts:155`)**逐字相同**。因此 AUTH 用 `service=jwxt` 签出的 ST,能直接喂给 schedule 现有第 3 步去验证。
- studentId 出口:`auth/src/routes/cqu.ts:14-39` 的中间件接受 OAuth Bearer token(`verifyAccessToken`),`GET /api/cqu/status`(`:195-202`)返回绑定的 `studentId`。无需用户再手输学号。
- `sub`(账号身份):来自 OIDC `userinfo` 端点的 `sub` = Better Auth `user.id`。

### 1.3 结论:这是「加一条凭证来源 + 一个 OAuth 回调」,不是「重写认证」

AUTH 只替换 `login()` 的第 1-2 步;第 3-5 步与所有下游(`CQUAPIClient` / `sync` / `explore` / ICS / 限频 / 缓存)**完全不动**——因为 AUTH-linked 账号最终也落到同一个 `my.cqu.edu.cn` bearer token 上。

---

## 2. 已确认的产品决策

| # | 决策点 | 选择 | 说明 |
|---|---|---|---|
| D1 | 账号身份模型 | **按登录方式分离** | 两套账号体系并存。同一 studentId 可同时存在密码账号与 AUTH 账号,各自独立的 `calendar_token` 与订阅。账号合并留待后续,本次不做。 |
| D2 | auth.cqu.moe 客户端注册 | **由用户自行在 auth 侧完成** | schedule 仅按约定的 `client_id`/`client_secret`/`redirect_uri` 开发,不改动 auth 仓库代码。 |
| D3 | CQU token 存储/刷新策略 | **方案 1:薄适配** | AUTH 账号也落到 CQU bearer token,复用现有刷新/同步/缓存基建;仅在 CQU 刷新失败时用 auth refresh_token 重新签 ticket。 |
| D4 | 申请的 OAuth scope | `openid offline_access cqu:ticket:jwxt` | `offline_access` 是拿 refresh_token 的前提(指南 §33),漏了会导致刷新兜底断链。 |
| D5 | OAuth state / PKCE verifier 的存放 | **加密 HttpOnly Cookie(无服务端状态)** | 不用 KV(见 §6 的一致性论证)。 |
| D6 | Cookie 加密密钥 | **独立 secret `OAUTH_STATE_KEY`** | 与 D1-at-rest 的 `ENCRYPTION_KEY` 分离(见 §7 的密钥分离论证)。 |
| D7 | AUTH 账号的 `encrypted_password` | **保持 `NOT NULL`,AUTH 账号存哨兵空串 `""`(绕开整表重建)** | 原拟"改可空"会触发 SQLite 整表重建,而 D1 迁移内**关不掉外键**(`PRAGMA foreign_keys=OFF` no-op,`defer_foreign_keys` 也挡不住 cascade,均经 CF 官方文档证实),`DROP TABLE users` 会**级联删光生产 `subscriptions`**。哨兵方案迁移只需 ADD COLUMN + 换索引,不碰 `DROP TABLE`,对满数据生产表安全。已写的 `!encryptedPassword` 守卫天然兼容 `""`(falsy)。**(由实现期 Codex 代码审查发现并反转原决策)** |
| D8 | auth refresh token 30 天时效 | **主动周期轮换** | 避免兜底 token 因从不使用而过期、导致 CQU 刷新链某天断开时用户被静默永久登出。新增 `auth_refresh_issued_at` 列,cron 见其 >25 天即主动 auth refresh 轮换(见 §5)。 |
| D9 | auth 侧改绑(studentId 变化) | **改绑需重新 OAuth 登录才生效** | `studentId` 只在 OAuth 回调更新。改绑低频,要求重登一次可接受;个人订阅 `source_id` 同样在重登时刷新。不做刷新时实时检测(YAGNI)。 |

---

## 3. 数据模型(schema 迁移)

`src/db/schema.ts` 的 `users` 表改动:

| 改动 | 原因 |
|---|---|
| `encrypted_password`:**保持 `notNull`**(D7),AUTH 账号写哨兵 `""` | AUTH 账号无 CQU 密码;保持 NOT NULL 是为绕开会级联删 `subscriptions` 的整表重建(见 §3.2) |
| `student_id`:去掉行内 `.unique()`,改为**部分唯一索引** `uniqueIndex(...).where(sql\`auth_user_id IS NULL\`)` | 同一 studentId 可能既有密码账号又有 AUTH 账号;但密码账号内仍需唯一 |
| 新增 `auth_user_id text`(可空、`unique`) | auth.cqu.moe 的 `sub`,AUTH 账号去重键 |
| 新增 `auth_refresh_token text`(可空,AES-256-GCM 加密) | 存 auth 的 30 天 refresh_token,刷新兜底用 |
| 新增 `auth_refresh_issued_at text`(可空,ISO 8601) | auth refresh token 的签发/最近轮换时间,供 D8 主动轮换判断时效 |

`auth_user_id` 是 **Better Auth 默认 ID = 随机 base62 字符串(约 32 位,非 UUID)**,定义为不透明 `text`,不做格式/长度校验。SQLite 中 `unique` 列允许多个 NULL,故密码账号(全 NULL)互不冲突。AUTH 账号其余字段(`access_token`/`refresh_token`/`token_expires_at`/`calendar_token`/个人订阅)与密码账号同形。

### 3.1 密码流必须按账号类型收口(High 1,安全级)

`student_id` 不再全局唯一后,现有按 `studentId` 单条件查询的密码流会**误命中 AUTH 行**。必须修复:

- 注册 `POST /` 的存在性查询(`users.ts:97`)、recover `POST /recover`(`:206`)、recover/verify(`:244`)等所有密码账号路径,WHERE 一律追加 **`auth_user_id IS NULL`**。否则:密码注册可能更新一个 AUTH 行并返回它的 `calendar_token`(违反「账号分离」);recover 可能选中哨兵 `""` 密码的 AUTH 行。
- AUTH 账号的哨兵 `""`(D7)**永不**通过密码校验:`auth_user_id IS NULL` 过滤已挡掉 AUTH 行;即便漏到 `verifyPassword`,`""` 解密会失败、其 try/catch 返回 false,且 `!encryptedPassword` 守卫先行短路。

### 3.2 迁移序列(哨兵方案,无整表重建)

> **为什么不整表重建(D7,实现期审查发现)**:`encrypted_password` 改可空需 SQLite 整表重建(create→copy→`DROP TABLE users`→rename)。但 `subscriptions.user_id` 有 `ON DELETE CASCADE`,而 **D1 在迁移事务内无法关闭外键**——CF 官方文档:「By default, D1 enforces … foreign key constraints … within all queries and **migrations** … user queries cannot change this during a query or migration」,且「`PRAGMA defer_foreign_keys = ON` **does not prevent `ON DELETE CASCADE`**」。故 `DROP TABLE users` 会级联删光生产 `subscriptions`(本地 apply 因库空而未暴露)。哨兵方案 `encrypted_password` 保持 `NOT NULL`,**不重建**,从而绕开 cascade。

迁移序列(均为对 `users` 的原位操作,不 `DROP TABLE`,对满数据生产表安全):

1. `ALTER TABLE users ADD COLUMN auth_user_id` / `auth_refresh_token` / `auth_refresh_issued_at`(均可空)。
2. `DROP INDEX users_student_id_unique`;`CREATE UNIQUE INDEX users_auth_user_id_unique ON users(auth_user_id)`(对应 `.unique()`);`CREATE UNIQUE INDEX uq_password_student_id ON users(student_id) WHERE auth_user_id IS NULL`。
3. `CREATE UNIQUE INDEX uq_personal_user_source ON subscriptions(user_id, source_type) WHERE is_personal = 1`。
4. 本地用**含数据的种子库**(先插一条 user + 一条 subscription)apply,再 `PRAGMA index_list(users)` / `PRAGMA table_info(users)` / `SELECT count(*) FROM subscriptions` 验证:索引/约束符合预期,且 subscriptions **未被删**(回归 cascade 风险)。

> **迁移红线**:`src/routes/users.ts:137` 的 `.returning()` 不带参数 → SELECT schema 所有列。加列后**必须先** `npx wrangler d1 migrations apply schedule-beta-cqu-moe-db --remote`,否则线上 `no such column`(CLAUDE.md 已记录的 schema drift 症状)。

---

## 4. 后端:OAuth 登录 + 回调链路

新增 `src/routes/oauth.ts`,挂在 `/api/v1/auth/oauth/*`,套 `UNAUTH_LIMITER` 限频。

> **回调 origin 必须随请求 host 走(High 2)**:同一 Worker 同时绑定 `schedule.cqu.moe` 与 `schedule-beta.cqu.moe`(`wrangler.jsonc:111-112`),而 `PUBLIC_URL` 固定为 prod。若在 beta 发起登录而 `redirect_uri`/cookie 用固定 `PUBLIC_URL`,host-only cookie 会 set 在 beta、回调落到 prod → 看不到 cookie → 误报 `oauth_state`。因此 **不能用 `PUBLIC_URL` 推导 origin**,也**不能**用 `"https://" + host` 拼(localhost 是 http,会拼错)。改为对 `new URL(request.url).host` 做**精确映射表**查表(查不到 → 400):
>
> | request host | origin |
> |---|---|
> | `schedule.cqu.moe` | `https://schedule.cqu.moe` |
> | `schedule-beta.cqu.moe` | `https://schedule-beta.cqu.moe` |
> | `localhost:8787` | `http://localhost:8787` |
>
> cookie、`redirect_uri`、最终 SPA 跳转三者全部用查出的同一个 `origin`(精确匹配,非子串)。auth 侧需把这三条 redirect_uri **都登记**。

### 4.1 `GET /api/v1/auth/oauth/login`(SPA 整页跳转进入)

1. 由请求 host 解析出白名单 `origin`(见上;非白名单 → 400)。
2. 生成 `state`(随机)+ PKCE `verifier` / `challenge`(S256)。
3. 把 `{ state, verifier, origin, exp: now+600s }` 用 `encrypt(JSON, env.OAUTH_STATE_KEY)`(复用 `src/services/crypto.ts`)加密(`origin` 一并入 cookie,回调时据此构造同源跳转)。
4. 写 Cookie:`oauth_tx=<密文>; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/oauth; Max-Age=600`。
   - `SameSite=Lax`(**不能用 Strict**):回调是 auth.cqu.moe 触发的跨站**顶级 GET 跳转**,Lax 会带 cookie,Strict 不会。
   - `Secure`:`http://localhost` 现代浏览器仍接受;dev 下若为 http origin 可按需省略。
5. 302 跳 `${AUTH_BASE}/api/auth/oauth2/authorize?client_id=…&redirect_uri=${origin}/api/v1/auth/oauth/callback&response_type=code&scope=openid%20offline_access%20cqu:ticket:jwxt&state=…&code_challenge=…&code_challenge_method=S256`。

> **并发标签页限制(Nit,需文档化避免误诊)**:单 `oauth_tx` cookie 的事务模型下,同一浏览器开两个登录标签页会互相覆盖 cookie,后回调的那个会 `oauth_state` 失败。可接受(用户重试即可),但须在文档/前端文案体现,避免被误判为 provider 不稳定。

**整个 handler 用 try/catch 包裹**:任何未预期异常(DB 约束失败、upsert 竞态、token 生成碰撞等)都 catch 后 302 跳 `#error=internal`,**绝不**落到全局 handler——后者对未捕获异常返回 JSON 500(`src/index.ts:46`),会破坏 SPA 回调体验。所有 `#error=` 跳转的 origin 由回调请求自身的 host(同 §4.1 白名单)推导(回调落在哪个 host,就跳回哪个)。

0. **provider 返回校验**:若 query 带 `error`(如用户拒绝授权 `access_denied`)→ `#error=access_denied`;若缺 `code` 或 `state` → `#error=oauth_missing_code`。
1. 读 `oauth_tx` cookie;缺失/解密失败/`exp` 过期 → `#error=oauth_state`。并核对 cookie 内 `origin` 与回调 host 一致(不一致 → `#error=oauth_state`)。
2. timing-safe 比对 cookie 内 `state` 与 query `state`(CSRF 防护),不符 → `#error=oauth_state`。
3. 立即清 cookie(`Max-Age=0`)。
4. `POST ${AUTH_BASE}/api/auth/oauth2/token`(`grant_type=authorization_code` + `client_id`/`client_secret` + `code` + `redirect_uri` + `code_verifier`)→ `{ access_token, refresh_token, id_token }`。失败 → `#error=oauth_token`。
5. `GET ${AUTH_BASE}/api/auth/oauth2/userinfo`(Bearer access_token)→ `sub`。
6. `GET ${AUTH_BASE}/api/cqu/status`(Bearer access_token)→ `{ status, studentId }`(status ∈ `unbound`/`active`/`expired`/`error`,`auth/src/durable-objects/cqu-session.ts:145-154`)。状态细分(复审 Low 1,**不可把所有非 active 都当 unbound**):
   - `status === "unbound"` 或缺 `studentId` → `#error=cqu_unbound`(用户确未绑定,提示去 auth 绑定)。
   - `status === "expired"` / `"error"`(此时仍带 `studentId`,只是 DO 会话临时坏)→ 归为会话失败 `#error=cqu_ticket`,**不**误导用户"未绑定"。
7. **签 CQU bearer**:`GET ${AUTH_BASE}/api/cqu/service-ticket?service=jwxt`(Bearer access_token)→ 响应是 **JSON `{ ticket }`**(`auth/src/durable-objects/cqu-session.ts:67`、`auth/src/routes/cqu.ts:223`;指南示例的 `service` 字段实际代码并不返回),解析取 `.ticket`;失败 → `#error=cqu_ticket`。
8. 用该 ST 调 **`exchangeTicketForCquToken(ticket)`**(由 `auth.ts` 第 3-5 步重构而来)→ CQU `{ accessToken, refreshToken, expiresAt }`;失败 → `#error=cqu_login`。
9. **建/更新 AUTH 账号(按 `auth_user_id = sub` 去重,且副作用须幂等——复审 Medium 2)**:
   - **幂等建行**:`INSERT users (...) ON CONFLICT(auth_user_id) DO NOTHING RETURNING id`。CF 下两个并发回调(同 sub)可能都走"新用户"分支,而 `uq_user_source_session` 含可空 `session_id`、SQLite NULL 互异,挡不住重复个人订阅。**只有 `RETURNING` 真正返回新行的那一条**才去建 3 个个人订阅 + 后台同步(复用 `syncNewUserSubscriptions`,`src/routes/users.ts:370`);`DO NOTHING` 命中(已存在)的那条只走下面的更新分支。建议再加部分唯一索引 `UNIQUE(user_id, source_type) WHERE is_personal = 1` 作为兜底,并用 conflict-safe 插入个人订阅。
   - 新行字段:`authUserId=sub`、`studentId`、`encryptedPassword=""`(D7 哨兵,非 null)、CQU tokens、加密的 `authRefreshToken`、`auth_refresh_issued_at=now`、`calendarToken`。
   - **已存在(`DO NOTHING` 命中,`RETURNING` 返回空)** → 必须**先 read-after-conflict**:`SELECT id, calendarToken FROM users WHERE auth_user_id = sub`(对齐现有密码注册 `users.ts:97-103` 先 SELECT 再 update 的模式;`ON CONFLICT DO NOTHING` 不返回行,没有这步就拿不到 `id` 去更新订阅、也拿不到 `calendar_token` 做第 10 步跳转)。拿到后:更新 CQU tokens + `auth_refresh_token` + `auth_refresh_issued_at=now` + `studentId` + `lastLoginAt`;**这里是 D9 改绑生效点**——`studentId` 仅在此更新,若 auth 侧已改绑,执行 `UPDATE subscriptions SET source_id = studentId WHERE user_id = id AND is_personal = 1` 刷新个人订阅 `source_id`(`users.ts:147`,会回传给客户端 `subscriptions.ts:55`),避免内容更新而 metadata 滞留旧值。**此分支绝不建订阅、绝不触发后台同步**(只有上面 insert-returned 路径才建)。第 10 步用这里 SELECT 到的 `calendarToken`。
     - **已知可接受行为(复审 Round4 Low)**:此处只刷新 `source_id` 元数据、不触发 sync,故缓存的 `icsContent`/`coursesJson`(公开 ICS/导出走存储缓存,`subscriptions.ts:361/467`)在下一次手动刷新或每日 sync 前仍反映旧 `studentId`。改绑低频,陈旧到下次 sync 可接受,不阻塞。
10. 302 跳 `${origin}/auth/callback#token=<calendar_token>`。

### 4.3 `auth.ts` 重构

将现有 `login()` 的第 3-5 步抽成可复用纯函数:

```
exchangeTicketForCquToken(ticket: string): Promise<TokenResult>
```

`login()` 在自行拿到 ticket 后调它;OAuth 回调用 AUTH 提供的 ticket 调它。

> **待实现时验证的细节**:新链路没有 `CASTGC` cookie(TGT 在 auth 侧)。CAS ST 验证本身不依赖 CASTGC(服务端自行回 CAS server 校验 ST),故第 3 步在无 CASTGC 下应能取得 `SESSION`。需用真实 ticket 跑通确认。

---

## 5. 后端:Token 刷新(cron 改动)

`src/cron/token-refresh.ts`:

- producer `enqueueTokenRefresh` **不变**(按 `token_expires_at` 选取,两类账号一视同仁)。
- consumer `processTokenRefreshBatch`:SELECT 需补 `authUserId` + `authRefreshToken` + `authRefreshIssuedAt`,按账号类型分支:
  - **密码账号**(`authUserId` 为 null):**完全不变**(CQU refresh_token → 失败兜底密码重登)。
  - **AUTH 账号**:先试 CQU refresh_token(同密码账号);兜底从「密码重登」换成**「auth 重签」**:
    1. 解密 `auth_refresh_token` → `POST ${AUTH_BASE}/api/auth/oauth2/token`(`grant_type=refresh_token`)→ 新 auth access_token(若返回轮换的 refresh_token 则更新存储,并刷新 `auth_refresh_issued_at`)。
    2. `service-ticket?service=jwxt` → 解析 `.ticket` → `exchangeTicketForCquToken` → 新 CQU tokens。

**失败分类(High 3,对齐现有 `token-refresh.ts:126-141` 的永久/瞬时语义,不可一刀切判永久)**:

| 类别 | 判定 | 处理 |
|---|---|---|
| **用户永久**(记 `loginError` + `ack`,需用户重新 OAuth 登录) | auth `invalid_grant` / refresh token 被撤销或过期(且经下面的 stale 守卫确认不是竞态)、CQU 在 auth 侧已解绑(status 明确 `unbound`) | 不重试 |
| **运维永久**(`ack` + 记录/告警,**不**提示用户"重登可修") | `invalid_client` / `invalid_scope` / scope 被拒(403 `cqu:ticket:jwxt`)等配置/客户端类 4xx | 不重试,但属配置问题,需运维介入 |
| **瞬时**(记 `loginError` + `retry`) | 5xx、超时、网络错误、含糊的 `SESSION_INACTIVE`(未经 status 确认是解绑) | 重试 |

> 把 auth/CQU 临时故障误判为永久,会在上游抖动时把用户**静默永久登出**;把配置错(invalid_client/scope)当用户错,会误导用户反复重登且形成 retry 风暴——两者都要避免。

**D8 主动轮换(防 Medium 1:兜底 token 因从不使用而过期)**:auth refresh token 30 天过期(Better Auth 默认 2592000s,已核实)。若 CQU refresh 一直成功,「auth 重签」分支永不触发,`auth_refresh_token` 会在第一次真正需要它之前就已过期。因此 consumer 处理 AUTH 账号时,**即使 CQU refresh 成功**,也检查 `auth_refresh_issued_at`:若 >25 天,额外做一次 auth `grant_type=refresh_token` 轮换并更新 `auth_refresh_token`/`auth_refresh_issued_at`。

> **并发/幂等守卫(复审 Medium 1,必须遵循现有 `token-refresh.ts:53-74` 的"重读最新 + recheck"模式)**:CF Queue 至少一次投递 + consumer 并行处理(`token-refresh.ts:48`),且 Better Auth 轮换会**撤销旧 refresh token**——旧 token 复用返回 `invalid_grant`。故两条投递可能都看到陈旧 `auth_refresh_issued_at`,一条轮换成功、另一条拿 `invalid_grant`。处理规则:
> 1. **早退门要同时算 `needsCquRefresh` 和 `needsAuthRotation`(复审 Round3 Medium 1)**:现有 consumer 的 recheck 在 CQU token 不再 stale 时会**立即 ack**(`token-refresh.ts:69`)。AUTH 账号必须把早退条件改成「**两者皆 false 才 ack**」;否则若 worker 在「持久化 CQU 后、auth 轮换前」被中断,重试会看到新 CQU token 直接 ack、**跳过仍 stale 的 auth 轮换**,D8 保活落空。若重读后仅 `needsAuthRotation` 为真,则执行**只做 auth 轮换**(不动已有效的 CQU token)。
> 2. **先持久化 CQU refresh 结果,再做主动 auth 轮换**;主动轮换失败**绝不**回滚已成功的 CQU token 更新(本轮同步此刻已有有效 CQU token,不受影响)。
> 3. **auth `invalid_grant` 时先重读** `auth_refresh_token`/`auth_refresh_issued_at`:若已被另一条投递更新(值变了或不再 stale)→ 视为**良性竞态**,`ack`,不判永久;只有重读后确认确实是同一个仍 stale 的 token 失败,才按"用户永久"处理。

---

## 6. 为什么不用 KV 存 state(一致性论证)

Cloudflare 官方文档(`kv/concepts/how-kv-works`、FAQ)明确:

- KV 是**最终一致**。写入位置「通常」即时可见,但「**this is not guaranteed and therefore it is not advised to rely on this behaviour**」;其他位置「**up to 60 seconds or more**」才可见。
- 「Visibility of changes takes longer in locations which have recently read a previous version of a given key(**including reads that indicated the key did not exist, which are also cached locally**)」——负缓存同样有延迟。
- FAQ:「KV is **not ideal** for applications where you need … values … read and written in a single transaction. If you need stronger consistency guarantees, consider using **Durable Objects**」。

OAuth state/verifier 握手 = 「写完几秒内必须精确读回一次」,恰是 KV 劝退的用法。失败模式:`/login` 在 PoP-A 写、`/callback` 在 PoP-B 读 → 间歇性误报 `oauth_state`、登录失败,且难复现。即便有 Smart Placement,文档仍明说不可依赖。

→ 采用**加密 Cookie(无服务端状态)**:state/verifier 天然绑定到发起登录的浏览器,零分布式一致性问题,且移除 OAuth 链路对 KV 的依赖(`CACHE` 仍用于 SessionContext,互不影响)。备选(DO / D1 强一致)对「浏览器绑定、短时、一次性」握手属杀鸡用牛刀。

---

## 7. 安全

### 7.1 Cookie 加密用独立 key `OAUTH_STATE_KEY`

- **密钥分离/最小权限**:`ENCRYPTION_KEY` 守 D1 长期高价值机密(CQU 密码、refresh tokens);cookie key 守 10 分钟低价值握手态。一把钥匙一个用途。
- **GCM nonce 预算**:AES-GCM 随机 96-bit IV 安全性依赖单 key 加密次数 ≤ 2³²(NIST SP 800-38D);(key, IV) 碰撞是灾难级(泄漏明文异或 + 可伪造 tag)。混用一把 key = 两条 IV 流共享同一 nonce 预算,任一侧碰撞拖垮双方。独立 key 各享独立预算并隔离风险。
- **轮换独立性**:cookie key 可随意轮换(最坏在途登录重试);`ENCRYPTION_KEY` 轮换需重加密 D1 全部存量,昂贵。耦合会绑架轮换成本。
- 生成:`openssl rand -base64 32`。

### 7.2 IV 复用现有 helper(已正确)

`src/services/crypto.ts` 已是教科书 GCM 构造:每次加密生成全新随机 12 字节 IV(`:34`),IV 前置拼接到密文(`:44-46`),解密切前 12 字节(`:58`)。IV **不需保密、只需单 key 内唯一**,明文前置是标准做法。直接复用 `encrypt(json, OAUTH_STATE_KEY)` / `decrypt(...)` 即可,IV 正确性免费获得,无需新 crypto 代码。

> 实施层小坑(非安全):`crypto.ts:14-18` 的 key 缓存只缓存一把,交替用两把 key 会缓存失效、重复 `importKey`。OAuth 路径调用量极低可忽略;可选优化:升级为 `Map<base64, CryptoKey>`。

### 7.3 其余

- `client_secret` 只在 Worker(token 交换),**绝不进前端**。
- Cookie 用**加密**(AES-GCM,机密性+完整性)而非仅 HMAC 签名:verifier 是敏感值,加密可防能读 cookie 的扩展/本地工具读取明文。
- `state` 防 CSRF;PKCE 强制(指南要求)。
- calendar_token 经 **fragment**(`#`)交还且前端立即 `history.replaceState` 抹除——不进服务器日志/referer,与现有 calendar_token 安全姿态一致。
- `auth_refresh_token` 用现有 AES-256-GCM 加密落库。
- 结构化日志 `console.log(JSON.stringify({ event: "oauth.callback.*", … }))`,对齐项目规范。

---

## 8. 前端改动

| 文件 | 改动 |
|---|---|
| `frontend/src/views/Login.vue` | 表单上方加主按钮「使用 auth.cqu.moe 登录」→ `window.location.href = '/api/v1/auth/oauth/login'`;保留原 token 粘贴表单,中间「或」分隔 |
| `frontend/src/router/index.ts` | 新增路由 `/auth/callback` → `OAuthCallback.vue`;`RouteNames` 加 `OAuthCallback` |
| `frontend/src/views/OAuthCallback.vue`(新) | mount 解析 `location.hash`:`#token=` → `authStore.loginWithToken(token)` → `history.replaceState` 抹 hash → 跳 dashboard;`#error=` → 按错误码显示中文提示 |
| `frontend/src/views/Home.vue` / `Register.vue`(可选) | 次级「auth.cqu.moe 登录」入口 |

`authStore`(`frontend/src/stores/auth.ts`)无需改:`loginWithToken` 现成可用。Dashboard 可选标注账号类型(AUTH 账号无「找回 Token/改密码」,找回方式即重新 OAuth 登录)——polish,排计划末尾。

---

## 9. 错误处理(回调失败 → SPA)

回调任何一步失败都不抛 500(整个 handler try/catch 包裹,见 §4.2),而是 302 跳 `${origin}/auth/callback#error=<code>`(`origin` 由回调请求 host 推导),前端映射:

| `#error=` | 触发点 | 前端文案 |
|---|---|---|
| `access_denied` | provider 回调带 `error=access_denied`(用户拒绝授权) | 你取消了授权 |
| `oauth_missing_code` | 回调缺 `code` 或 `state` | 授权回调参数缺失,请重试 |
| `oauth_state` | cookie 缺失/解密失败/过期 / state 不符 / cookie origin 与回调 host 不一致 | 登录会话已过期,请重试 |
| `oauth_token` | code 换 token 失败 | 授权失败,请重试 |
| `cqu_unbound` | `/api/cqu/status` 为 `unbound` 或无 studentId(确未绑定) | 你还没在 auth.cqu.moe 绑定 CQU 账号,请先去绑定(带链接) |
| `cqu_ticket` | status 为 `expired`/`error`(已绑定但会话临时坏),或 service-ticket 失败(SESSION_INACTIVE / scope 不足) | CQU 会话不可用,请去 auth.cqu.moe 检查绑定 |
| `cqu_login` | ticket→CAS dance 失败 | 连接教务系统失败,请稍后重试 |
| `internal` | 未预期异常:DB 约束失败、upsert 竞态、token 生成碰撞等 | 服务器开小差了,请稍后重试 |

---

## 10. 配置 / secrets / 常量

- **新 secrets**:`AUTH_OAUTH_CLIENT_ID`、`AUTH_OAUTH_CLIENT_SECRET`、`OAUTH_STATE_KEY` → 进 `.dev.vars` + `setup:secrets`/`deploy:secrets`(1Password)+ `src/types.ts` 的 `Env`。
- **常量**:`AUTH_BASE = "https://auth.cqu.moe"`;`OAUTH_SCOPE = "openid offline_access cqu:ticket:jwxt"`;`ALLOWED_ORIGINS = { https://schedule.cqu.moe, https://schedule-beta.cqu.moe, http://localhost:8787 }`(host 白名单,见 §4.1)。
- **redirect_uri / SPA 落点**:**不固定用 `PUBLIC_URL`**,而是按回调请求 host 在白名单内推导 `origin`(High 2);`redirect_uri = ${origin}/api/v1/auth/oauth/callback`,SPA 落点 = `${origin}/auth/callback`。auth 要求 redirect_uri 精确匹配,故须在 auth 侧把**三条都登记**:`https://schedule.cqu.moe/api/v1/auth/oauth/callback`、`https://schedule-beta.cqu.moe/api/v1/auth/oauth/callback`、`http://localhost:8787/api/v1/auth/oauth/callback`。
- **本地开发**:`.dev.vars` 配 `OAUTH_STATE_KEY` 等 secrets;dev origin 为 `http://localhost:8787`(http,cookie 可省 `Secure`)。
- 收尾更新 `CLAUDE.md`(新增 OAuth 链路说明)+ API 文档页(`frontend/src/views/Docs.vue`)。

---

## 11. 测试

- **后端** `src/routes/oauth.test.ts`:mock 全局 `fetch`(auth 的 token/userinfo/cqu-status/service-ticket + CAS dance 5 步)。覆盖:
  - `/login` 返回 302、cookie 已设、`redirect_uri` 随请求 host 变(prod vs beta)、非白名单 host → 400;
  - `/callback` happy path(建行 + 3 个个人订阅 + 跳转带 token,且跳转 origin = 回调 host);
  - 错误路径:`access_denied`、缺 `code`/`state`、cookie 缺失、state 不符、cookie origin 与回调 host 不一致、`cqu_unbound`、service-ticket 403、token 交换失败、**未预期异常 → `#error=internal`**;
  - **回调命中 AUTH 账号时密码流不受影响**;反向:**密码注册/recover 对同 studentId 的 AUTH 行不可见**(验证 `auth_user_id IS NULL` 收口,High 1)。
  - Drizzle D1 mock 按 CLAUDE.md 同时提供 `all()` + `raw()`。
- **cron** `src/cron/token-refresh.test.ts`:补 AUTH 账号「auth 重签」兜底用例;失败分类三桶(`invalid_grant`→用户永久;`invalid_client`/`invalid_scope`→运维永久 ack+告警;5xx/超时→retry);**D8 主动轮换**(`auth_refresh_issued_at` >25 天 → 触发轮换;CQU refresh 成功 + 轮换瞬时失败 → 本轮同步不受影响);**并发/stale 守卫**(两条投递同 user:一条轮换后 `auth_refresh_issued_at` 已更新,另一条遇 `invalid_grant` 重读发现已变 → 判良性 ack,不永久登出)。
- **并发回调幂等**:模拟两个同 `sub` 的回调并发 → 只建一行 user、只建一组 3 个个人订阅、只触发一次后台同步(验证 `ON CONFLICT DO NOTHING RETURNING` 仅插入路径建订阅)。
- **status 细分**:`expired`/`error`(带 studentId)→ `#error=cqu_ticket` 而非 `cqu_unbound`。
- **migration**:本地跑迁移后断言 `PRAGMA index_list/table_info`——`users_student_id_unique` 已删、部分唯一索引存在、`encrypted_password` 可空、`calendar_token` 等索引保留。
- **前端**:`OAuthCallback.vue`(hash 解析 → `loginWithToken` 调用 / 各 `#error=` 文案);`Login.vue` 按钮存在性。
- 后端只跑 `npx vitest run --exclude 'frontend/**'`;前端 `npm run test:frontend`。

---

## 12. 明确不做(YAGNI)

- **账号合并**(密码账号 ↔ AUTH 账号):本次只做并存,合并留待后续。
- auth `end-session`/revoke 登出联动、CQU 改绑联动 UI:非必需。
- 不碰 auth.cqu.moe 仓库代码(客户端注册由用户在 auth 侧完成)。

---

## 13. 待实现时验证的开放风险

**仍需实测/留意(实现期)**

1. **CASTGC-less ticket 验证(最高优先,唯一真未知)**:第 3 步在无 `CASTGC` cookie 下能否取得 `SESSION`(理论上 ST 验证不依赖 CASTGC,需真实 ticket 跑通确认)。
2. **迁移须用含数据的种子库验证**:哨兵方案(D7)已绕开整表重建,迁移为纯 ADD COLUMN + 换索引、对满数据安全;但本地验证仍须先插 user+subscription 再 apply,断言 subscriptions 未被删(锁死 cascade 回归),见 §3.2 step4。

**外部前置(用户在 auth 侧完成)**

3. **scope 授权**:auth 侧需把 `cqu:ticket:jwxt` 授予本 client(`oauth_client_cqu_scopes` 表,见 `auth/src/middleware/scope.ts`),否则 service-ticket 返回 403。
4. **登记三条 redirect_uri**:prod / beta / localhost,精确匹配(见 §10,High 2)。

**已在本设计内解决(原开放项)**

- redirect_uri 多域名 → §4.1/§10 改为按请求 host 白名单推导,不再依赖固定 `PUBLIC_URL`(High 2)。
- 迁移叙述纠正 → §3.2(student_id 唯一是独立索引,非整表重建;重建源自 `encrypted_password` 可空化,Medium 4)。
- userinfo/`sub`:用 userinfo 取 `sub`;auth 即便将来切 `generateId: "uuid"`,因 `auth_user_id` 为不透明 text,schedule 侧零影响。
