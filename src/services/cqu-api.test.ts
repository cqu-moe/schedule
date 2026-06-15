import { describe, it, expect } from "vitest";
import {
  CQUAPIClient,
  CQUAPIError,
  decodeStudentIdFromBearer,
} from "./cqu-api";

/** Build a fake JWT (header.payload.signature) with the given payload object. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("decodeStudentIdFromBearer", () => {
  it("extracts user_name (学号) from a valid CQU bearer JWT", () => {
    const bearer = fakeJwt({ user_name: "20210001", client_id: "personal-prod" });
    expect(decodeStudentIdFromBearer(bearer)).toBe("20210001");
  });

  it("handles base64url payloads (with - and _)", () => {
    // Construct a payload whose base64 contains + or / before url-encoding.
    const bearer = fakeJwt({ user_name: "20259999", scope: ["all"], note: "??>>>" });
    expect(decodeStudentIdFromBearer(bearer)).toBe("20259999");
  });

  it("returns null for a non-JWT string", () => {
    expect(decodeStudentIdFromBearer("not-a-jwt")).toBeNull();
  });

  it("returns null when user_name claim is missing", () => {
    const bearer = fakeJwt({ client_id: "personal-prod" });
    expect(decodeStudentIdFromBearer(bearer)).toBeNull();
  });

  it("returns null when user_name is empty", () => {
    const bearer = fakeJwt({ user_name: "" });
    expect(decodeStudentIdFromBearer(bearer)).toBeNull();
  });

  it("returns null for a malformed payload segment", () => {
    expect(decodeStudentIdFromBearer("aaa.@@@notbase64@@@.ccc")).toBeNull();
  });
});

describe("CQUAPIClient.getOwnStudentId", () => {
  it("returns the bearer subject's student ID", () => {
    const api = new CQUAPIClient(fakeJwt({ user_name: "20210042" }));
    expect(api.getOwnStudentId()).toBe("20210042");
  });

  it("throws CQUAPIError(401) when the bearer has no student ID", () => {
    const api = new CQUAPIClient("opaque-token-without-claims");
    expect(() => api.getOwnStudentId()).toThrow(CQUAPIError);
    try {
      api.getOwnStudentId();
    } catch (e) {
      expect((e as CQUAPIError).statusCode).toBe(401);
    }
  });
});
