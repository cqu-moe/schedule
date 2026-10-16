import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, stat, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function browserCustody(privateParent, browser) {
  assert.ok(['firefox', 'webkit'].includes(browser));
  // Never put a profile or browser HOME in a group that can be published.
  const temporaryRoot = await mkdtemp(join(privateParent, 'private-browser-'));
  const home = join(temporaryRoot, 'home');
  try { await mkdir(home); }
  catch (primary) {
    try { await rmdir(temporaryRoot); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Browser custody startup and cleanup failed'); }
    throw primary;
  }
  const profiles = new Set();
  const errors = [];
  let reading = Promise.resolve();
  const sample = () => {
    reading = reading.then(async () => {
      for (const name of await readdir(temporaryRoot)) {
        if (name.startsWith(`playwright_${browser}dev_profile-`)) profiles.add(name);
      }
    }).catch(error => errors.push(error.message));
  };
  const timer = setInterval(sample, 50);
  sample();
  return {
    env: { HOME: home, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot, DEBUG: 'pw:browser' },
    async finish(log) {
      clearInterval(timer);
      await reading;
      const receipt = { browser, headless: /(?:--headless|-headless)(?:\s|$)/.test(log),
        engineBinary: log.includes(`/${browser}-`), observedProfiles: [...profiles],
        browserExited: /process did exit: exitCode=0, signal=null/.test(log),
        profileRemoved: false, privateHomeRemoved: false, errors };
      try {
        assert.ok(profiles.size > 0, 'No actual temporary browser profile was observed');
        for (const name of profiles) {
          await stat(join(temporaryRoot, name)).then(() => { throw new Error('Browser profile remains after child exit'); }, error => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        receipt.profileRemoved = true;
        assert.ok(receipt.browserExited, 'No clean browser process exit was observed');
        await rm(temporaryRoot, { recursive: true });
        receipt.privateHomeRemoved = true;
      } catch (error) {
        errors.push(error.message);
        // A pre-engine module/config rejection can leave only our empty HOME.
        // rmdir refuses anything nonempty; never remove an unobserved profile.
        try {
          await rmdir(home);
          await rmdir(temporaryRoot);
          receipt.privateHomeRemoved = true;
        } catch (cleanup) { errors.push(cleanup.message); }
      }
      return receipt;
    },
  };
}
