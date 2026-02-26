# 1Password 集成优化设计

## 目标

优化前端 Token 输入和展示体验，使其兼容 1Password autofill 和 Save in 1Password 功能。

## 改动范围

### A. Login 页面 — Token 输入框 autofill

**现状：** `<Input id="token">` 无 `type`、`autocomplete` 属性，1Password 无法识别。

**改动：**
- Token 输入框加 `type="password"` + `autocomplete="current-password"` + `spellcheck="false"`
- `<form>` 和 `<Label for="token">` 已存在，符合 1Password 最佳实践
- 1Password 会将其识别为密码字段并提示 autofill

### B. Register 成功对话框 — Save in 1Password 按钮

**现状：** Token 展示为 `<code>` 块 + Copy 按钮。

**改动：**
- 在 Token 展示区域和"我已保存"按钮之间放置 Save in 1Password 按钮
- 按钮配置：
  - `data-onepassword-type="login"`
  - `lang="zh-CN"`
  - 默认蓝色 + light 主题
- Save request:
  ```js
  { title: "CQU Schedule", fields: [{ autocomplete: "current-password", value: token }] }
  ```
- Token 展示后调用 `activateOPButton()` 激活（SPA 需要）

### C. Recover 成功页 — Save in 1Password 按钮

**现状：** 与 Register 类似，Token 展示为 `<code>` 块 + Copy 按钮。

**改动：** 同 B，在 Token 展示区域和"进入仪表盘"按钮之间放置 Save in 1Password 按钮。

## 技术细节

### 依赖

- `@1password/save-button` — npm 包，提供 `<onepassword-save-button>` custom element 和 `encodeOPSaveRequest`/`activateOPButton` 工具函数

### Save in 1Password 按钮工作原理

1. 导入 `@1password/save-button/index.js` 注册 custom element
2. 用 `encodeOPSaveRequest()` 将 save request 编码为 Base64
3. 渲染 `<onepassword-save-button>` 并设置 `value` 属性
4. 1Password 浏览器扩展检测到按钮后自动启用
5. 用户点击按钮 → 1Password 弹出保存对话框，item 自动关联当前域名

### 涉及文件

| 文件 | 改动 |
|------|------|
| `frontend/package.json` | 添加 `@1password/save-button` 依赖 |
| `frontend/src/views/Login.vue` | Token 输入框加 `type="password"` + `autocomplete` + `spellcheck` |
| `frontend/src/views/Register.vue` | Token Dialog 中添加 Save in 1Password 按钮 |
| `frontend/src/views/Recover.vue` | 成功页添加 Save in 1Password 按钮 |

### Register.vue Token Dialog 布局（改动后）

```
┌─────────────────────────────┐
│ 注册成功                      │
│ 请妥善保存你的 Token，以后用它登录 │
│                              │
│ ┌──────────────────────┐     │
│ │ abc123...def  [Copy] │     │
│ └──────────────────────┘     │
│                              │
│ [  Save in 1Password  ]     │
│                              │
│ [      我已保存       ]      │
└─────────────────────────────┘
```

### Recover.vue 成功页布局（改动后）

```
┌─────────────────────────────┐
│ 找回成功！你的 Token：         │
│                              │
│ ┌──────────────────────┐     │
│ │ abc123...def  [Copy] │     │
│ └──────────────────────┘     │
│                              │
│ [  Save in 1Password  ]     │
│                              │
│ [     进入仪表盘      ]      │
└─────────────────────────────┘
```
