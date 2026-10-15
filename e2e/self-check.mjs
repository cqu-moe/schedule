import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(`.e2e/negative-${Date.now()}`);
await mkdir(root, { recursive: true });
async function rejected(name, args, environment, validate) {
  const output = `${root}/${name}`;
  const child = spawnSync(process.execPath, ['e2e/run.mjs', ...args], {
    stdio: 'inherit', timeout: 600000,
    env: { ...process.env, SCHEDULE_E2E_MOBILE: '1', SCHEDULE_E2E_OUTPUT: output, ...environment },
  });
  assert.equal(child.signal, null, `${name} must fail through its own gate, not a harness timeout`);
  assert.equal(child.status, 1, `${name} must exit nonzero`);
  const report = JSON.parse(await readFile(`${output}/mobile/run.json`, 'utf8'));
  assert.equal(report.status, 'failed');
  await validate(report, output);
}
await rejected('empty', ['--grep', '^intentionally-no-such-journey$'], {}, report => {
  assert.equal(report.groups.length, 0);
  assert.match(JSON.stringify(report.errors), /Zero selected tests|Framework discovery failed/);
});
await rejected('wrong-pin', ['--grep', '^unbound:'], { SCHEDULE_AUTH_COMMIT: '0'.repeat(40) }, report => {
  assert.equal(report.groups[0].cleanup, 'not-started');
  assert.equal(report.groups[0].runnerExitCode, undefined);
  assert.match(JSON.stringify(report.groups[0].errors), /0000000000000000000000000000000000000000/);
});
await rejected('wrong-result', ['--grep', '^login, create'], { SCHEDULE_E2E_BREAK_ASSERTION: '1' }, async (report, output) => {
  assert.equal(report.groups[0].summary.failed, 1);
  assert.equal(report.groups[0].cleanup, 'passed');
  const actual = JSON.parse(await readFile(`${output}/mobile/${report.groups[0].expectedIds[0].slice(0, 12)}/report.json`, 'utf8'));
  const failed = actual.run.results.filter(test => test.selected && test.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(JSON.stringify(failed), /故意错误的课程内容/);
});
await rejected('cleanup', ['--grep', '^no-sync:'], { SCHEDULE_E2E_FAIL_CLEANUP: '1' }, report => {
  assert.equal(report.groups[0].summary.passed, 1);
  assert.equal(report.groups[0].cleanup, 'failed');
  assert.ok(report.groups[0].resources.listenersClosed.length === 3);
  assert.match(JSON.stringify(report.groups[0].errors), /Injected cleanup failure/);
});
console.log(`Four negative controls passed; evidence ${root}`);
