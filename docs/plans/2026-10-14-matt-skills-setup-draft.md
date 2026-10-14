# Matt 工程技能配置草稿

状态：2026-10-14 用户确认后已按下列草稿应用；配置文件与 GitHub 五个角色标签均已核验。下文保留确认时的草稿内容。

当前远程仓库为 `cqu-moe/schedule`，GitHub Issues 已启用。已有 `CLAUDE.md`、`AGENTS.md` 和领域词汇表；没有技能配置目录及 Agent skills 区块。前后端属于同一个课表业务上下文；前端 workspace 仅包含自身，不是多个领域的 monorepo。triage 技能已安装。

拟采用 GitHub Issues、默认五个 triage 标签和 single-context 领域文档。按 setup 技能规则，入口追加到已有 `CLAUDE.md`。

## 追加到 CLAUDE.md 的内容

```markdown
## Agent skills

### Issue tracker

规格、任务和问题使用 `cqu-moe/schedule` 的 GitHub Issues；通过 `gh` 操作。见 [Issue tracker](docs/agents/issue-tracker.md)。

### Triage labels

使用默认五种 triage 角色标签，保留现有分类标签。见 [Triage labels](docs/agents/triage-labels.md)。

### Domain docs

采用 single-context：根目录 `GLOSSARY.md` 与按需创建的 `docs/adr/`。见 [Domain docs](docs/agents/domain.md)。
```

## docs/agents/issue-tracker.md

```markdown
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
```

## docs/agents/triage-labels.md

```markdown
# Triage labels

工程技能的五个角色映射如下；其他现有标签可继续作为主题分类使用。

| 技能角色 | GitHub 标签 | 含义 |
| --- | --- | --- |
| needs-triage | needs-triage | 等待维护者判断范围与处理方式 |
| needs-info | needs-info | 等待报告者补充必要信息 |
| ready-for-agent | ready-for-agent | 规格或任务已整理，可交由代理处理 |
| ready-for-human | ready-for-human | 需要人工实施或操作 |
| wontfix | wontfix | 明确不处理 |

技能提及某个角色时，使用表中的对应标签；不自动覆盖现有同名标签的描述或颜色。
```

## docs/agents/domain.md

```markdown
# Domain docs

本仓库采用 single-context：根目录 `GLOSSARY.md` 保存课表订阅的领域术语，`docs/adr/` 按需保存架构决策。
前后端共享同一套领域词汇，不因技术目录不同拆分上下文。

- 探索前阅读已有 `GLOSSARY.md` 及与任务相关的 ADR；不存在则继续，不预先创建空文件。
- 若将来存在 `GLOSSARY-MAP.md`，按 map 读取相关上下文。
- 规格、issue、测试和实现使用词汇表的规范名称；概念缺失或冲突交由 domain-modeling 澄清。
- 词汇表只定义领域概念，不记录实现方案、任务列表或临时状态。
- ADR 仅记录难以逆转、存在真实取舍且缺少背景会令人困惑的决定。
- 同时尊重已有 `docs/decisions/`、`docs/plans/` 和其他设计规格；不为适配技能复制或搬迁历史文档。
- 新方案与已有决定冲突时指出冲突和重开理由，不静默覆盖。
```

## GitHub 标签补齐

保留已有 `wontfix`；只创建缺少的 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`。
