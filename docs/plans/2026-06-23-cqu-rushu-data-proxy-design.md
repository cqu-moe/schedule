# CQU 瑞数全站化后的课表数据取数方案

> 状态:设计稿(待 spike 验证核心假设后再进 writing-plans)
> 日期:2026-06-23
> 关联:schedule-cloudflare(本仓库)、cqu-moe-auth(拓扑①)

## 1. 背景与根因(已实测确证)

`my.cqu.edu.cn` 已**全站**部署瑞数(Botgate)6 代 WAF。任何"非真浏览器有机执行流"的纯 HTTP 请求一律返回 **HTTP 412 + 挑战页**(`server: rump/c`,body 含动态 VM 加载器 `<meta id="..." r='m'>`)。

2026-06-23 实测(curl,本地住宅 IP):
- 5+ 端点(门户首页 / `session/info-detail` / `department/list` / `my-table-detail` / `exam list` / 一个不存在的随机路径)**全 412**——瑞数是最前端边缘反代,连 404 都拦。
- 带不带瑞数 cookie / Firefox UA / **带真实有效 OAuth Bearer(账号 30208415)** 全部 412 → 与 IP/UA/凭证有效性**无关**,门禁是"每请求真浏览器 VM 现算令牌",且在业务鉴权**之前**拦(故是 412 非 401)。

**后果**:`schedule-sync`(Worker 纯 `fetch` + Bearer)及任何后端纯 HTTP 取数路径**架构性失效**。

**已做的止血**(commit `0bf7a21` / `3b81fef`):
- `schedule-sync` 遇 412 → `ack` 不 retry(不再 ×3 无效重试、放大流量、刷日志),记 `waf_challenge` 事件。
- 外部教务 API 412 → 返回 `503 CQU_WAF_BLOCKED` 友好提示。
- 止血**不恢复同步**;课表数据冻结在最后一次成功同步状态。本设计解决"如何恢复取数"。

## 2. 约束与已知事实

| 事实 | 来源 | 影响 |
|---|---|---|
| auth 容器只做登录/取票/keepalive,**无数据代取端点** | Explore 核实 auth 仓库(HEAD `1e656d1`) | 复用需**扩展** auth,不是现成 |
| auth DO 持久化**完整 storageState(含瑞数 cookie P + CAS cookies)**,60min keepalive 保活,TGT ~8h/7h 重铸 | `src/durable-objects/cqu-session.ts` | 已有"活的、过瑞数的浏览器状态"可注入复用 |
| 取票 `cqu_ticket_browser.py`:注入 state → patchright 临时浏览器 navigate → 过瑞数 → 拿 ST | `container/cqu_ticket_browser.py` | **"浏览器水化过瑞数"机制已验证可用**(但仅 document 导航取票) |
| 瑞数对**自动化注入的 XHR/fetch**会识破(登录场景 `page.evaluate` 提交必 400);只有 patchright **原生 document 导航**稳过 | auth `notes.md` / `ruishu-waf.md` | ⚠️ 数据 API 的代取方式是**头号风险**(见 §5) |
| 生产量级:**1 用户 / 3 订阅(全个人课表)**,beta 单账号 | 生产 D1 查询 2026-06-23 | 量级极小 → **轻量化优化全是 YAGNI**,每次起临时浏览器可接受 |
| `my.cqu.edu.cn` 前端 XHR 查询参数被瑞数加密为 `Ghabr1Qf=...`(VM 底层加密,monkey-patch 无效) | `cqu-api-endpoint-collection/.../jwxt/notes.md` | 纯 fetch 复用 P 路线须连参数加密一起逆向 → 脆弱,不选 |

## 3. 方案对比

### 方案 A:schedule-cloudflare 自建 patchright 容器
自己起一套 CF Containers + patchright 复刻过瑞数能力。
- ❌ 与 auth 重复造轮子;瑞数对抗逻辑两处维护、两处随瑞数更新失效。否决。

### 方案 B:复用 auth 的浏览器机制,新增"浏览器内代取数据"能力 ⭐推荐
auth 新增一个"在已过瑞数的浏览器上下文里代取目标 my.cqu.edu.cn 请求并回传响应"的能力;schedule-cloudflare 把对 CQU 的数据请求改为经 auth 代取。
- ✅ 复用 auth 已验证的浏览器水化机制 + 已保活的 storageState;瑞数对抗**集中一处**维护。
- ✅ schedule 改动局部(只换 `CQUAPIClient` 的传输层)。
- ⚠️ 依赖"浏览器内代取数据 API 能过瑞数"这一**未证假设**(§5)。

### 方案 C:真浏览器铸可复用 P + 纯 fetch 批量取数 + 逆向 `Ghabr1Qf` 参数加密
- ❌ 须逆向 my.cqu.edu.cn 的瑞数参数加密,瑞数一更新即失效(文档明确"纯补环境路线一更新即失效");量级又只有 1 用户,优化收益为零。否决(YAGNI)。

**推荐 B**:唯一既复用现有过瑞数资产、又改动可控的路线。

## 4. 方案 B 详细设计

数据流:
```
schedule-sync / v2-external (schedule-cloudflare Worker)
   │  CQUAPIClient.request() 不再直接 fetch my.cqu.edu.cn
   │  改为 → env.AUTH.getCquData({clientId, clientSecret, userId, method, url, body})  [新 RPC]
   ↓
auth Worker  →  CquSessionDO (新 action: data-fetch)
   │  [闸] host 白名单(仅 my.cqu.edu.cn)+ per-user/per-client 限流 + 审计(复用取票四道闸的模式)
   │  注入该 user 已保活的 storageState
   ↓
container  POST /data-proxy {url, method, headers, body, state}   [新路由 + 新模块 cqu_request_proxy.py]
   │  patchright 临时浏览器:注入 state → 过瑞数 → 代取目标 URL → 回传 {status, body, headers}
   ↓
返回 JSON 给 CQUAPIClient,后续 parseCourses/buildSyncResult 不变
```

