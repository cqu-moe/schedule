import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Real entry/child processes; the fake child only tests the stream boundary.
// No browser, application, network or native business outcome is simulated as proof.
await mkdir('.e2e', { recursive: true });
const root = await mkdtemp(resolve('.e2e/private-release-safety-'));
const results = [];
async function filesIn(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesIn(path)); else paths.push(path);
  }
  return paths;
}
for (const fault of ['streams-and-primary', 'primary-and-finalizer', 'admission', 'git-stderr']) {
  const directory = join(root, fault); await mkdir(directory);
  const known = randomUUID(), unknown = randomUUID();
  const config = { directory, known, unknown, fault };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const provider = join(directory, 'child.mjs');
  await writeFile(provider, `import fs from 'node:fs/promises';import {join} from 'node:path';
const c=JSON.parse(await fs.readFile(new URL('./config.json',import.meta.url)));
process.stdout.write(c.known);process.stderr.write(c.unknown);
const dir=join(process.env.SCHEDULE_E2E_OUTPUT,'desktop');await fs.mkdir(dir,{recursive:true});
await fs.writeFile(join(dir,'run.json'),JSON.stringify({source:{fingerprint:c.known},groups:[]}));process.exitCode=1;
`);
  const preload = join(directory, 'preload.mjs');
  await writeFile(preload, `import cp from 'node:child_process';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const c=JSON.parse(await fs.readFile(${JSON.stringify(join(directory, 'config.json'))}));
const spawn=cp.spawn;cp.spawn=(file,args,options)=>args?.[0]==='e2e/run.mjs'?spawn(process.execPath,[${JSON.stringify(provider)}],options):spawn(file,args,options);
const exec=cp.execFileSync;cp.execFileSync=(file,args,options)=>file==='git'&&args[0]==='ls-files'&&c.fault==='git-stderr'?exec(process.execPath,['-e','process.stderr.write('+JSON.stringify(c.known+c.unknown)+');process.exit(1)'],options):exec(file,args,options);
const read=fs.readFile;let reads=0;fs.readFile=async(path,...args)=>{if(String(path)==='e2e/README.md'&&++reads===2&&c.fault==='primary-and-finalizer')throw new Error('CONTROL finalizer '+c.unknown);return read(path,...args);};
syncBuiltinESMExports();`);
  const output = join(directory, 'public');
  const child = spawnSync(process.execPath, ['--import', preload, 'e2e/release-web.mjs', ...(fault === 'admission' ? [known] : [])], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, SCHEDULE_RELEASE_OUTPUT: output },
  });
  await writeFile(join(directory, 'console-private.log'), child.stdout + child.stderr, { mode: 0o600 });
  try {
    assert.equal(child.signal, null, 'Timeout or signal is not the intended failure');
    assert.equal(child.status, 1);
    assert.ok(!(child.stdout + child.stderr).includes(known) && !(child.stdout + child.stderr).includes(unknown), 'Raw stream/exception reached console');
    const summary = JSON.parse(child.stdout.trim());
    assert.equal(summary.status, 'failed');
    assert.equal(summary.errors.length, fault === 'primary-and-finalizer' ? 2 : 1);
    const privateDirectory = ['admission', 'git-stderr'].includes(fault)
      ? (await readdir('.e2e', { withFileTypes: true })).filter(e => e.isDirectory() && e.name.startsWith('private-release-') && !e.name.startsWith('private-release-safety-'))
        .map(e => resolve('.e2e', e.name))
      : [JSON.parse(await readFile(join(output, 'receipt.json'))).privateEvidenceRoot];
    const journals = (await Promise.all(privateDirectory.map(d => filesIn(d)))).flat().filter(p => p.endsWith('failure-private.json'));
    const journal = (await Promise.all(journals.map(async p => JSON.parse(await readFile(p))))).find(j => JSON.stringify(j).includes(known));
    assert.ok(journal, 'Actual primary exception must survive privately');
    assert.equal(journal.failures.length, summary.errors.length);
    for (const [i, failure] of journal.failures.entries()) assert.equal(summary.errors[i].sha256,
      createHash('sha256').update(JSON.stringify(failure)).digest('hex'));
    if (fault === 'primary-and-finalizer') assert.ok(JSON.stringify(journal).includes(unknown));
    if (!['admission', 'git-stderr'].includes(fault)) {
      const receipt = JSON.parse(await readFile(join(output, 'receipt.json')));
      assert.ok(!JSON.stringify(receipt).includes(known) && !JSON.stringify(receipt).includes(unknown));
      const log = await readFile(join(receipt.privateEvidenceRoot, 'firefox-desktop.log'), 'utf8');
      assert.ok(log.includes(known) && log.includes(unknown), 'Both actual streams must be retained privately');
    }
    results.push({ fault, status: 'passed', childExit: child.status, signal: child.signal });
  } catch (error) {
    await writeFile(join(directory, 'assertion-private.log'), error.stack, { mode: 0o600 });
    throw new Error('Release safety control failed; private diagnostic hash=' + createHash('sha256').update(error.stack).digest('hex'));
  }
}
await writeFile(join(root, 'receipt.json'), JSON.stringify({ scope: 'Offline release stream/exception controls only', status: 'passed', results }, null, 2) + '\n');
console.log('Four release stream/exception controls passed; private evidence ' + root);
