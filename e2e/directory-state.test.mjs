import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { scheduleMiniflare } from './miniflare-runtime.mjs';
import { readDirectoryState } from './runtime.mjs';

test('directory observation cannot combine opposite sides of a real D1 completion transaction', async () => {
  const { Miniflare } = scheduleMiniflare(resolve('.e2e/deps/auth'));
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, modules: true,
    compatibilityDate: '2026-05-01', d1Databases: { DB: 'directory-observation' },
    script: 'export default {fetch(){return new Response("control")}}' });
  try {
    const db = await mf.getD1Database('DB');
    await db.exec("CREATE TABLE external_directory_state (id INTEGER,active_run_id TEXT); CREATE TABLE external_directory_runs (id TEXT,status TEXT,phase INTEGER,session_id TEXT,next_attempt_at INTEGER,lease_until INTEGER,last_error TEXT,failure_count INTEGER,started_at INTEGER); CREATE TABLE external_directory_items (run_id TEXT,kind TEXT,id TEXT,name TEXT); CREATE TABLE external_directory_course_cache (user_id TEXT,session_id TEXT,course_id TEXT);");
    await db.exec("INSERT INTO external_directory_state VALUES (1,'run'); INSERT INTO external_directory_runs VALUES ('run','running',2,'202610',0,0,NULL,0,0);");
    const transition = status => db.batch([
      db.prepare('UPDATE external_directory_runs SET status=?').bind(status),
      db.prepare('UPDATE external_directory_state SET active_run_id=?').bind(status === 'running' ? 'run' : null),
    ]);
    const consistent = snapshot => assert.equal(snapshot.state.active_run_id, snapshot.runs[0].status === 'running' ? 'run' : null);
    const oldState = await db.prepare('SELECT * FROM external_directory_state').first();
    await transition('failed');
    const oldRuns = (await db.prepare('SELECT * FROM external_directory_runs').all()).results;
    assert.throws(() => consistent({ state: oldState, runs: oldRuns }), assert.AssertionError);
    await transition('running');
    let reads = 0;
    const snapshot = await readDirectoryState({ prepare: sql => db.prepare(sql), async batch(statements) {
      reads++;
      const result = await db.batch(statements);
      await transition('failed');
      return result;
    } });
    assert.equal(reads, 1);
    consistent(snapshot);
    assert.equal(snapshot.runs[0].status, 'running');
    const completed = await readDirectoryState(db);
    consistent(completed);
    assert.equal(completed.runs[0].status, 'failed');
  } finally { await mf.dispose(); }
});
