# 真实应用 E2E

`npm run test:e2e` 在生产构建页面上验证实际 Auth 登录、Schedule Worker、迁移后的独占 D1/KV、原生 Queue 消费、AuthService RPC、学校浏览器容器和最终日历。学校与邮箱是外部替身；应用响应、会话、订阅、队列结果和数据库写入均由生产代码生成。

## 运行

需要 Node 22、Git、Docker、npm，以及可安装固定依赖的网络。测试浏览器始终在后台无窗口运行，每次使用独立状态；不读用户登录信息、不配置系统钥匙串。

```sh
npm ci
npm run e2e:prepare
npm run test:e2e
npm run test:e2e:harness
```

Linux 还需 `node node_modules/playwright-core/cli.js install-deps chromium`。准备命令从 [固定提交](auth-dependency.json) 安装、构建 Auth，构建学校浏览器基础镜像与 Schedule 前端，下载 Chromium；不会部署。已有依赖 checkout 必须干净且精确匹配 pin，脚本不会重置别人的修改。

开发定位可用 `SCHEDULE_E2E_MOBILE=1 npm run test:e2e -- --grep '^unbound:'`。必过入口只接受 `--grep` / `--grep-invert`；禁止 headed、重试或空用例放行覆盖。使用自定义输出时，`SCHEDULE_E2E_OUTPUT` 必须位于当前工作树的 `.e2e/` 下。

## 个人课表验收旅程

| 旅程 | 实际验证 | 能阻止的回归 |
| --- | --- | --- |
| 本人订阅与另一用户 | 错误密码拒绝后真实登录；默认订阅创建、实际队列与浏览器采集；三视图 ICS 的独立课程/考试日期与数量；日历新窗口、事件详情、重载；重复创建幂等；匿名公共链接与私有接口；其他账号读写404且主人数据不变 | 页面成功但未持久化、队列未消费、课程/考试混用、重复订阅、跨账号管理 |
| 无学校绑定 | 真实登录后展示绑定提示，D1 错误为 CQU_BINDING_REQUIRED，不能留下成功同步时间，重载仍失败 | 缺绑定被空数据或旧状态伪装成成功 |
| 无同步权益 | 页面显示未开通，建立默认订阅返回 skipped，数据库无成功订阅，重载保持 | UI 或后台绕过真实权益 |

每条旅程在每个视口都有新的 Auth/DB/学校容器运行环境；账号注册、邮件验证和学校绑定经过实际接口。只种管理员批准的第一方 OAuth 客户端和合成用户权益等输入。第一方 `skipConsent` 与 subsystem 是生产协议要求，缺少批准标记时真实 introspection 不披露应用权益；测试不改认证策略。

既有单元/真实 D1 测试继续保护算法和局部竞态；这里验证它们无法覆盖的生产构建、跨服务协议、队列和实际浏览器组合。没有用于测试的生产开关或返回成功的内部 mock。

## 框架与运行适配

- 固定 `e2e@0.21.0` / `@e2e-dev/web@0.15.0`，使用 tester-army/e2e 的测试发现、操作、断言及报告。配置与测试被框架不同 module graph 加载，engine handle 通过同一 worker 的 `globalThis` 共享，公开 `surfaceOf` 才能取得当前上下文。
- 0.15 的 Browser 明确不跟随 `target=_blank`。实跑中点击后主 tab 仍在 dashboard，所以仅新日历窗口通过公开 `surfaceOf(engine).context()` 操作实际 Playwright Page。保留真实点击/新窗口和独立截图，不改页面链接，也不替换整套框架。
- 固定 Auth 的 Miniflare 4.20260521.0 为多资产根使用相同 `Assets:storage` 服务名，导致 Schedule 首页误拿到 Auth 的构建。第二个原生 Miniflare 实例只承载 Schedule 生产静态资产，经 ASSETS binding 桥接；业务 Worker、Auth、数据库和队列仍在同一主实例。启动时逐字节校验实际 HTML，防止串线变成假通过。
- 浏览器与 Worker 默认拒绝未登记外联，WebSocket 同样拒绝。唯一浏览器外部脚本替身是 Cloudflare beacon 的精确 URL，返回无操作合成脚本。学校协议和投递由固定 Auth fixture 加本仓课程/考试输入组成，真实生产解析器负责生成日历。
- 测试保留生产限流。每条旅程独占运行环境；另一个匿名读取者使用独立的合成 Cloudflare 客户端 IP，不抬高配额。

