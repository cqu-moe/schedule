# Telemetry v2

Production uses PostHog project 662666 through `https://p.cqu.moe`. Browser builds use `VITE_POSTHOG_PROJECT_TOKEN`; Worker/container runtime uses `POSTHOG_PROJECT_TOKEN`. These are public collection keys, not management API credentials. Local/test environments default off. Acceptance browsing may use `?telemetry_test=1` and is excluded from product dashboards.

Only explicitly allowed task properties leave the process. Credentials, names, email/student IDs, content, full URLs, raw errors, network bodies and console text are excluded. Authenticated identity is the central internal user ID; logout/account changes reset browser identity. Background work is marked separately from human use.

Owned production web pages use 100% masked replay while the existing free budget permits: inputs/text/attributes and media are masked or blocked; recorder network and console capture are off. School pages are outside the replay boundary. Browser transport preserves routing/session fields while stripping SDK initial person properties. Exceptions contain a bounded class and a fixed synthetic message, without original stack/message.

Rollout: apply new browser build configuration, deploy the reviewed v2 code, then rotate the runtime collection key. Source-map uploads to the old project are removed. Local tests, CI, deployment, observed events/replay and authenticated business acceptance are separate evidence. The old project must remain until the five-product migration is accepted.

Schedule emits sync start/completion with the existing logical run ID, trigger and duration basis. Repeated delivery does not invent a new logical sync. Subscription mutations report server-confirmed outcomes; link copy remains an action rather than evidence of calendar-client subscription. Calendar HTTP delivery is a service metric using an internal subscription ID, never the subscription URL/token and never a human DAU.

Frontend calendar readiness is distinct from sync completion. Latest-attempt and end-to-end durations remain separate. Validation before release: 435 Worker tests and 184 frontend tests plus SDK privacy tests, typecheck and production frontend build. Production deployment and actual ingestion remain pending at this commit.
