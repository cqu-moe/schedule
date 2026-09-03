# CQU aTrust 双会话课表采集设计

日期：2026-09-04

涉及仓库：

- `cqu-moe/auth`
- `cqu-moe/schedule-cloudflare`

## 1. 背景与实测事实

现有个人课表同步已经改为 `cquHarvest`：auth 在用户浏览器状态中打开
`my.cqu.edu.cn/workspace/curriculum`，截获页面自然触发的
`my-table-detail` POST，再把结果交给 schedule 映射、落库并生成 ICS。

直接从云服务器访问时，瑞数会按出口信誉投毒该 POST；aTrust 发布应用的浏览器改写域名可以把请求经校园网关转发。2026-09-04 的一次性真实浏览器验证得到以下事实：

1. 普通 `sso.cqu.edu.cn` 与 aTrust 改写版 SSO 可以在两个隔离浏览器上下文中同时进入邮件 2FA。
2. 普通 SSO 发码成功后，aTrust SSO 的发码接口返回“验证码仍在有效期内，请勿重复发送”，说明验证码由同一账号级后端共享。
3. 同一验证码同时提交时，aTrust 登录成功，普通 SSO 失败；随后在不重新发码的情况下再次向普通 SSO 提交该码仍失败。
4. 因此验证码在有效窗口内由两套 SSO 共享，但一次成功验证会消费它；“有效期内不可重发”不等于“成功后无限复用”。
5. aTrust 登录成功后，浏览器回到 `my-cqu-edu-cn-s.atrust.cqu.edu.cn`，页面自然触发的 `my-table-detail` 返回 HTTP 200。

一次性验证脚本不把密码、验证码、ST、Cookie 值、storageState 或课表响应正文写入磁盘；正式实现继续执行同一脱敏边界。

## 2. 目标

1. 保留现有普通 CAS 会话及 Service Ticket 能力，不改变其公开语义。
2. 为个人课表 harvest 增加独立的 aTrust 浏览器会话。
3. 首次需要课表时按需建立 aTrust 会话，而不是在 CQU 绑定时强制连续登录两次。
4. aTrust 会话过期时自动重登并最多恢复一次 harvest。
5. 两类浏览器登录可以并行执行，验证码这一账号级共享资源必须有确定的所有权与顺序。
6. 任意失败不得用空数据覆盖用户最后一次成功课表。

## 3. 非目标

- 不把整个 auth 取票系统切换到 aTrust。
- 不把 aTrust passport 消费的 ST 当作普通 CQU Service Ticket 返回。
- 不增加独立的周期性 aTrust keepalive；课表 harvest 本身承担活性探测。
- 不恢复教师、教室、课程等外部课表。
- 不自动部署生产；代码和本地/真实浏览器验收完成后单独确认部署。

## 4. 双会话状态模型

现有 DO `state` 的含义保持不变：其中的 `storageState` 是直连
`sso.cqu.edu.cn` 的 CAS 会话，只供普通取票与现有 keepalive 使用。

aTrust 状态使用独立 DO storage 键 `atrustSession`：

```ts
interface AtrustSessionRecord {
  status: "missing" | "active" | "needs_reauth";
  storageState: CquStorageState | null;
  loginAt: number;
  lastUsedAt: number;
  consecutiveFailures: number;
}
```

分开存储而不是嵌入现有 `SessionState`，原因是两份完整浏览器状态都可能较大；拆分可以保持旧数据迁移兼容，并避免单个 DO value 接近 128 KiB 上限。aTrust 状态需要独立的序列化体量守卫。

更新凭据、解绑、撤销或销毁 CQU 绑定时必须清除 `atrustSession` 及 aTrust 在途状态。aTrust 登录或 harvest 失败不得修改普通 CAS `state.storageState`、`loginAt`、keepalive 计数或绑定状态。

## 5. aTrust 登录器

auth 容器新增独立模块 `container/cqu_atrust.py`。它复用
`cqu_login.py` 已验证的表单导航、密码加密、邮件发码与验证码提交基础函数，但拥有独立编排：

1. 打开固定入口 `https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum`。
2. 等待 aTrust 门户真实 DOM 渲染完成，按精确可见文本选择“统一身份认证”；不依赖列表第一项或截图判断。
3. 确认落到精确主机 `sso-cqu-edu-cn-s.atrust.cqu.edu.cn`，使用页面当前登录 URL 完成第一因素与邮件 2FA。
4. 允许 aTrust passport 消费其专用 ST，等待最终导航回精确主机 `my-cqu-edu-cn-s.atrust.cqu.edu.cn`。
5. 通过导航落点和真实页面/接口行为判断成功，不猜测或硬编码某个网关 Cookie 名称。
6. 仅返回完整 aTrust storageState，不返回 ST。

