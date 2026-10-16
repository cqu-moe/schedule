import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSensitiveArtifact } from './auth-artifact-runtime.mjs';

test('OTP collisions in generated report metadata do not hide credentials in application evidence', () => {
  const otp = '123456', token = 'private-token-123456';
  const report = { schemaVersion: 'report-1', run: { id: `abcdefab-1234-5678-1234-abcdef123456`,
    results: [{ id: 'a'.repeat(58) + otp, attempts: [{ durationMs: 123456, steps: [], artifacts: [] }] }] } };
  const scan = (value, file = 'report.json', extra = []) => hasSensitiveArtifact(JSON.stringify(value), file, [otp, token], new Set([otp]), extra);
  assert.ok(JSON.stringify(report).includes(otp), 'The legacy substring check must reproduce the false rejection');
  assert.equal(scan(report), false);
  assert.equal(scan(report, 'runner.log'), true);
  for (const evidence of [`otp=${otp}`, `prefix${otp}suffix`, token]) {
    assert.equal(scan({ ...report, appLog: [{ text: evidence }] }), true);
  }
  assert.equal(scan({ ...report, run: { id: otp } }), true, 'An OTP is not a generated identifier');
  assert.equal(scan({ ...report, run: { summary: { passed: Number(otp) } } }), true, 'Do not hide assertion counts');
  assert.equal(scan(report, 'report.json', [otp]), true, 'Explicit secret registration always takes precedence');
  assert.equal(hasSensitiveArtifact(`not JSON ${otp}`, 'report.json', [otp], new Set([otp])), true);
});
