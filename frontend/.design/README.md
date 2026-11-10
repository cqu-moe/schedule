# Design package provenance

Theme/UI 1.3.0 are built from [cqu-moe/design commit ac75e66](https://github.com/cqu-moe/design/commit/ac75e6623025a94edca929c539fcd270d60f415a), proposed in [design PR #16](https://github.com/cqu-moe/design/pull/16).

`ActionButton.idleIcon` accepts a semantic Lucide icon while retaining the existing arrow default and shared loading, success, error and accessibility behavior. Both package versions move together; theme tokens are unchanged.

To reproduce, check out the source commit, run `pnpm install --frozen-lockfile` and `pnpm build`, then pack `packages/theme` and `packages/ui`. Distributed archive hashes are in [SHA256SUMS](SHA256SUMS).

Validated: design `pnpm check`, 108 Chromium desktop/mobile browser checks, and independent packaged consumer verification. The verified tarball hashes match these distributed archives. Schedule's third-party dependency versions remain unchanged.
