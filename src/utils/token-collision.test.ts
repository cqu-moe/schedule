import { describe, it, expect, vi } from "vitest";
import { tokenExists } from "./token-collision";

function mockDb(results: { user: unknown[]; pending: unknown[]; sub: unknown[] }) {
  let callCount = 0;
  const mockSelect = vi.fn().mockImplementation(() => {
    callCount++;
    const data = callCount === 1 ? results.user : callCount === 2 ? results.pending : results.sub;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(data),
        }),
      }),
    };
  });
  return { select: mockSelect } as any;
}

describe("tokenExists", () => {
  it("returns false when token not found anywhere", async () => {
    const db = mockDb({ user: [], pending: [], sub: [] });
    const result = await tokenExists(db, "unique-token");
    expect(result).toBe(false);
    // All 3 queries run in parallel
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("returns true when token found in users.calendarToken", async () => {
    const db = mockDb({ user: [{ id: "u1" }], pending: [], sub: [] });
    const result = await tokenExists(db, "existing-token");
    expect(result).toBe(true);
  });

  it("returns true when token found in users.pendingCalendarToken", async () => {
    const db = mockDb({ user: [], pending: [{ id: "u2" }], sub: [] });
    const result = await tokenExists(db, "pending-token");
    expect(result).toBe(true);
  });

  it("returns true when token found in subscriptions.calendarToken", async () => {
    const db = mockDb({ user: [], pending: [], sub: [{ id: "s1" }] });
    const result = await tokenExists(db, "sub-token");
    expect(result).toBe(true);
  });

  it("returns true when token is in the inMemoryTokens set (skips DB)", async () => {
    const db = mockDb({ user: [], pending: [], sub: [] });
    const inMemory = new Set(["in-memory-token"]);
    const result = await tokenExists(db, "in-memory-token", inMemory);
    expect(result).toBe(true);
    // Should not hit DB at all
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns false when token is not in inMemoryTokens and not in DB", async () => {
    const db = mockDb({ user: [], pending: [], sub: [] });
    const inMemory = new Set(["other-token"]);
    const result = await tokenExists(db, "unique-token", inMemory);
    expect(result).toBe(false);
    expect(db.select).toHaveBeenCalledTimes(3);
  });
});
