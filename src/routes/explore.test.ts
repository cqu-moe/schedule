import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth middleware to pass through
vi.mock("../middleware/auth", () => ({
  requireAuth: async (_c: any, next: any) => { await next(); },
  requireAuthWithCquToken: async (_c: any, next: any) => { await next(); },
}));

import exploreApp from "./explore";

const mockEnv = {
  EXPLORE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
} as any;

function get(path: string) {
  return exploreApp.request(path, { method: "GET" }, mockEnv);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.EXPLORE_LIMITER.limit.mockResolvedValue({ success: true });
});

describe("GET /search keyword validation", () => {
  it("rejects empty keyword with 400", async () => {
    const res = await get("/search?source_type=instructor&keyword=");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("keyword");
  });

  it("rejects missing keyword param with 400", async () => {
    const res = await get("/search?source_type=instructor");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("keyword");
  });

  it("rejects whitespace-only keyword with 400", async () => {
    const res = await get("/search?source_type=instructor&keyword=%20%20%20");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("keyword");
  });
});
