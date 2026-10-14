import { describe, expect, it } from "vitest";
import { externalAvailability } from "./external-availability";

const types = ["admin_class", "instructor", "room", "laboratory", "course"];
const enabled = { EXTERNAL_SUBSCRIPTION_TYPES: types.join(",") };
const closed = { search_types: [], create_types: [] };

describe("external pilot availability", () => {
  it("retains global availability only when the pilot setting is absent", () => {
    expect(externalAvailability(enabled)).toEqual({ search_types: types, create_types: types });
    expect(externalAvailability(enabled, "fixture-outsider")).toEqual({ search_types: types, create_types: types });
  });

  it.each(["", "   ", ", ,", "fixture-pilot", " fixture-pilot, fixture-other , "])("denies unlisted and missing users with pilot setting %j", pilots => {
    const config = { ...enabled, EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS: pilots };
    for (const user of [undefined, "", "fixture-outsider", "fixture-pilot-suffix", "FIXTURE-PILOT"]) {
      expect(externalAvailability(config, user)).toEqual(closed);
    }
  });

  it("trims allowlist entries, matches full IDs and still honors the type gate", () => {
    const config = { EXTERNAL_SUBSCRIPTION_TYPES: "course,room,unknown", EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS: " fixture-pilot,fixture-other,fixture-pilot, " };
    for (const user of ["fixture-pilot", "fixture-other"]) {
      expect(externalAvailability(config, user)).toEqual({ search_types: ["room", "course"], create_types: ["room", "course"] });
    }
  });
});
