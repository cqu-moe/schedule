import { describe, it, expect } from "vitest";
import { resolveOwnStudentId } from "./cqu-bearer";

/** Build a fake CQU bearer JWT carrying the given `user_name` (学号) claim. */
function fakeBearer(userName: string): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url({ user_name: userName })}.sig`;
}

describe("resolveOwnStudentId (retained after bearer retirement)", () => {
  it("decodes the 学号 from a bearer JWT", () => {
    expect(resolveOwnStudentId(fakeBearer("20210001"), "u")).toBe("20210001");
  });

  it("returns null (no throw) when the bearer carries no student ID", () => {
    expect(resolveOwnStudentId("opaque-token", "u")).toBeNull();
  });
});