## 证据与失败门禁

每次默认写 `.e2e/run-<时间>/`：每个视口的 `discovery.json` 和 `run.json`，以及每个真实发现 ID 对应的 `report.json`、trace、日志、日历截图与 `runtime.json`。记录来源提交、dirty 状态及源文件指纹。完整发现、选中和执行集合逐项核对，零用例、跳过、中断或清理错误均非零退出；禁止把过去的通过计入本次。

每条运行在 finally 中关闭 Auth/容器/Workflow、Schedule 资产服务和只读观察端口，实际 TCP 检查三个本地监听器已关闭；固定Auth同时按本轮native DO ID检查业务容器及独立egress proxy已删除（proxyObjectsRemoved），不只按业务镜像查询；清理错误与业务失败同时保留。校验产物前移除合成登录秘密、OAuth 令牌/授权码/nonce 和公共日历 token，不上传 profile 或数据库。

`test:e2e:harness` 实跑五个控制：零选择、错误 Auth pin、故意错误的最终 ICS 内容、故意错误的编辑后 CSV 内容、真实资源关闭后注入清理失败。分别检查指定失败原因；清理失败即使业务通过也必须失败。

CI 保留前端门禁；后端类型与现有测试、生产构建和全部旅程按 round 1/2 × desktop/mobile 四个独立 job 验证。保留原40分钟单job预算；四个失败控制只在首轮desktop job运行，并 always 上传脱敏产物。CI 接线不等于其实际成功，最终结论需读取对应提交的远端结果。

个人旅程对应 SCHEDULE-01 / #155，外部目录和缓存对应 SCHEDULE-02 / #156；公开链接管理、完整订阅生命周期与跨学期重选仍由 #157 承担。这里只验证合成学校输入和本地平台执行，不能当作部署、真实 CQU、物理手机或 Firefox/WebKit 验收。


## 外部来源、目录与课程缓存（SCHEDULE-02）

新增16条旅程，与原3条共19条，每个视口独立运行：

- 教室、实验室、教师、行政班与课程/教学班，从真实页面选择、持久化到原生队列消费和公共ICS，再重开页面读回。行政班保留多课程；课程与个人同步权益分开。
- 来源总开关、外部权益、学校绑定分别拒绝；另一已绑定用户不能复用选择凭据，但其自己的选择可实际创建。学校403和不合法响应有可见错误；目录miss仅请求一次学校，显式重试能恢复。
- 每周目录通过真实scheduled→Queue→Auth RPC→学校容器，完整五阶段后才替换发布指针；新版空值/错误不破坏旧版。真实前台教师查询建立让路窗口，重复消息/中断租约/学期变动/旧教师阶段/过期run均读回实际终态。教师没有后台全量采集。
- 教学班缓存先从公开接口真正填充，再证明用户、课程、学期隔离。用户/课程与学期使用独立运行环境，避免测试自身超过生产每IP每分钟10次目录限流；不改配额或限流时钟。

目录故障控制只改变实际run的调度截止、租约和明确的旧版本/过期输入；每次记录action及原phase。正常目录项、成功状态、原子发布指针、缓存结果由生产代码写入。测试消费者通过固定Auth支持接口安装真实注册用户ID作为目录所有者，并在Miniflare重配置后重新取得DB句柄；未添加生产测试开关。

原生 Auth 后台操作可能在空闲观察后竞争浏览器。目录旅程最多接纳一次明确的 `BROWSER_BUSY` 退避：独立核对本次实际 Auth RPC 审计、失败计数、释放租约、未来重试时间及旧发布指针/目录项不变，再推进一次调度时钟并要求实际 Queue 恢复成功。其他错误、第二次冲突或最终状态错误仍失败；框架 retries 仍为0，原始失败与恢复观察进入证据。

所有selected attempt还须无cleanup=failed/cleanup-phase secondaryErrors：固定e2e0.21有时不将它计入passed/exit0的主结论。运行入口独立拒绝该情况。

按视口定位可用 `SCHEDULE_E2E_VIEWPORT=desktop npm run test:e2e`，接受desktop/mobile/all，默认all；非法值非零。此参数只改变视口，不跳过该视口应执行的用例。新Web旅程保留tester-army/e2e；现有新窗口适配范围不变。

