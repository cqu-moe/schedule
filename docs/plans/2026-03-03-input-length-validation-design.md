# Input Length Validation Design

Issue: #17 — 用户输入缺少长度校验

## 问题

多个端点的用户输入无最大长度限制，直接传递给 CQU SSO API 或存入数据库，可能导致上游 API 异常、Worker 资源浪费、D1 存储膨胀。

## 校验规则

| 字段 | 端点 | 规则 | 错误信息 |
|------|------|------|----------|
| `student_id` | POST /users, POST /recover | 8 位纯数字 或 18 位身份证号 (17 位数字 + 末位数字/X) | `"student_id must be 8-digit number or 18-digit ID card number"` |
| `password` | POST /users, POST /recover | 非空且 <= 256 字符 | `"password is required"` / `"password must not exceed 256 characters"` |
| `keyword` | GET /search | <= 100 字符 | `"keyword must not exceed 100 characters"` |
| `source_id` | POST /subscriptions | 非空且 <= 100 字符 | `"source_id is required"` / `"source_id must not exceed 100 characters"` |
| `source_name` | POST /subscriptions | 非空且 <= 200 字符 | `"source_name is required"` / `"source_name must not exceed 200 characters"` |

## 实现方式

- 在各路由文件的现有校验逻辑后追加长度/格式校验
- `student_id` 正则: `/^\d{8}$|^\d{17}[\dX]$/`
- 其他字段用 `.length > N` 检查
- 错误码统一 400，格式 `{ detail: "具体错误信息" }`
- 不引入新依赖、不新建工具函数

## 涉及文件

- `src/routes/users.ts` — student_id + password 校验 (注册和恢复两处)
- `src/routes/explore.ts` — keyword 校验
- `src/routes/subscriptions.ts` — source_id + source_name 校验

## 测试

在各路由现有测试文件中添加对应的校验用例。