节点新增固定内部端点 `POST /atrust-login`。调用方不能传入入口、SSO 或 passport URL；这些 URL 全部是代码常量。现有 `POST /run` 契约和普通 `run_login` 保持不变。

## 6. 两类登录并发与验证码租约

普通 CAS 与 aTrust 使用两个独立在途记录：

- `loginInFlight`：现有普通 CAS 登录。
- `atrustLoginInFlight`：新增 aTrust 登录。

二者可以同时启动浏览器并完成第一因素。验证码由账号级后端共享且成功后单次消费，因此另设 `codeLease`，它只串行化“请求并消费验证码”这一阶段：

```ts
interface CodeLease {
  ownerToken: string;
  ownerKind: "cas" | "atrust";
  acquiredAt: number;
  queue: Array<{
    token: string;
    kind: "cas" | "atrust";
    queuedAt: number;
  }>;
}
```

协议如下：

1. 两类登录分别创建自己的 session token，并启动节点 `/run` 或 `/atrust-login`。
2. 节点完成第一因素后等待“允许请求验证码”的 permit，不立即点击发码。
3. DO 原子加入 `codeLease`。无 owner 时当前 token 成为 owner；已有 owner 时当前 token 排队，但其浏览器仍保持在 2FA 页面。
4. DO 通过节点内部 `POST /code-permit` 向 owner token 发放 permit。节点需要支持 permit 早到缓存，避免 `/code-permit` 与浏览器注册事件之间的竞态。
5. 只有 owner 点击“获取验证码”。邮件到达后，`deposit-code` 只把验证码投递给 `codeLease.ownerToken`，不再向两套登录广播竞争消费。
6. owner 登录结束（成功、失败或超时）时释放租约。成功时清除已消费的 pending code；然后提升队首并发放下一个 permit，使第二套 SSO 请求一份新验证码。
7. owner 崩溃或锁超时时，按既有 `LOGIN_LOCK_TTL_MS`（720 秒）清理 owner 与失效队列项，再提升仍有效的下一项。
8. 若发码返回 `already_valid`，只允许当前 owner 使用 DO 中仍在有效期内、尚未确认消费的 pending code；没有可用 pending code 时继续等待邮件，不把旧码猜测性投给其他登录。

节点 `/code` 仍按 session token 投递。新增 permit 事件与验证码事件必须在请求结束时清理；日志不记录 token、验证码或凭据。

## 7. harvest 状态选择与一次恢复

auth 保留直连 harvest 作为兼容/回滚路径，同时增加 aTrust 路径。DO 根据已经规范化的 `navUrl` 主机选择浏览器状态：

- `my.cqu.edu.cn`：沿用普通 `state.storageState`。
- `my-cqu-edu-cn-s.atrust.cqu.edu.cn`：使用 `atrustSession.storageState`。

首次 aTrust harvest 流程：

1. `atrustSession` 缺失时解密现有凭据并启动按需 aTrust 登录。
2. 登录成功后保存独立状态，再执行 harvest。
3. harvest 成功后更新 `lastUsedAt`；不额外创建 keepalive alarm。

已有状态的流程：

1. 先用保存的 aTrust 状态执行一次 harvest。
2. 若最终落回 aTrust 门户或改写版 SSO，分类为 `ATRUST_SESSION_EXPIRED`，只清除 aTrust 状态。
3. 自动登录一次，再重试 harvest 一次。
4. 恢复尝试到此为止，禁止递归重试或验证码风暴。

自动恢复的两个浏览器 harvest 尝试属于同一个逻辑调用，只占用一次 harvest 限额并只生成一条最终审计记录；审计可以附加 `attempts: 1 | 2` 和 `recovered: boolean`，但不得记录响应正文。

## 8. URL 与 SSRF 安全边界

TypeScript DO 与 Python 节点继续实行双层校验。允许的 harvest 主机只有：

- `my.cqu.edu.cn`
- `my-cqu-edu-cn-s.atrust.cqu.edu.cn`

约束：

1. 仅允许 HTTPS、默认 443、无 userinfo、无反斜杠、无非 ASCII 同形字符。
2. `navUrl` 和所有 `fetch[].url` 必须属于同一个精确主机，禁止把一份状态跨主机混用。
3. `fetch[]` 仍只允许 GET；课表 POST 必须由页面自然触发并通过 capture 截获。
4. DO 只向节点转发 canonical URL，不转发校验前原文。
5. capture 仍是非空响应 URL 子串，仅用于过滤，不构成出站目标。

