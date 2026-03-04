import { describe, it, expect } from "vitest";
import { bufferToBase64 } from "./encoding";

describe("bufferToBase64", () => {
  it("encodes an ArrayBuffer to base64", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(bufferToBase64(bytes.buffer)).toBe(btoa("Hello"));
  });

  it("returns empty string for empty buffer", () => {
    expect(bufferToBase64(new ArrayBuffer(0))).toBe("");
  });
});
