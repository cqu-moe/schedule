import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root, browserList] = process.argv.slice(2);
const browsers = (browserList || '').split(',');
assert.ok(root && browsers.every(browser => ['chromium', 'firefox', 'webkit'].includes(browser)),
  'Usage: node e2e/verify-shards.mjs ROOT chromium,firefox,webkit');
assert.equal(new Set(browsers).size, browsers.length, 'Duplicate browser');
const cells = new Map();
for (const browser of browsers) for (const round of ['1', '2']) for (const viewport of ['desktop', 'mobile']) {
  cells.set(`${browser}/${round}/${viewport}`, new Map());
}
let fingerprint;
for (const artifact of await readdir(root)) {
  const normal = /^schedule-e2e-.+-round-([12])-(desktop|mobile)-shard-([1-4])$/.exec(artifact);
  const release = /^schedule-release-.+-\d+-\d+-round-([12])-(firefox|webkit)-(desktop|mobile)-shard-([1-4])$/.exec(artifact);
  assert.ok(normal || release, `Unexpected artifact: ${artifact}`);
  const [, round, browser, viewport, shard] = normal
    ? [null, normal[1], 'chromium', normal[2], normal[3]] : release;
  const cell = cells.get(`${browser}/${round}/${viewport}`);
  assert.ok(cell && !cell.has(shard), `Unexpected or duplicate shard: ${artifact}`);
  const directory = join(root, artifact);
  const manifests = (await readdir(directory, { recursive: true }))
    .filter(path => new RegExp(`^run-[^/]+/${viewport}/run\\.json$`).test(path));
  assert.equal(manifests.length, 1, `${artifact}: expected one public run manifest`);
  const run = JSON.parse(await readFile(join(directory, manifests[0]), 'utf8'));
  const discovery = JSON.parse(await readFile(join(directory, manifests[0].replace(/run\.json$/, 'discovery.json')), 'utf8'));
  assert.equal(run.browser, browser, 'Wrong browser');
  assert.equal(run.variant, viewport, 'Wrong viewport');
  assert.equal(run.status, 'passed', 'Shard did not pass');
  assert.match(run.source?.fingerprint ?? '', /^[a-f0-9]{64}$/, 'Missing source fingerprint');
  fingerprint ??= run.source.fingerprint;
  assert.equal(run.source.fingerprint, fingerprint, 'Source fingerprints differ');
  assert.ok(discovery.all.length && discovery.selected.length, 'Empty discovery or selection');
  assert.deepEqual(run.expectedIds, discovery.selected.map(pair => pair.id).sort(), 'Expected/selected differ');
  assert.deepEqual(run.executedIds, run.expectedIds, 'Executed/expected differ');
  cell.set(shard, discovery);
}
for (const [key, cell] of cells) {
  assert.equal(cell.size, 4, `${key}: missing shard`);
  const discoveries = [...cell.values()];
  for (const discovery of discoveries) assert.deepEqual(discovery.all, discoveries[0].all, 'Full discovery differs');
  const selected = discoveries.flatMap(discovery => discovery.selected.map(pair => pair.id));
  assert.equal(new Set(selected).size, selected.length, 'Duplicate selected test');
  assert.deepEqual(selected.sort(), discoveries[0].all.map(pair => pair.id).sort(), 'Incomplete matrix coverage');
}
console.log(`Verified ${cells.size * 4} passed shards for source ${fingerprint}`);
