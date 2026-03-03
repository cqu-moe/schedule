import { describe, it, expect } from "vitest";
import { encrypt, decrypt, verifyPassword } from "./crypto";

// Generate a test key: 32 bytes = 256 bits, base64 encoded
const TEST_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

describe("crypto", () => {
  it("should encrypt and decrypt roundtrip", async () => {
    const plaintext = "test-password-123";
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce different ciphertexts for same plaintext (random IV)", async () => {
    const plaintext = "same-password";
    const encrypted1 = await encrypt(plaintext, TEST_KEY);
    const encrypted2 = await encrypt(plaintext, TEST_KEY);
    expect(encrypted1).not.toBe(encrypted2);

    // Both should decrypt to the same value
    expect(await decrypt(encrypted1, TEST_KEY)).toBe(plaintext);
    expect(await decrypt(encrypted2, TEST_KEY)).toBe(plaintext);
  });

  it("should handle empty string", async () => {
    const encrypted = await encrypt("", TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });

  it("should handle unicode", async () => {
    const plaintext = "密码测试 🔑";
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("verifyPassword should return true for correct password", async () => {
    const password = "correct-password";
    const encrypted = await encrypt(password, TEST_KEY);
    expect(await verifyPassword(password, encrypted, TEST_KEY)).toBe(true);
  });

  it("verifyPassword should return false for wrong password", async () => {
    const encrypted = await encrypt("correct-password", TEST_KEY);
    expect(await verifyPassword("wrong-password", encrypted, TEST_KEY)).toBe(
      false,
    );
  });

  it("verifyPassword should return false for invalid encrypted data", async () => {
    expect(await verifyPassword("password", "invalid-data", TEST_KEY)).toBe(
      false,
    );
  });

  it("should fail to decrypt with wrong key", async () => {
    const wrongKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    const encrypted = await encrypt("test", TEST_KEY);
    await expect(decrypt(encrypted, wrongKey)).rejects.toThrow();
  });

});
