import type { Env } from "../types";

export type PersonalSubscriptionMode = "legacy" | "migration" | "enabled";

export function personalSubscriptionMode(
  env: Pick<Env, "PERSONAL_SUBSCRIPTION_MODE">,
): PersonalSubscriptionMode {
  const mode = env.PERSONAL_SUBSCRIPTION_MODE ?? "legacy";
  if (mode !== "legacy" && mode !== "migration" && mode !== "enabled") {
    throw new Error(`Invalid PERSONAL_SUBSCRIPTION_MODE: ${String(mode)}`);
  }
  return mode;
}
