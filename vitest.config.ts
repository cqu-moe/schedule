import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          compatibilityDate: "2025-01-01",
          // The wrangler.jsonc `services` binding points at the external
          // `cqu-moe-auth` Worker, which does not exist in the test runtime.
          // Stub it here so miniflare can start; tests that exercise AUTH RPC
          // inject their own mock via `env.AUTH = ...` (see services/auth-mock.ts).
          serviceBindings: {
            AUTH() {
              return new Response("AUTH service binding stub", { status: 501 });
            },
          },
        },
      },
    },
  },
});