**改动点(跨两仓库):**

A. **cqu-moe-auth**
- `container/cqu_request_proxy.py`(新):入参 `{url, method, headers, body, state}`,patchright 注入 state → 取数 → 返回响应。复用 `cqu_ticket_browser.py` 的浏览器水化骨架。
- `container/server.py`:新增 `POST /data-proxy` 路由。
- `src/durable-objects/cqu-session.ts`:新增 `data-fetch` action,复用 storageState + host 白名单 `validateCquServiceUrl` 思路(限 `my.cqu.edu.cn`)+ 限流 `stMintThrottled` 同款。
- `src/rpc.ts`:新增 `getCquData({clientId, clientSecret, userId, method, url, body})`,鉴权同 `getCquTicket`(client 校验)。

B. **schedule-cloudflare**
- `src/services/cqu-api.ts`:`CQUAPIClient.request<T>()` 改造——传输层从 `fetch(my.cqu.edu.cn)` 换成 `env.AUTH.getCquData(...)`。`CQUAPIClient` 需要持有 `env.AUTH` + userId(构造函数注入),不再只持 bearer。所有上层方法(getSchedule/getSessionList/getExams/fetchTargetSchedule)签名不变。
- `src/cron/schedule-sync.ts` / `src/routes/v2/external.ts`:把 `new CQUAPIClient(bearer)` 改为 `new CQUAPIClient({auth: env.AUTH, userId, clientId, clientSecret})`。412 止血分支保留(代取仍可能间歇失败)。

**取数粒度 = 通用 URL 代理(限 host),非语义方法**:auth 只负责"把请求送过瑞数",不懂课表业务;schedule 继续拥有业务逻辑。职责清晰、改动局部、auth 不与 schedule 业务耦合。安全由 host 白名单(仅 my.cqu.edu.cn)+ 限流兜底。

## 5. ⚠️ 核心未证假设 — 实现前必做 Spike

**头号风险**:方案 B 成立的前提是"**patchright 浏览器在已过瑞数的上下文里,能代取 my.cqu.edu.cn 的数据 API 并拿到 JSON**"。这一点**尚未验证**,且文档有反向信号:

- ✅ 取票走 **document 导航** 已验证过瑞数。
- ❓ 数据 **GET** API(`session/info-detail` 等):或许可直接 `page.goto(apiUrl)` 当 document 拿 JSON(过瑞数)——**待验证**。
- ❓ 数据 **POST** API(`getSchedule`,body `[studentId]`;`getExams`):不能简单 navigate。须浏览器内发 XHR/fetch——但文档记瑞数对**自动化注入的 XHR/fetch 会识破**(登录场景 400),且查询参数被 `Ghabr1Qf` 加密。**这是最可能卡住的点**。

**Spike(在 auth 容器/patchright 环境,用账号 30208415 的活 state):**
1. `page.goto("https://my.cqu.edu.cn/api/resourceapi/session/info-detail")` → 能否拿到 JSON(200)?验证 GET-via-navigate。
2. 浏览器内对 `my-table-detail`(POST)发 fetch → 能否过瑞数拿课表?验证 POST 代取。
3. 若 2 失败:尝试 (a) 让页面在已登录门户上下文内调用(瑞数 SDK 自动加密参数);(b) 评估逆向 `Ghabr1Qf` 的成本。

**Spike 结论决定走向**:
- GET+POST 都能浏览器代取 → 方案 B 全量可行,进 writing-plans。
- 仅 GET 行、POST 不行 → 需为 POST 找方案(页面内调用/参数加密),设计需调整。
- 都不行 → 回到更重的路线(模拟前端完整页面会话),或重新评估产品形态。

**在 spike 通过前,不开始 §4 的跨仓库实现。**

## 6. 安全与限流

- **host 白名单**:代取仅允许 `my.cqu.edu.cn`(复用 auth `validateCquServiceUrl`),拒绝任意 URL——防 auth 变成开放代理(SSRF)。
- **限流**:per-user + per-client(复用取票 `stMintThrottled` 同款),防滥用浏览器代取打爆容器。
- **审计**:复用取票审计模式,记录 user/client/目标 path/结果。
- **client 鉴权**:`getCquData` 同 `getCquTicket` 校验 `{clientId, clientSecret}`。

## 7. 量级适配与 YAGNI

当前 1 用户 / 3 个人课表订阅。每次 schedule-sync = 约 3~4 次代取(session + schedule + exam)。每次起临时浏览器**完全可接受**。

明确 **YAGNI**(量级上来再说):浏览器池 / pristine P 复用 / 纯 fetch 批量 / 跨请求 state 复用优化——一律不做。先正确,再优化。

## 8. 测试策略

- **auth**:`cqu_request_proxy` 的纯函数(host 校验、入参组装)单测;DO `data-fetch` action 的闸(白名单/限流)单测;容器代取走真实 spike + 集成。
- **schedule-cloudflare**:`CQUAPIClient` 传输层改造后,现有 `schedule-sync.test.ts` / `external.test.ts` 用 mock `env.AUTH.getCquData` 替代 mock `fetch`/prototype 方法,行为断言不变。412 止血测试保留(代取失败路径)。

## 9. 下一步

1. **先做 §5 Spike**(头号阻塞,自己在 auth 容器/patchright 环境验证)。
2. Spike 通过 → 进 `writing-plans` 出跨仓库实现计划(auth 先行:容器+DO+RPC;schedule 后接:CQUAPIClient 传输层)。
3. Spike 不通过 → 按 §5 分支调整设计。