## 订阅生命周期（SCHEDULE-03）

新增12条旅程（合计31条/视口），覆盖主人共享链接的标签/格式编辑、重开、轮换、删除与另一用户拒绝；个人及外部各自的手动次数、冷却和自动间隔；设备退出后的原生scheduled→Queue；学校503、504、错误结构、合法空表和恢复；真实管理员撤权/恢复、封禁、自助解绑；教学班新学期停用与显式重选；#103默认个人视图不占外部条数的当前行为。外部故障旅程还持有真实学校HTTP请求，等真实浏览器采集超时后再恢复。

生命周期前置权益使用不同的个人/外部额度与间隔，避免误串权益仍通过。只在已生成的实际时钟字段上推进截止，或删除实际caps/harvest缓存输入；每次压缩时钟前观察学校profile和Chromium进程归零，最多120秒。不预造成功记录，不直接调用消费者。证据分别记录时钟输入和只读实际状态转换；失败保留的课表、空表和最终公开日历均由生产路径生成。

多阶段后台故障旅程等待期间离开轮询看板；每次失败和最终恢复均重开真实页面断言。这样不把连续压缩的后台周期变成人为持续轮询压力，生产限流与重试不变。浏览器证据仅额外记录`/me`、订阅列表和通知设置的响应时间/路径/状态码，不记录响应体、请求头或Cookie；一次真实429不能据此冒称中央会话失效。

每条finally除了平台按本轮原生DO名称检查，还按其返回的实际业务/proxy ID定向查询确认不存在。必须有`proxyObjectsRemoved=true`及`removedProxyIds`数组；已绑定生命周期至少有一个实际proxy ID。缺失或残留即非零并停止后续旅程。框架selected attempt的cleanup失败/cleanup secondaryErrors同样独立拒绝。聚合报告复用已脱敏的单条产物，避免重新写入内存中的链接token。

定位本票：`npm run test:e2e -- --grep '^lifecycle'`。`SCHEDULE_E2E_BROWSER=firefox`或`webkit`选择补充浏览器，默认chromium；需要相应Playwright二进制（`node node_modules/playwright-core/cli.js install firefox webkit`）。浏览器仍为后台独立临时profile。`PLAYWRIGHT_BROWSERS_PATH`仅指定已安装二进制目录，不传用户profile。`SCHEDULE_E2E_BREAK_ASSERTION=1`也会故意破坏本票的实际CSV读回断言，用于独立非零控制。

WebKit 会拒绝 HTTP localhost 上的 Secure 登录 Cookie；Web SPI 0.15.0 又没有接受隔离测试证书的配置，因此直接切换 `SCHEDULE_E2E_BROWSER=webkit` 不代表完整套件可运行。完成上述 `e2e:prepare` 后，可使用窄范围 HTTPS 补验，保持产品 Cookie 和系统信任不变：

```sh
SCHEDULE_WEBKIT_TLS_MODE=stock-red node e2e/webkit-tls.mjs
SCHEDULE_WEBKIT_TLS_VIEWPORT=desktop node e2e/webkit-tls.mjs
SCHEDULE_WEBKIT_TLS_VIEWPORT=mobile node e2e/webkit-tls.mjs
```

第一条要求实际 stock 引擎因本地测试证书拒绝且完整清理；后两条使用临时 Playwright WebKit context 验证学校拒绝、显式重试恢复及空订阅读回。每次使用新的 `SCHEDULE_WEBKIT_TLS_OUTPUT=.e2e/<本轮目录>` 保留证据。脚本会检查并安装匹配的 WebKit 二进制；证书仅在该 context 接受，结束后删除。它只覆盖这一条旅程，不能替代全部31条或完整发布门禁。默认 Chromium 入口保持不变，启动、业务或清理失败仍非零。

## 完整 Firefox / WebKit 发布前矩阵

