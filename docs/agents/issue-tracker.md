# Issue tracker: GitHub

本仓库的规格、任务和问题保存在 GitHub Issues：`cqu-moe/schedule`。
使用 `gh` CLI；跨工作树操作显式带 `--repo cqu-moe/schedule`。

## 操作约定

- 创建前搜索已有问题，避免重复；读取相关问题的正文、标签和评论后再作判断。
- 发布规格即创建 GitHub issue；读取 ticket 即读取对应 issue。
- 多行正文写入 UTF-8 临时文件，使用 `--body-file`；不要将正文插入 shell 命令字符串。
- 创建：`gh issue create --repo cqu-moe/schedule --title "..." --body-file /absolute/path/to/body.md`。
- 读取：`gh issue view <number> --repo cqu-moe/schedule --json number,title,body,labels,comments`。
- 列表：`gh issue list --repo cqu-moe/schedule --state open --json number,title,url,labels`；按任务增加搜索条件。
- 更新正文使用 `gh issue edit` 与 `--body-file`；标签使用 `--add-label` / `--remove-label`。
- 评论使用 `gh issue comment` 与 `--body-file`；只有用户指令或明确调用的技能授权时才发布。
- 角色标签的唯一映射见 `triage-labels.md`；规格与已就绪任务使用 `ready-for-agent`。
- 子任务优先使用 GitHub 原生 sub-issue，阻塞关系优先使用原生 issue dependencies；当前 CLI 或权限不支持时，在正文中明确写 Parent / Blocked by，并说明降级。
- 发布后读回正文、标签和 URL。准备规格或拆票本身不代表可以开始实现、关闭父问题或合并 PR。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub Issues 与 PR 共用编号空间；遇到含糊编号先确认对象类型。
