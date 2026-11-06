import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Public artifact fixtures exercise the CLI gate, not the browser or application.
const all = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
const selections = [all.slice(0, 2), [all[2]], [all[3]], [all[4]]];
const artifact = 'schedule-e2e-commit-round-1-desktop-shard-1';
const manifest = `${artifact}/run-fixture/desktop/run.json`;
async function change(root, path, update) {
  const file = join(root, path);
  await writeFile(file, JSON.stringify(update(JSON.parse(await readFile(file, 'utf8')))));
}
const cases = [
  ['complete matrix', async () => {}, null],
  ['missing shard', root => rm(join(root, artifact), { recursive: true }), /missing shard/],
  ['duplicate coverage', async root => {
    const path = 'schedule-e2e-commit-round-1-desktop-shard-2/run-fixture/desktop/';
    await change(root, path + 'discovery.json', data => ({ ...data, selected: [all[0], all[2]] }));
    await change(root, path + 'run.json', data => ({ ...data, expectedIds: ['a', 'c'], executedIds: ['a', 'c'] }));
  }, /Duplicate selected test/],
  ['failed shard', root => change(root, manifest, data => ({ ...data, status: 'failed' })), /Shard did not pass/],
  ['different source', root => change(root, manifest, data => ({ ...data, source: { fingerprint: 'b'.repeat(64) } })), /Source fingerprints differ/],
  ['unexecuted test', root => change(root, manifest, data => ({ ...data, executedIds: ['a'] })), /Executed\/expected differ/],
  ['unexpected artifact', root => mkdir(join(root, 'unexpected')), /Unexpected artifact/],
];
for (const [name, damage, failure] of cases) test(name, async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-shards-'));
  try {
    for (const browser of ['chromium', 'firefox', 'webkit']) for (const round of [1, 2]) for (const viewport of ['desktop', 'mobile']) {
      for (const [index, selected] of selections.entries()) {
        const name = browser === 'chromium'
          ? `schedule-e2e-commit-round-${round}-${viewport}-shard-${index + 1}`
          : `schedule-release-commit-round-${round}-${browser}-${viewport}-shard-${index + 1}`;
        const directory = join(root, name, 'run-fixture', viewport);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'discovery.json'), JSON.stringify({ all, selected }));
        await writeFile(join(directory, 'run.json'), JSON.stringify({ browser, variant: viewport,
          source: { fingerprint: 'a'.repeat(64) }, status: 'passed',
          expectedIds: selected.map(pair => pair.id), executedIds: selected.map(pair => pair.id) }));
      }
    }
    await damage(root);
    const result = spawnSync(process.execPath, ['e2e/verify-shards.mjs', root, 'chromium,firefox,webkit'], { encoding: 'utf8' });
    assert.equal(result.status, failure ? 1 : 0, result.stderr);
    if (failure) assert.match(result.stderr, failure);
    else assert.match(result.stdout, /Verified 48 passed shards/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
