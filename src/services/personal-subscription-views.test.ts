import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { seedPersonal } from "../../tests/fixtures/personal-subscriptions";
import { listPersonalViews, resolveOwnedSubscription } from "./personal-subscription-views";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("personal subscription views", () => {
  it("lists the fixed views and resolves ownership through a legacy view id", async () => {
    const seeded = await seedPersonal(env.DB, "owner");
    const views = await listPersonalViews(env.DB, seeded.id);
    expect(views.map((view) => view.sourceType).sort()).toEqual([
      "personal_all",
      "personal_courses",
      "personal_exams",
    ]);

    const resolved = await resolveOwnedSubscription(env.DB, "owner", seeded.viewIds[0]);
    expect(resolved?.subscription.id).toBe(seeded.id);
    expect(resolved?.view?.id).toBe(seeded.viewIds[0]);
    expect(await resolveOwnedSubscription(env.DB, "other", seeded.viewIds[0])).toBeNull();
  });
});
