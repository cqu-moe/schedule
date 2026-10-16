import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { installNetworkGuard, login } from './browser-fixture';
import { age, control, cron, expire, external, payload, personal, publicRead, request, school, waitForSubscription, withSchoolInput } from './lifecycle-fixture';

installNetworkGuard();

for (const kind of ['personal', 'external'] as const) {
  const type = kind === 'personal' ? 'personal' : 'room';
  const tags = ['account:owner', `lifecycle:${kind}`, ...(kind === 'external' ? ['external'] : [])];
  test(`lifecycle ${kind} manual quota: real UI refresh spends only its independent allowance and cooldown cannot fake success`,
    { tags, timeout: 240000 }, async fixture => {
      const { app, browser, screen } = fixture;
      await login(fixture);
      const initial = kind === 'personal' ? await personal(fixture) : await external(fixture);
      const path = `/api/v2/subscriptions/${initial.view.id}/syncs`;
      let previous = initial.stored;
      for (let accepted = 1; accepted <= 2; accepted++) {
        if (accepted === 2) await age(previous.id, 'manual_refresh_at', 6);
        await school({ mode: accepted === 1 ? 'schedule_v2' : 'success', clearEvents: true });
        if (kind === 'personal') await expire('harvest');
        await app.open('/dashboard');
        const card = screen.getByRole('listitem').filter({ hasText: initial.view.source_name });
        await card.getByRole('button', '同步', { exact: true }).click();
        const synced = await waitForSubscription(sub => sub.sync_status === 'success' && sub.sync_run_id !== previous.sync_run_id, type);
        expect(synced.sync_trigger).toBe('manual');
        const snapshot = await control();
        expect(kind === 'personal' ? snapshot.personalManualUsed : snapshot.externalUsage[0].used_count).toBe(accepted);
        expect(kind === 'personal' ? snapshot.externalUsage.length : snapshot.personalManualUsed).toBe(0);
        const current = await publicRead(initial.token);
        expect(current.status).toBe(200);
        expect(current.text).toContain(accepted === 1 ? (kind === 'personal' ? '合成电路新版' : '外部电路新版') : (kind === 'personal' ? '合成电路基础' : '外部电路基础'));
        if (accepted === 1) {
          const cooldown = await request(browser, path, 'POST');
          expect(cooldown.status).toBe(429);
          expect(cooldown.body.detail.error.code).toBe('MANUAL_REFRESH_COOLDOWN');
          expect((await control()).subscriptions).toEqual(snapshot.subscriptions);
          expect(kind === 'personal' ? (await control()).personalManualUsed : (await control()).externalUsage[0].used_count).toBe(1);
        }
        previous = synced;
      }
      await age(previous.id, 'manual_refresh_at', 6);
      const before = await control();
      const denied = await request(browser, path, 'POST');
      expect(denied.status).toBe(429);
      expect(denied.body.detail.error.code).toBe('RATE_LIMITED');
      expect(denied.body.detail.error.message).toContain(kind === 'personal' ? '今日手动刷新次数已达上限' : '今日外部手动刷新次数已达上限');
      expect(await control()).toEqual(before);
      await browser.reload();
      const current = await publicRead(initial.token);
      expect(current.status).toBe(200);
      expect(current.text).toContain(kind === 'personal' ? '合成电路基础' : '外部电路基础');
    });

  test(`lifecycle ${kind} automatic interval: actual cron queues due work after device logout and leaves fresh work alone`,
    { tags, timeout: 240000 }, async fixture => {
      const { app, browser, screen } = fixture;
      await login(fixture);
      const initial = kind === 'personal' ? await personal(fixture) : await external(fixture);
      await school({ mode: 'schedule_v2', clearEvents: true });
      await age(initial.stored.id, 'last_synced_at', 20);
      if (kind === 'personal') await expire('harvest');
      const before = await control();
      await cron();
      expect((await control()).subscriptions).toEqual(before.subscriptions);
      expect((await school()).events.filter(event => event.kind === (kind === 'personal' ? 'personal_timetable_requested' : 'external_table_room'))).toEqual([]);
      await screen.getByRole('button', '账户菜单', { exact: true }).click();
      await screen.getByRole('menuitem', '退出课表', { exact: true }).click();
      await expect(browser).toHaveURL(/signed-out/);
      expect((await request(browser, '/api/v2/subscriptions')).status).toBe(401);
      await age(initial.stored.id, 'last_synced_at', 61);
      await expire('caps'); // Exercise real offline Auth getCaps, not the login cache.
      await cron();
      const synced = await waitForSubscription(sub => sub.sync_status === 'success' && sub.sync_run_id !== initial.stored.sync_run_id, type);
      expect(synced.sync_trigger).toBe('cron');
      const snapshot = await control();
      expect(snapshot.personalManualUsed).toBe(0);
      expect(snapshot.externalUsage).toEqual([]);
      expect((await school()).events.some(event => event.kind === (kind === 'personal' ? 'personal_timetable_requested' : 'external_table_room'))).toBe(true);
      const updated = await publicRead(initial.token);
      expect(updated.status).toBe(200);
      expect(updated.text).toContain(kind === 'personal' ? '合成电路新版' : '外部电路新版');
      await cron();
      expect((await control()).subscriptions).toEqual(snapshot.subscriptions);
      expect((await request(browser, '/api/v2/subscriptions')).status).toBe(401);
      await app.open('/api/v2/auth/login?returnTo=%2Fdashboard');
      await expect(browser).toHaveURL(/dashboard/);
      await expect(screen.getByRole('link', `查看课表：${initial.view.source_name}`, { exact: true })).toBeVisible();
      await browser.goto(`${process.env.SCHEDULE_AUTH_URL}/settings`);
      await screen.getByRole('button', '退出登录', { exact: true }).click();
      await app.open('/api/v2/config');
      expect((await request(browser, '/api/v2/subscriptions')).status).toBe(401);
    });

  test(`lifecycle ${kind} failures: preserve successful calendars for school 503, 504 and schema errors; accept empty and recover`,
    { tags, timeout: 600000 }, async fixture => {
      const { app, browser, screen } = fixture;
      await login(fixture);
      const initial = kind === 'personal' ? await personal(fixture) : await external(fixture);
      let previous = initial.stored;
      let previousPublic = (await publicRead(initial.token)).text;
      // These are background lifecycle transitions. Leave the polling dashboard
      // while waiting; each failed state and final recovery still reopen it.
      await app.open('/api/v2/config');
      const failureModes = ['schedule_failure', 'schedule_timeout', 'schedule_schema_error', ...(kind === 'external' ? ['schedule_stall'] : [])];
      for (const [index, mode] of failureModes.entries()) {
        const recoveryMode = index % 2 === 1 ? 'success' : 'schedule_v2';
        const expectedEvent = index === 0 ? 'school_timetable_http_503' : index === 1 ? 'school_timetable_http_504' : index === 2 ? 'school_timetable_invalid_schema' : 'school_timetable_request_held';
        const failed = await withSchoolInput({ mode, hold: mode === 'schedule_stall', clearEvents: true },
          { mode: recoveryMode, hold: false }, async () => {
            if (kind === 'personal') await expire('harvest');
            await age(previous.id, 'last_synced_at', 61);
            const before = (await control()).subscriptions.find(sub => sub.id === previous.id)!;
            await cron();
            const started = Date.now();
            const failed = await waitForSubscription(sub => sub.sync_run_id !== previous.sync_run_id && sub.sync_error_code !== null && ['queued', 'error'].includes(sub.sync_status), type, 240000, expectedEvent);
            expect(failed.last_synced_at).toBe(before.last_synced_at);
            expect(payload(failed)).toEqual(payload(previous));
            const retained = await publicRead(initial.token);
            expect(retained.status).toBe(200);
            expect(retained.text).toBe(previousPublic);
            if (mode === 'schedule_stall') expect(Date.now() - started >= 15000).toBe(true);
            const schoolEvent = (await school()).events.find(event => event.kind === expectedEvent);
            expect(Boolean(schoolEvent)).toBe(true);
            // Capacity waiting must not count toward the held-request timeout.
            if (mode === 'schedule_stall') expect(Date.now() - schoolEvent!.at >= 15000).toBe(true);
            await app.open('/dashboard');
            await expect(screen.getByRole('listitem').filter({ hasText: initial.view.source_name })).toContainText(failed.sync_status === 'queued' ? '重试' : '失败');
            await app.open('/api/v2/config');
            return failed;
          });
        if (failed.sync_status === 'error') {
          await age(failed.id, 'sync_requested_at', 61);
          await cron();
        }
        previous = await waitForSubscription(sub => sub.sync_status === 'success' && (failed.sync_status === 'queued' ? sub.sync_run_id === failed.sync_run_id : sub.sync_run_id !== failed.sync_run_id), type, 120000);
        const recovered = await publicRead(initial.token);
        expect(recovered.status).toBe(200);
        previousPublic = recovered.text;
        expect(recovered.text).toContain(index % 2 === 1 ? (kind === 'personal' ? '合成电路基础' : '外部电路基础') : (kind === 'personal' ? '合成电路新版' : '外部电路新版'));
      }
      await school({ mode: 'schedule_empty', clearEvents: true });
      if (kind === 'personal') await expire('harvest');
      await age(previous.id, 'last_synced_at', 61);
      await cron();
      const empty = await waitForSubscription(sub => sub.sync_status === 'success' && sub.sync_run_id !== previous.sync_run_id, type);
      expect(JSON.parse(empty.courses_json!)).toEqual([]);
      if (kind === 'personal') expect(JSON.parse(empty.exams_json!)).toEqual([]);
      else expect(empty.exams_json).toBe(null);
      const emptyCalendar = await publicRead(initial.token);
      expect(emptyCalendar.status).toBe(200);
      expect(emptyCalendar.text).toContain('BEGIN:VCALENDAR');
      expect(emptyCalendar.text).not.toContain('BEGIN:VEVENT');
      if (kind === 'external') expect(empty.import_quality).toBe('empty');
      await school({ mode: 'schedule_v2' });
      if (kind === 'personal') await expire('harvest');
      await age(empty.id, 'last_synced_at', 61);
      await cron();
      await waitForSubscription(sub => sub.sync_status === 'success' && sub.sync_run_id !== empty.sync_run_id, type);
      await app.open('/dashboard');
      await expect(screen.getByRole('link', `查看课表：${initial.view.source_name}`, { exact: true })).toBeVisible();
      expect((await publicRead(initial.token)).text).toContain(kind === 'personal' ? '合成电路新版' : '外部电路新版');
      const snapshot = await control();
      expect(snapshot.personalManualUsed).toBe(0);
      expect(snapshot.externalUsage).toEqual([]);
    });
}
