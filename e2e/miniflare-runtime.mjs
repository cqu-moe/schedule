import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const patched = new Set();
const sourceHash = '53177da23e4349b2d4d4e8ddee4440959bf19625b187bf11d0cabd7693945d2e';

export function scheduleMiniflare(authDirectory) {
  const require = createRequire(join(authDirectory, 'package.json'));
  const entry = require.resolve('miniflare');
  if (patched.has(entry)) return require('miniflare');
  assert.equal(require('miniflare/package.json').version, '4.20260521.0');
  assert.equal(require.cache[entry], undefined, 'Load the Schedule bridge fix before the pinned Auth runtime');
  const target = pathToFileURL(entry).href;
  let loaded = false;
  const hook = registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== target) return result;
    let source = Buffer.from(result.source).toString('utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), sourceHash, 'Pinned Miniflare source changed');
    const replace = (before, after) => {
      assert.equal(source.split(before).length, 2, 'Pinned Miniflare bridge boundary changed');
      source = source.replace(before, after);
    };
    // E2E-only backport of Cloudflare workers-sdk 6f3d7b58b1f6cd036aca3e5946807bba37776065.
    // A late notify belongs to the previous request, so wait for this reply's
    // generation before consuming the port. Remove when the Auth pin includes it.
    replace('Atomics.store(notifyHandle, /* index */ 0, /* value */ 1);',
      'Atomics.store(notifyHandle, /* index */ 0, /* generation */ (id + 1) | 0);');
    replace(`    Atomics.store(
      this.#notifyHandle,
      /* index */
      0,
      /* value */
      0
    );`, '');
    replace(`    Atomics.wait(
      this.#notifyHandle,
      /* index */
      0,
      /* value */
      0
    );`, `    const generation = (id + 1) | 0;
    for (let seen = Atomics.load(this.#notifyHandle, 0); seen !== generation;
      seen = Atomics.load(this.#notifyHandle, 0)) {
      Atomics.wait(this.#notifyHandle, 0, seen);
    }`);
    loaded = true;
    return { ...result, source };
  } });
  try {
    const module = require('miniflare');
    assert.equal(loaded, true, 'Pinned Miniflare hook was not applied');
    patched.add(entry);
    return module;
  } finally { hook.deregister(); }
}
