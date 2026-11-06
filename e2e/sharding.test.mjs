import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// Check the framework's real discovery: every new journey must enter exactly one CI shard.
for (const viewport of ['desktop', 'mobile']) {
  test(`four ${viewport} shards cover every runnable journey exactly once`, () => {
    const list = args => JSON.parse(execFileSync(process.execPath,
      ['node_modules/e2e/dist/cli/bin.js', 'list', '--reporter', 'json', ...args], {
        encoding: 'utf8', env: { ...process.env, SCHEDULE_E2E_MOBILE: viewport === 'mobile' ? '1' : '' },
      })).pairs.filter(pair => pair.kind === 'test' && pair.disposition === 'run').map(pair => pair.id);
    const all = list([]);
    assert.ok(all.length > 4);
    const shards = Array.from({ length: 4 }, (_, index) => list(['--shard', `${index + 1}/4`]));
    assert.ok(shards.every(ids => ids.length > 0 && ids.length < all.length));
    assert.deepEqual(shards.flat().sort(), all.sort());
  });
}
