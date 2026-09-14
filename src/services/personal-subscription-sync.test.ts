import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { resetPersonalData, seedPersonal } from "../../tests/fixtures/personal-subscriptions";
import type { Env } from "../types";
import type { CalendarCaps } from "./auth-rpc";
import {
  ManualRefreshCooldownError,
  requestPersonalSync,
} from "./personal-subscription-sync";

const CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: true,
  sub_limit: 0,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetPersonalData(env.DB);
});

describe("requestPersonalSync", () => {
  it("claims one canonical run, sends one message, and returns all view ids", async () => {
    const seeded = await seedPersonal(env.DB, "user-a");
    const send = vi.fn(async () => undefined);
    const testEnv = {
      ...env,
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
      SCHEDULE_SYNC_QUEUE: { send },
    } as unknown as Env;

    const result = await requestPersonalSync(testEnv, "user-a", CAPS, "active");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      subscriptionId: seeded.id,
      userId: "user-a",
      runId: result.run_id,
      trigger: "manual",
    });
    expect(result.affected_subscription_ids.sort()).toEqual(seeded.viewIds.sort());
  });

  it("shares one cooldown and does not send a second message", async () => {
    await seedPersonal(env.DB, "user-a");
    const send = vi.fn(async () => undefined);
    const testEnv = {
      ...env,
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
      SCHEDULE_SYNC_QUEUE: { send },
    } as unknown as Env;

    await requestPersonalSync(testEnv, "user-a", CAPS, "active");
    await expect(requestPersonalSync(testEnv, "user-a", CAPS, "active"))
      .rejects.toBeInstanceOf(ManualRefreshCooldownError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
