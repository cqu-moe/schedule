import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { waitForSubscription } from './lifecycle-fixture.ts';

// Exercise the real observation client against a controlled HTTP peer. This
// protects its completion rule, not the application's Queue retry behavior.
async function withObservationServer(observe, body) {
  const previous = process.env.SCHEDULE_E2E_CONTROL;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(observe(new URL(request.url, 'http://localhost').pathname)));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  process.env.SCHEDULE_E2E_CONTROL = `http://127.0.0.1:${server.address().port}`;
  try { await body(); }
  finally {
    if (previous === undefined) delete process.env.SCHEDULE_E2E_CONTROL;
    else process.env.SCHEDULE_E2E_CONTROL = previous;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const failed = sub => sub.sync_error_code !== null && ['queued', 'error'].includes(sub.sync_status);

test('capacity deferral cannot finish a school-fault observation before the school request', async () => {
  let schoolReads = 0;
  await withObservationServer(path => {
    if (path === '/school') return { events: ++schoolReads < 2 ? [] : [{ kind: 'school_timetable_request_held', at: Date.now() }] };
    assert.equal(path, '/lifecycle');
    return { subscriptions: [{ source_type: 'room', sync_status: schoolReads < 2 ? 'queued' : 'error',
      sync_error_code: schoolReads < 2 ? 'EXTERNAL_RETRYING' : 'EXTERNAL_SYNC_UNAVAILABLE' }] };
  }, async () => {
    const result = await waitForSubscription(failed, 'room', 2000, 'school_timetable_request_held');
    assert.equal(result.sync_error_code, 'EXTERNAL_SYNC_UNAVAILABLE');
    assert.ok(schoolReads >= 2);
  });
});

test('a different school fault cannot satisfy the requested failure phase', async () => {
  await withObservationServer(path => path === '/school'
    ? { events: [{ kind: 'school_timetable_http_503', at: Date.now() }] }
    : { subscriptions: [{ source_type: 'room', sync_status: 'error', sync_error_code: 'EXTERNAL_SYNC_UNAVAILABLE' }] },
  async () => {
    await assert.rejects(waitForSubscription(failed, 'room', 30, 'school_timetable_request_held'), /did not reach its required state/);
  });
});
