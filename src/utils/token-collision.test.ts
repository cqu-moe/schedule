import { describe, it, expect, vi } from "vitest";
import { tokenExists } from "./token-collision";

describe("tokenExists", () => {
  it("returns false when token not found anywhere", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const db = { select: mockSelect } as any;
    const result = await tokenExists(db, "unique-token");
    expect(result).toBe(false);
    // Called twice: once for users, once for subscriptions
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("returns true when token found in users table (short-circuits)", async () => {
    let callCount = 0;
    const mockSelect = vi.fn().mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              callCount === 1 ? [{ id: "u1" }] : [],
            ),
          }),
        }),
      };
    });
    const db = { select: mockSelect } as any;
    const result = await tokenExists(db, "existing-token");
    expect(result).toBe(true);
    // Should short-circuit — only 1 call
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("returns true when token found in subscriptions table", async () => {
    let callCount = 0;
    const mockSelect = vi.fn().mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              callCount === 2 ? [{ id: "s1" }] : [],
            ),
          }),
        }),
      };
    });
    const db = { select: mockSelect } as any;
    const result = await tokenExists(db, "sub-token");
    expect(result).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});
