import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = process.cwd();
const pin = JSON.parse(await readFile('e2e/auth-dependency.json', 'utf8'));
assert.equal(pin.repository, 'https://github.com/cqu-moe/auth.git');
assert.match(pin.commit, /^[a-f0-9]{40}$/);
const auth = resolve('.e2e/deps/auth');
const command = (file, args, cwd = root, extra = {}) => execFileSync(file, args, {
  cwd, stdio: 'inherit', timeout: 900000,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', DO_NOT_TRACK: '1',
    VITE_POSTHOG_PROJECT_TOKEN: '', VITE_POSTHOG_HOST: '', ...extra },
});
await mkdir('.e2e/deps', { recursive: true });
try { await access(join(auth, '.git')); }
catch {
  command('git', ['clone', '--no-checkout', pin.repository, auth]);
  command('git', ['checkout', '--detach', pin.commit], auth);
}
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: auth, encoding: 'utf8' }).trim(), pin.commit,
  'Existing Auth dependency must match the pin; preserve other checkouts instead of resetting them');
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: auth, encoding: 'utf8' }).trim(), '');
command('npm', ['ci'], auth);
command('npx', ['--yes', 'pnpm@11.19.0', 'install', '--frozen-lockfile'], join(auth, 'frontend'));
command('npm', ['run', 'build'], join(auth, 'frontend'));
command(process.execPath, ['e2e/school/build.mjs'], auth);
command('npx', ['--yes', 'pnpm@11.19.0', 'install', '--frozen-lockfile'], join(root, 'frontend'));
command('npx', ['--yes', 'pnpm@11.19.0', 'run', 'build'], join(root, 'frontend'));
command(process.execPath, ['node_modules/playwright-core/cli.js', 'install', 'chromium']);
console.log(`Built real Schedule and Auth ${pin.commit}; no service has been deployed.`);
