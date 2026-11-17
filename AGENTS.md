# Project Notes

## Agent skills

- 前端 HTML、CSS 与客户端交互遵守 `frontend/AGENTS.md` 的 Modern Web Guidance 流程。
- 使用 Matt 工程流程时，复用 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md` 和 `docs/agents/domain.md`；领域词汇入口为 `GLOSSARY.md`。

## Deployment

- This repository is connected to Cloudflare Git Connector for `cqu-moe/schedule-cloudflare`; pushing to GitHub can trigger Cloudflare build/deploy automation.
- For normal Codex deployments in this repository, commit the intended changes and use `git push`; let Cloudflare Git Connector build and deploy from GitHub.
- Do not run an extra manual `wrangler deploy` after pushing unless the user explicitly asks for manual deployment or Cloudflare Git Connector is unavailable.
- Before committing and pushing, check `git status --short`. Untracked files under `frontend/public/` can be copied by Vite into `frontend/dist` during local builds, but they will not be included in the Git Connector deploy unless they are committed.
- 包管理器安装、CI 与 Cloudflare 构建/部署命令见 [开发与部署](docs/ci-cd.md)。变更外部构建设置后单独核实控制台状态。
