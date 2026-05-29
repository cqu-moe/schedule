import { describe, it, expect } from "vitest";
import { generatePkce, generateState, sealTx, openTx } from "./oauth-tx";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32))); // 32-byte all-zero base64, test only

describe("PKCE", () => {
  it("challenge is base64url SHA-256 of verifier", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });
});

describe("generateState", () => {
  it("returns a non-empty base64url string", () => {
    const s = generateState();
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("=");
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
  });
});

describe("tx cookie seal/open", () => {
  it("round-trips state+verifier+origin", async () => {
    const sealed = await sealTx(
      { state: "s1", verifier: "v1", origin: "https://schedule.cqu.moe" },
      KEY,
      5_000_000,
    );
    const opened = await openTx(sealed, KEY, 1_000_000); // now < exp
    expect(opened).toEqual({
      state: "s1",
      verifier: "v1",
      origin: "https://schedule.cqu.moe",
    });
  });
  it("returns null when expired", async () => {
    const sealed = await sealTx({ state: "s", verifier: "v", origin: "o" }, KEY, 1_000);
    expect(await openTx(sealed, KEY, 2_000)).toBeNull(); // now=2000 > exp=1000
  });
  it("returns null on tamper / wrong key", async () => {
    const sealed = await sealTx({ state: "s", verifier: "v", origin: "o" }, KEY, 9e15);
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    expect(await openTx(sealed, otherKey, 0)).toBeNull();
  });
  it("returns null on garbage input", async () => {
    expect(await openTx("not-valid-ciphertext", KEY, 0)).toBeNull();
  });
});
