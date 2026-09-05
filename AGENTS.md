# Project Notes

## Deployment

- This repository is connected to Cloudflare Git Connector for `cqu-moe/schedule-cloudflare`; pushing to GitHub can trigger Cloudflare build/deploy automation.
- For normal Codex deployments in this repository, commit the intended changes and use `git push`; let Cloudflare Git Connector build and deploy from GitHub.
- Do not run an extra manual `wrangler deploy` after pushing unless the user explicitly asks for manual deployment or Cloudflare Git Connector is unavailable.
- Before committing and pushing, check `git status --short`. Untracked files under `frontend/public/` can be copied by Vite into `frontend/dist` during local builds, but they will not be included in the Git Connector deploy unless they are committed.
- Current Cloudflare build settings shown in the dashboard: deploy command `npm run deploy`, version command `npm run build:frontend && npx wrangler versions upload`, root directory `/`.