## 9. 错误语义与数据完整性

- `ATRUST_SESSION_EXPIRED`：harvest 落回 aTrust 门户或改写版 SSO；内部触发一次恢复。
- `ATRUST_NEEDS_REAUTH`：aTrust 登录连续 3 次明确被密码拒绝后进入独立熔断；验证码错误、页面变化和网络异常不累计该计数，也不改变普通 CAS 状态。
- `ATRUST_LOGIN_IN_FLIGHT`：同一种 aTrust 登录已有活锁；当前调用不创建第二个 aTrust 浏览器。
- `ATRUST_TRANSIENT`：网关、节点、浏览器或页面结构异常；保留仍可能有效的状态并退避。
- `WAF_CHALLENGE` / `HARVEST_TRANSIENT`：已进入目标应用但要求的 capture 缺失、非 2xx 或无法解析。

schedule 对这些错误继续采用止血语义：本轮同步 ack、记录结构化错误并保留最后一次成功的 D1/ICS 数据，不把缺失响应映射成空课表。

## 10. 仓库改动边界

### auth

- 新建 `container/cqu_atrust.py` 与对应 pytest。
- 扩展 `container/server.py`：`/atrust-login`、`/code-permit`，以及按 session token 隔离的 permit/code 事件。
- 扩展 `container/cqu_data_harvest.py`：双主机、同主机配方、aTrust 过期分类。
- 扩展 `src/services/harvest-url.ts`：两个精确主机和同主机 recipe 校验。
- 扩展 `src/durable-objects/cqu-session.ts`：独立 aTrust 状态、独立登录锁、`codeLease`、按需登录及一次恢复。
- 扩展 `src/services/cqu-node-protocol.ts`，加入 aTrust 过期、登录失败和一次恢复所需的节点响应分类；同步扩展 DO 测试 helper。
- 更新 `docs/subsystem-integration-guide.md` 的 `cquHarvest` 契约与错误码。

### schedule-cloudflare

- 修改 `src/services/cqu-harvest.ts`，将个人课表 recipe 的 nav/fetch 基础主机改为 aTrust 改写主机。
- 修改对应单测，断言所有 recipe URL 使用同一个 aTrust 主机。
- 数据映射、D1 写入、ICS 生成、外部课表软禁用策略保持不变。

## 11. TDD 与验收矩阵

所有生产代码必须由先失败的测试驱动。至少覆盖：

1. aTrust 门户、改写版 SSO 和最终应用 URL 的纯函数分类。
2. `/atrust-login` 使用固定入口，不接受任意 URL，也不返回 ST。
3. CAS 与 aTrust 可同时持有独立登录锁。
4. 两个登录可同时进入 2FA；`codeLease` 只给一个 token 发 permit，完成后提升另一 token。
5. `deposit-code` 只投递给 lease owner；过期 owner/queue 能安全清理。
6. aTrust 登录、失败和状态写回不改变普通 CAS state。
7. 首次 harvest 按需登录；aTrust 过期时自动恢复一次；不得出现第三次尝试。
8. 一次恢复只消耗一个 harvest 限额。
9. 两个允许主机均能规范化；跨主机 recipe、后缀欺骗、userinfo、非 443 和非 GET 均拒绝。
10. schedule recipe 全部使用 aTrust 主机，既有映射与防空数据覆盖测试继续通过。

完成前必须取得以下新鲜证据：

- auth Node/Vitest 测试全通过。
- auth 容器 pytest 全通过。
- auth Workers/DO 集成测试全通过。
- 两仓库 TypeScript 类型检查通过。
- schedule 后端测试全通过。
- 普通 CAS 仍能独立铸造 Service Ticket。
- aTrust 首次登录后 `my-table-detail` 为 200。
- 第二次 harvest 复用保存的 aTrust 状态，不重新发验证码。
- 模拟 aTrust 过期后只重登 aTrust，恢复 harvest，普通 CAS 状态与出票能力保持不变。
- 日志检查不含密码、验证码、ST、Cookie、课表正文或 storageState。

## 12. 实施与部署顺序

1. 两仓库分别从最新 `origin/main` 建立 `feat/cqu-atrust-harvest` 隔离工作树。
2. auth 先按 TDD 实现完整契约并通过本地/真实浏览器验收。
3. schedule 再切换 recipe 并跑回归测试。
4. 各逻辑块按实现计划提交；本地工作完成后暂停，单独确认是否推送和部署。
5. 若部署，必须先部署 auth，再部署 schedule；auth 未支持 aTrust 前不得发布 schedule URL 切换。