准备固定 Auth、独立依赖和前端构建后：

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" SCHEDULE_RELEASE_OUTPUT=.e2e/release-controls-unique node e2e/release-web.mjs --self-check
PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" SCHEDULE_RELEASE_OUTPUT=.e2e/release-round1-unique node e2e/release-web.mjs
```

入口串行运行原31条 tester-army/e2e 用例，Firefox/WebKit × desktop/mobile，共124个实际attempt；没有复制旅程、弱化断言或开启重试。每引擎分别实跑原有错误课程内容断言、零选择及真实资源停止后的cleanup拒绝控制。第二轮必须使用新的独占输出目录；代码存在或第一轮通过均不代表两轮发布验收完成。

Firefox沿用HTTP；WebKit通过原临时loopback证书代理保留产品Secure Cookie。固定Web SPI 0.15.0缺少TLS context选项且CDP provider不支持WebKit，因此只在WebKit测试子进程中加载`tls-context-loader.mjs`：校验安装包版本、`surface.js`完整SHA-256及唯一context创建位置，在内存增加`ignoreHTTPSErrors:true`。安装的依赖文件、用例和断言不变。`NODE_EXTRA_CA_CERTS`仅给该子进程信任本次临时证书，支持原旅程中的独立Node HTTP读回；不更改系统信任或钥匙串。CLI及实际worker均记录适配hash；默认Chromium HTTP没有这些选项。

每个FF/WK子进程使用私有HOME/TMPDIR，观察实际headless引擎路径、临时profile、浏览器退出和profile删除。HOME/profile与临时证书位于独立`.e2e/private-browser-*`、`private-tls-*`，不进入可发布组；清理失败时保留私有材料和原错误。WebKit另核对真实HTTPS回调携带Secure登录Cookie、证书/监听器清理；唯一不登录的旧教师目录终止用例仍执行原平台断言及真实浏览器beforeEach，不制造OAuth callback要求。

本入口整合已审178c686的private→verified publish：原生report/log先在owner私有stage脱敏、完整扫描、验证所有文件hash，才发布整组；拒绝时只发布安全失败投影。release外层没有runtime秘密登记表，故其原始child stdout/stderr仅写独立mode0700 `private-release-*`中的0600日志，不转发控制台、不上传、不冒称已扫描。公开异常只含固定安全message/phase/hash，原始异常和并存失败留私有journal；启动/最终源码核验失败同样非零。`node e2e/release-safety-check.mjs`独立检查外层真实child stdout/stderr与异常泄漏边界；属于离线harness控制，不是浏览器业务证据。

旧a21首轮或旧CI失败仍按原指纹保留，不计入组合源码验收。两个fresh完整轮次须在相同冻结组合源码执行；经独立复审的隔离分支、明确不部署的Linux CI可以承担这两轮，不能把入口接线、局部回归或smoke称为完整release通过。

`.github/workflows/e2e.yml` 的premerge完整浏览器入口是PR opt-in标签 `e2e-release-browsers`：父给PR添加该标签时执行FF/WK；保留标签后的synchronize/reopened也验证新候选。普通无标签PR仍只跑原Chromium round1/2×desktop/mobile矩阵；无关标签不额外启动浏览器组。labeled事件使用独立concurrency key，跳过的路由job也使用独立check名称，不取消或覆盖必需Chromium检查。默认PR的首轮desktop额外运行一次 `node --experimental-strip-types --test e2e/lifecycle-wait.test.mjs` 观察顺序contract，其他原步骤/矩阵/40分钟预算不变。

默认分支存在该workflow及dispatch入口后，也可手动 `workflow_dispatch` 设置布尔 `release_web=true`（false运行原Chromium矩阵）；手动run独立concurrency key。release矩阵为Firefox/WebKit × desktop/mobile × round1/2，共8个fresh job、每job原31条、每轮124个原始attempt，每job仍40分钟、安装所选引擎及系统依赖。仅首轮Firefox desktop运行一次观察顺序contract，额外安装WebKit，并执行 `node e2e/release-web.mjs --self-check` 实际六负控。PR标签入口不依赖workflow先合入默认分支，不能把缺少默认入口时的手动命令当成premerge路径。

release的原始runner/control及观察contract输出只写私有0700目录内的0600日志，console只输出固定exit状态。上传allowlist仅包含该cell的独占 `run-release-*` 和六负控的独占 `release-controls-ci-*` 中的已验证JSON/trace/readback图片/runner.log；不匹配 `private-*`、profile、证书或原始外层日志。接线不表示已执行：父复审、最终组合源码hash（含workflow及父的三个observer文件）及8份实际artifact验收仍必要；不触发部署或tag。本票不添加标签、dispatch、提交或推送。
