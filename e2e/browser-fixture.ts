import { beforeEach, afterEach, type Browser } from '@e2e-dev/web';
import { expect, credentials, type App, type Screen } from 'e2e';
import { browserContext } from '../e2e.config';

export const externalRequests: Array<{path: string; sourceType: string | null; directory: boolean}> = [];

export function installNetworkGuard() {
let unexpected: string[];
let responses: Array<{ at: string; path: string; status: number }>;
beforeEach(async ({ app, browser }) => {
  unexpected = [];
  responses = [];
  externalRequests.length = 0;
  const allowed = [process.env.SCHEDULE_E2E_URL!, process.env.SCHEDULE_AUTH_URL!];
  await browser.route('**/*', async route => {
    if (new URL(route.request.url).href === 'https://static.cloudflareinsights.com/beacon.min.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* synthetic analytics vendor */' });
      return;
    }
    const url = new URL(route.request.url);
    if (url.pathname.startsWith('/api/v2/external/')) externalRequests.push({path:url.pathname,sourceType:url.searchParams.get('source_type'),directory:url.searchParams.get('lookup') === 'directory'});
    const origin = url.origin;
    if (allowed.includes(origin)) await route.continue();
    else { unexpected.push(origin); await route.abort(); }
  });
  // Start the engine on a JSON endpoint before loading any application script.
  await app.open('/api/v2/config');
  browserContext().on('response', response => {
    const url = new URL(response.url());
    if (url.origin === process.env.SCHEDULE_E2E_URL && ['/api/v2/me', '/api/v2/subscriptions', '/api/v2/notification-settings'].includes(url.pathname)) {
      responses.push({ at: new Date().toISOString(), path: url.pathname, status: response.status() });
    }
  });
  await browserContext().routeWebSocket('**/*', socket => {
    unexpected.push(new URL(socket.url()).origin);
    socket.close({ code: 1008, reason: 'Unplanned WebSocket' });
  });
});
afterEach(async () => {
  console.info('Schedule owner response statuses:', JSON.stringify(responses));
  expect(unexpected).toEqual([]);
});

}

export async function login({ app, browser, screen }: {app: App; browser: Browser; screen: Screen}, name = 'owner') {
  const account = credentials.user(name);
  await app.open('/api/v2/auth/login?returnTo=%2Fadd');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/add/);
}
