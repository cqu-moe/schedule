import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only runner-generated identifiers, digests and durations are non-credential
// metadata. Application text and every non-OTP secret retain literal matching.
export function hasSensitiveArtifact(text, file, sensitive, otps, literal = []) {
  if ([...literal, ...sensitive.filter(value => !otps.has(value))].some(value => text.includes(value))) return true;
  let searchable = text;
  if (basename(file) === 'report.json') {
    let report;
    try { report = JSON.parse(text); } catch { /* Malformed reports receive the full literal scan. */ }
    if (report?.schemaVersion === 'report-1' && report.run) {
      const identifier = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?::\d+)?)$/;
      const metadata = value => {
        if (!value || typeof value !== 'object') return;
        for (const key of ['id', 'sha256', 'configDigest', 'commit']) {
          if (typeof value[key] === 'string' && identifier.test(value[key])) value[key] = '[generated metadata]';
        }
        if (Number.isSafeInteger(value.durationMs) && value.durationMs >= 0) value.durationMs = '[generated duration]';
      };
      metadata(report.run); metadata(report.run.project); metadata(report.run.vcs);
      for (const result of report.run.results ?? []) {
        metadata(result);
        for (const attempt of result.attempts ?? []) {
          metadata(attempt);
          for (const artifact of attempt.artifacts ?? []) metadata(artifact);
          for (const step of attempt.steps ?? []) {
            metadata(step);
            for (const artifact of step.artifacts ?? []) metadata(artifact);
            for (const event of step.events ?? []) metadata(event);
          }
        }
      }
      searchable = JSON.stringify(report);
    }
  }
  return [...otps].some(value => searchable.includes(value));
}

export async function importSchoolAuth(authDirectory) {
  const target = pathToFileURL(join(authDirectory, 'e2e/runtime.mjs')).href;
  const hook = registerHooks({ load(url, context, next) {
    const result = next(url, context);
    if (url !== target) return result;
    let source = Buffer.from(result.source).toString();
    assert.equal(createHash('sha256').update(source).digest('hex'), 'cb7ef3e89ed0a061bfe719f2780e5496e20aa19e1e9d380994378b45a4830b8a', 'Pinned Auth scanner changed');
    const marker = 'sensitive.some(value => text.includes(value))';
    assert.equal(source.split(marker).length, 2);
    source = `import {hasSensitiveArtifact} from ${JSON.stringify(import.meta.url)};\n` + source.replace(marker,
      'hasSensitiveArtifact(text, path, sensitive, new Set([...mails.values()].map(mail => mail.otp).filter(Boolean)), artifactSecrets)');
    return { ...result, source };
  } });
  try { return await import(pathToFileURL(join(authDirectory, 'e2e/school/runtime.mjs')).href); }
  finally { hook.deregister(); }
}
