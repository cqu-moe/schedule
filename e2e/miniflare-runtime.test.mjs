import assert from 'node:assert/strict';
import test from 'node:test';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { scheduleMiniflare } from './miniflare-runtime.mjs';

test('real D1 readback survives a previous sync reply notifying the next request', async () => {
  const OriginalWorker = threads.Worker, originalWait = Atomics.wait;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const errors = [];
  let workers = 0, waits = 0, workerExited = false, mf;
  threads.Worker = class extends OriginalWorker {
    constructor(source, options) {
      const bridge = options?.eval && typeof source === 'string' && source.includes('const { notifyHandle, port, filename } = workerData;');
      if (bridge) {
        // Force the legal store-before-wait / notify-after-next-wait ordering.
        // Delay only the installed bridge's scheduling, never its reply or SQL.
        const notify = 'Atomics.notify(notifyHandle, /* index */ 0);';
        assert.equal(source.split(notify).length, 2);
        const receive = 'const { id, method, url, headers, body } = event.data;';
        assert.equal(source.split(receive).length, 2);
        source = source.replace(receive, receive + `
          if (id === 0) while (Atomics.load(workerData.scheduleTestGate, 0) < 1)
            Atomics.wait(workerData.scheduleTestGate, 0, 0);
          if (id === 1) while (Atomics.load(workerData.scheduleTestGate, 0) < 3)
            Atomics.wait(workerData.scheduleTestGate, 0, 2);`);
        source = source.replace(notify, `if (id === 0) {
          const gate = workerData.scheduleTestGate;
          while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1);
          const pause = new Int32Array(new SharedArrayBuffer(4));
          while (Atomics.notify(notifyHandle, 0) === 0) Atomics.wait(pause, 0, 0, 1);
        } else { ${notify} }`);
        options = { ...options, workerData: { ...options.workerData, scheduleTestGate: gate } };
      }
      super(source, options);
      if (bridge) { workers++; this.once('exit', () => { workerExited = true; }); }
    }
  };
  Atomics.wait = function (array, index, value) {
    waits++;
    if (waits === 1) {
      // The worker cannot publish id 0 before this first wait is entered.
      Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
      const deadline = Date.now() + 10000;
      while (Atomics.load(array, index) === value) assert.ok(Date.now() < deadline, 'Bridge never published first reply');
      assert.equal(originalWait(array, index, value, 0), 'not-equal');
      return 'not-equal';
    }
    if (waits === 2) { Atomics.store(gate, 0, 2); Atomics.notify(gate, 0); }
    if (waits === 3) { Atomics.store(gate, 0, 3); Atomics.notify(gate, 0); }
    const result = originalWait(array, index, value, 10000);
    assert.notEqual(result, 'timed-out', 'Bridge never completed its next reply');
    return result;
  };
  syncBuiltinESMExports();
  try {
    const { Miniflare } = scheduleMiniflare(resolve(process.env.SCHEDULE_AUTH_DIRECTORY || '.e2e/deps/auth'));
    mf = new Miniflare({ host: '127.0.0.1', port: 0, modules: true,
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'schedule-bridge-regression' },
      script: 'export default {fetch(){return new Response("control")}}' });
    const db = await mf.getD1Database('DB');
    for (const value of [42, 73]) assert.equal((await db.prepare('SELECT ? AS value').bind(value).first()).value, value);
    assert.equal(workers, 1);
    assert.ok(waits >= 3);
  } catch (error) {
    errors.push(error);
  } finally {
    try { await mf?.dispose(); } catch (error) { errors.push(error); }
    try { threads.Worker = OriginalWorker; Atomics.wait = originalWait; syncBuiltinESMExports(); }
    catch (error) { errors.push(error); }
    if (workers) {
      try { assert.equal(workerExited, true, 'Owned bridge worker must exit'); }
      catch (error) { errors.push(error); }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Bridge regression and cleanup failed');
});
