import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bounded fallback for the demonstrated Web SPI 0.15 TLS option gap. This
// changes one context option in memory; installed package bytes stay intact.
assert.equal(process.env.SCHEDULE_E2E_BROWSER, 'webkit');
const origin = new URL(process.env.SCHEDULE_E2E_URL);
assert.equal(origin.protocol, 'https:');
assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.origin, process.env.SCHEDULE_E2E_URL);
const root = process.cwd();
const output = resolve(process.env.SCHEDULE_E2E_OUTPUT);
assert.ok(output.startsWith(resolve(root, '.e2e') + '/'));
const require = createRequire(import.meta.url);
const surface = join(dirname(require.resolve('@e2e-dev/web')), 'surface.js');
assert.ok(realpathSync(surface).startsWith(resolve(root, 'node_modules') + '/'));
const sourceHash = 'fc8c2987e311729e8fdd962bc6af6ec7cd288357838bec85446e4a22500afc06';
assert.equal(JSON.parse(readFileSync(join(dirname(surface), '../package.json'))).version, '0.15.0');
const needle = 'contextOptions: {\n                viewport: this.viewport,';
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || fileURLToPath(url) !== surface) return result;
    const bytes = readFileSync(surface);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceHash, 'TLS fallback dependency source changed');
    const source = Buffer.from(result.source).toString('utf8');
    assert.equal(source, bytes.toString('utf8'), 'Unexpected preceding framework transform');
    assert.equal(source.split(needle).length, 2, 'TLS fallback must change exactly one context creation site');
    const transformed = source.replace(needle, 'contextOptions: {\n                ignoreHTTPSErrors: true,\n                viewport: this.viewport,');
    writeFileSync(join(output, `tls-context-${process.pid}.json`), JSON.stringify({
      adapter: 'schedule-webkit-local-tls', browser: 'webkit', pid: process.pid,
      origin: origin.origin, dependencyVersion: '0.15.0', sourceHash,
      transformedHash: createHash('sha256').update(transformed).digest('hex'),
      contextOption: { ignoreHTTPSErrors: true }, installedSourceUnchanged: true,
    }, null, 2) + '\n', { mode: 0o600 });
    return { ...result, source: transformed };
  },
});
