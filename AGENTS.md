# Project Notes

## Deployment

- This repository is connected to Cloudflare Git Connector for `cqu-moe/schedule-cloudflare`; pushing to GitHub can trigger Cloudflare build/deploy automation.
- Do not use `git push` as part of an ad-hoc Codex deployment unless the user explicitly asks for a push.
- For manual deployment from Codex, prefer a clean committed tree and run Wrangler directly.
- Before deploying, check `git status --short`. Untracked files under `frontend/public/` can be copied by Vite into `frontend/dist`, so deploy from a clean checkout or a `git archive` of `HEAD` when untracked frontend assets exist.
- Current Cloudflare build settings shown in the dashboard: deploy command `npm run deploy`, version command `npm run build:frontend && npx wrangler versions upload`, root directory `/`.
