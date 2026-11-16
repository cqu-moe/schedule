# Design package provenance

Theme/UI 1.3.1 are candidate archives built from [cqu-moe/design commit caa527c](https://github.com/cqu-moe/design/commit/caa527c1b9df926e14968f6d68c50820461d2e04), proposed in [design PR #17](https://github.com/cqu-moe/design/pull/17). They have not been published to a registry.

The UI build preserves internal ESM module boundaries so Vite can keep route-only component dependencies in lazy chunks. Public imports remain `@cqu-moe/ui` and `@cqu-moe/ui/charts`; component APIs, theme tokens and interactions are unchanged. Both package versions move together.

To reproduce, check out that source commit, run `pnpm install --frozen-lockfile` and `pnpm build`, then pack `packages/theme` and `packages/ui`. Distributed archive hashes are in [SHA256SUMS](SHA256SUMS).

Validated: design `pnpm check`, 108 Chromium desktop/mobile browser checks, and independent packaged consumer verification. The verified tarball hashes match these distributed archives. Schedule's third-party dependency versions remain unchanged.
