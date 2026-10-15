import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the actual runner's publication boundary with real child processes.
// Dependency/CLI fixtures below are harness controls, never native journey proof.
await mkdir('.e2e', { recursive: true });
const root = await mkdtemp(resolve('.e2e/artifact-safety-controls-'));
const digest = value => createHash('sha256').update(value).digest('hex');
const id = '1'.repeat(64), title = 'artifact publication control';
const pair = { id, title, kind: 'test', disposition: 'run', tags: [], target: 'desktop' };
const results = [];
async function filesIn(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesIn(path)); else paths.push(path);
  }
  return paths;
}

for (const fault of ['none', 'scanner', 'verified-read', 'private-write', 'publish', 'receipt-write', 'primary-cleanup', 'changed-after-check']) {
  const directory = join(root, fault); await mkdir(directory);
  const configuration = { fault, known: randomUUID() + randomUUID(), unknown: randomUUID(), directory, pair };
  await writeFile(join(directory, 'config.json'), JSON.stringify(configuration), { mode: 0o600 });
  const fixture = join(directory, 'runtime.mjs'), loader = join(directory, 'loader.mjs'), preload = join(directory, 'preload.mjs');
  await writeFile(fixture, `import fs from 'node:fs/promises';
import {join} from 'node:path';
import {sanitizeArtifacts} from ${JSON.stringify(pathToFileURL(resolve('e2e/artifact-safety.mjs')).href)};
const c=JSON.parse(await fs.readFile(new URL('./config.json',import.meta.url)));
async function inspect(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await inspect(p);else if((await fs.readFile(p,'utf8')).includes(c.unknown))throw new Error('Sensitive synthetic value found in E2E text artifacts');}}
export async function startSchedule(){return {origin:'http://127.0.0.1:1',authOrigin:'http://127.0.0.1:2',controlOrigin:'http://127.0.0.1:3',schoolOrigin:'http://127.0.0.1:4',authCommit:'843134bec42690958d85881d850c5890c66367e0',
 async diagnostics(){return {token:c.known};},
 async close(){if(c.fault==='primary-cleanup')throw new Error('CONTROL cleanup failed '+c.known);return {platform:{proxyObjectsRemoved:true,removedProxyIds:[],removedContainerIds:[]}};},
 async checkArtifacts(dir){const manifest=await sanitizeArtifacts(dir,{redact:async()=>{},check:inspect,secrets:new Set([c.known]),privateRoot:c.directory});
  if(c.fault==='changed-after-check')await fs.appendFile(join(dir,'runner.log'),c.known);
  await fs.writeFile(join(c.directory,'checked'),'checked');return manifest;}
};}
`);
  await writeFile(loader, `export async function resolve(s,c,n){if(s==='./runtime.mjs'&&c.parentURL?.endsWith('/e2e/run.mjs'))return {url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true};return n(s,c);}`);
  const provider = join(directory, 'cli.mjs');
  await writeFile(provider, `import fs from 'node:fs/promises';import {join} from 'node:path';
const c=JSON.parse(await fs.readFile(new URL('./config.json',import.meta.url)));
if(process.argv[2]==='list')console.log(JSON.stringify({pairs:[c.pair]}));
else {const failed=c.fault==='primary-cleanup';const status=failed?'failed':'passed';await fs.mkdir(process.env.SCHEDULE_E2E_OUTPUT,{recursive:true});
 await fs.writeFile(join(process.env.SCHEDULE_E2E_OUTPUT,'report.json'),JSON.stringify({run:{status,summary:{passed:failed?0:1,failed:failed?1:0,interrupted:0,skipped:0,flaky:0},results:[{...c.pair,selected:true,status,attempts:[{cleanup:'complete',secondaryErrors:[]}]}]}}));
 console.log(c.known);if(['scanner','receipt-write','primary-cleanup'].includes(c.fault))console.log(c.unknown);process.exitCode=failed?1:0;}
`);
  await writeFile(preload, `import {register,syncBuiltinESMExports} from 'node:module';import cp from 'node:child_process';import fs from 'node:fs/promises';import {existsSync} from 'node:fs';
register(${JSON.stringify(pathToFileURL(loader).href)});
const c=JSON.parse(await fs.readFile(${JSON.stringify(join(directory, 'config.json'))}));
const spawn=cp.spawn;cp.spawn=(file,args,options)=>args?.[0]?.endsWith('node_modules/e2e/dist/cli/bin.js')?spawn(process.execPath,[${JSON.stringify(provider)},...args.slice(1)],options):spawn(file,args,options);
const read=fs.readFile,write=fs.writeFile,rename=fs.rename;let injected=false;
const fail=()=>{injected=true;return Object.assign(new Error('CONTROL '+c.fault+' '+c.known),{code:'EIO'});};
fs.readFile=async(path,...args)=>{if(!injected&&c.fault==='verified-read'&&existsSync(c.directory+'/checked')&&String(path).endsWith('/runtime.json'))throw fail();return read(path,...args);};
fs.writeFile=async(path,...args)=>{if(!injected&&c.fault==='private-write'&&String(path).endsWith('/runtime.json'))throw fail();return write(path,...args);};
fs.rename=async(from,to,...args)=>{if(!injected&&((c.fault==='publish'&&String(to).endsWith('/${id.slice(0, 12)}'))||(c.fault==='receipt-write'&&String(to).endsWith('/runtime.json'))))throw fail();return rename(from,to,...args);};
syncBuiltinESMExports();`);
  const output = join(directory, 'public');
  const child = spawnSync(process.execPath, ['--import', preload, 'e2e/run.mjs'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, SCHEDULE_E2E_OUTPUT: output, SCHEDULE_E2E_VIEWPORT: 'desktop' },
  });
  await writeFile(join(directory, 'child.log'), child.stdout + child.stderr, { mode: 0o600 });
  try {
    assert.equal(child.signal, null, 'Control must not pass by timing out');
    assert.equal(child.status, fault === 'none' ? 0 : 1, 'Actual runner child exit');
    const aggregate = JSON.parse(await readFile(join(output, 'desktop/run.json'))), group = aggregate.groups[0];
    assert.equal(aggregate.status, fault === 'none' ? 'passed' : 'failed');
    for (const path of await filesIn(output)) {
      const text = await readFile(path, 'utf8');
      assert.ok(!text.includes(configuration.known) && !text.includes(configuration.unknown), 'Unverified bytes crossed the upload boundary');
    }
    if (fault === 'none') {
      assert.equal(group.diagnostics.token, '[synthetic-secret-redacted]');
      assert.equal(group.cleanup, 'passed');
      assert.ok((await filesIn(output)).some(path => path.endsWith('/report.json')));
    } else {
      assert.equal(group.artifactSafety, 'quarantined');
      assert.ok(!(await filesIn(output)).some(path => path.endsWith('/report.json') || path.endsWith('/runner.log')));
      if (['scanner', 'receipt-write', 'primary-cleanup'].includes(fault)) {
        const locations = group.errors.flatMap(error => error.artifactDiagnostics ?? []);
        assert.ok(locations.some(item => item.file === 'runner.log' && item.category === 'dependency-sensitive-check' && item.needle === 'not-exposed'));
      }
      if (fault === 'primary-cleanup') {
        assert.equal(group.cleanup, 'failed');
        assert.ok(group.errors.some(error => error.phase === 'child'));
        assert.ok(group.errors.some(error => error.phase === 'cleanup'));
      }
      if (fault === 'verified-read' || fault === 'changed-after-check') assert.ok(group.errors.some(error => error.phase === 'verified-read'));
      if (fault === 'private-write') assert.ok(group.errors.some(error => error.phase === 'private-write'));
      if (fault === 'publish') assert.ok(group.errors.some(error => error.phase === 'publish'));
      if (fault === 'receipt-write') assert.ok(group.errors.some(error => error.phase === 'receipt-write'));
      const privateDirectories = (await readdir('.e2e', { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && entry.name.startsWith('private-artifacts-'));
      const journals = (await Promise.all(privateDirectories.map(entry => filesIn(resolve('.e2e', entry.name)))))
        .flat().filter(path => path.endsWith('/failure-private.json'));
      const journal = (await Promise.all(journals.map(async path => JSON.parse(await readFile(path))))).find(value =>
        value.test === title && JSON.stringify(value).includes(configuration.known) &&
        value.errors.every(error => group.errors.some(publicError => publicError.sha256 === digest(JSON.stringify(error)))));
      // The plain scanner case need not contain the known secret in its error;
      // the diagnostics still identify the file while keeping the needle opaque.
      assert.ok(journal, 'Original error records must survive in a private journal');
    }
    results.push({ fault, status: 'passed', childExit: child.status, signal: child.signal });
    console.log('Artifact safety control passed: ' + fault);
  } catch (error) {
    await writeFile(join(directory, 'assertion-private.txt'), error.stack, { mode: 0o600 });
    throw new Error('Artifact safety control failed: ' + fault + '; private diagnostic sha256=' + digest(error.stack));
  }
}
await writeFile(join(root, 'receipt.json'), JSON.stringify({ scope: 'Harness publication controls; no native browser/Docker claims', status: 'passed', results }, null, 2) + '\n');
console.log(`Eight artifact safety controls passed; private evidence ${root}`);
