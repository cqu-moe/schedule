# Frontend Component Tests Design

Issue: #8

## 背景

`frontend/` 下的 Vue 组件目前无自动化测试。72 个已有测试全部覆盖后端 Workers 代码，前端仅靠手动浏览器验证。

## 方案选择

**选定: Vitest + Vue Test Utils (jsdom)**

- 与后端共享 vitest 生态，认知成本低
- Vue 官方测试方案，对 `<script setup>` + Pinia 支持最好
- 配置简单，3-4 个 devDep 即可启动

淘汰方案:
- Vitest + Testing Library — 学习曲线高，中文内容匹配需额外适配
- Playwright CT — 实验性功能，启动慢，配置重

## 测试基础设施

### 依赖

```
vitest (devDep)
@vue/test-utils (devDep)
@pinia/testing (devDep)
jsdom (devDep)
```

### 配置

- `frontend/vitest.config.ts` — 复用 vite.config.js 的 path alias (`@/`)，`environment: 'jsdom'`
- `frontend/package.json` 新增 `test` / `test:coverage` scripts
- 根目录 `package.json` 新增 `test:frontend` script

### 文件组织

```
frontend/src/
├── test-utils.ts                          # 共享 mount helper + mock 数据
├── api/__tests__/index.test.ts
├── stores/__tests__/auth.test.ts
├── stores/__tests__/config.test.ts
├── router/__tests__/index.test.ts
├── views/__tests__/Dashboard.test.ts
├── views/__tests__/Register.test.ts
├── views/__tests__/Add.test.ts
├── views/__tests__/Home.test.ts
├── views/__tests__/Login.test.ts
├── views/__tests__/Recover.test.ts
├── views/__tests__/Docs.test.ts
└── components/__tests__/
    ├── Navbar.test.ts
    ├── RiskWarning.test.ts
    ├── QrcodeModal.test.ts
    ├── DepartmentTreeSelect.test.ts
    └── SubscriptionCard.test.ts
```

## Mock 策略

| 依赖 | Mock 方式 |
|------|----------|
| API 层 (`@/api`) | `vi.mock('@/api')` 整体 mock，per-test `mockResolvedValue` |
| Pinia stores | `@pinia/testing` 的 `createTestingPinia`，自动 stub actions |
| Router | `createMemoryHistory` 创建真实 router 实例 |
| hCaptcha | stub 组件，手动 emit `verify` 事件 |
| qrcode.vue | stub 组件 |
| @1password/save-button | stub 组件 |
| navigator.clipboard | `vi.fn()` |
| window.open | `vi.fn()` |

shadcn-vue UI 组件不单独测试，通过父组件集成测试间接覆盖。

## 各模块测试内容

### Stores

**auth.test.ts**:
- token 读写 localStorage
- isAuthenticated 响应 token 变化
- register() 成功/失败
- loginWithToken() 验证 + 设置 userInfo
- fetchUserInfo()
- logout() 清空状态

**config.test.ts**:
- load() 从 API 获取 publicUrl
- 默认值回退

### API 层

**api/index.test.ts**:
- 各方法请求参数 (URL, headers, body)
- 401/429/500 错误处理
- register/createSubscription 120s 超时
- Authorization header 附加

### Router

**router/index.test.ts**:
- 未认证 → requiresAuth 路由重定向 /login
- 已认证 → 正常进入
- 公开路由正常访问

### Views (核心)

**Dashboard.test.ts**:
- 订阅列表加载与渲染
- 空状态
- 同步单个/全部订阅
- 删除订阅 (确认对话框 → API → 列表更新)
- 导出 (ICS/JSON/CSV URL)
- 复制链接
- 轮询逻辑 (pending → 2s 轮询 → 30s 超时)
- 删除账户
- 错误状态

**Register.test.ts**:
- 表单渲染与验证
- 注册步骤进度展示
- 成功后 token 展示
- 错误处理
- hCaptcha 集成

**Add.test.ts**:
- Tab 切换 (5 种 source type)
- 搜索 + 300ms debounce
- 结果列表 + 已订阅标记
- 创建订阅
- 数量限制 (>=5 禁用)
- admin_class: 部门选择 + 年级过滤
- token 过期检测

### Views (辅助)

- **Home.test.ts**: 渲染 + 导航链接
- **Login.test.ts**: token 输入 → 验证 → 跳转
- **Recover.test.ts**: 恢复 token 流程
- **Docs.test.ts**: 文档内容渲染

### Components

- **Navbar.test.ts**: 登录/未登录菜单差异，主题切换
- **RiskWarning.test.ts**: 首次显示 → 确认 → localStorage 记忆
- **QrcodeModal.test.ts**: URL → 二维码渲染
- **DepartmentTreeSelect.test.ts**: 树形展开/折叠/选择
- **SubscriptionCard.test.ts**: props 渲染 + 操作事件

## 约定

- 文件名: `ComponentName.test.ts`
- 放在同级 `__tests__/` 目录
- describe 块按功能区域组织
- 测试命名用中文描述
