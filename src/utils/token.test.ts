import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateUniqueToken } from "./token";

describe("generateUniqueToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a token when no collision", async () => {
    const checker = vi.fn().mockResolvedValue(false);
    const token = await generateUniqueToken(checker);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(checker).toHaveBeenCalledOnce();
  });

  it("retries when collision detected", async () => {
    const checker = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const token = await generateUniqueToken(checker);
    expect(typeof token).toBe("string");
    expect(checker).toHaveBeenCalledTimes(3);
  });

  it("throws after max retries", async () => {
    const checker = vi.fn().mockResolvedValue(true);
    await expect(generateUniqueToken(checker, 3)).rejects.toThrow("Failed to generate unique token");
    expect(checker).toHaveBeenCalledTimes(3);
  });
});
