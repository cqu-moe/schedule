import type { E2EConfig } from 'e2e';
import { surfaceOf, web } from '@e2e-dev/web';

// Config and test modules are loaded in distinct module graphs by e2e. Share
// the handle within this worker so the public surface refers to its attempt.
const holder = globalThis as typeof globalThis & { scheduleE2eEngine?: ReturnType<typeof web> };
export const scheduleEngine = holder.scheduleE2eEngine ??= web({ viewport: process.env.SCHEDULE_E2E_MOBILE
  ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
export const browserContext = () => surfaceOf(scheduleEngine)!.context();

export default {
  tests: ['e2e/**/*.e2e.ts'], workers: 1, retries: 0,
  timeout: 180000, assertionTimeout: 15000, trace: 'retain-on-failure',
  output: process.env.SCHEDULE_E2E_OUTPUT || '.e2e/results',
  credentials: Object.fromEntries(['owner', 'other', 'unbound', 'no-sync', 'no-external'].map(name =>
    [name, { username: `${name}@example.test`, password: 'Synthetic-only-123!' }])),
  targets: [{ name: process.env.SCHEDULE_E2E_MOBILE ? 'mobile' : 'desktop',
    engine: scheduleEngine, app: { url: process.env.SCHEDULE_E2E_URL || 'http://localhost:18799' } }],
} satisfies E2EConfig;
