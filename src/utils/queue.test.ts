import { describe, it, expect, vi } from "vitest";
import { spreadEnqueue } from "./queue";

function createMockQueue() {
  return { sendBatch: vi.fn().mockResolvedValue(undefined) } as any;
}

describe("spreadEnqueue", () => {
  it("does nothing for empty items", async () => {
    const queue = createMockQueue();
    await spreadEnqueue(queue, [], (item) => ({ body: item }), 3600);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it("sends a single batch for <=100 items", async () => {
    const queue = createMockQueue();
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `u${i}` }));
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3600);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(queue.sendBatch.mock.calls[0][0]).toHaveLength(3);
  });

  it("splits into multiple batches for >100 items", async () => {
    const queue = createMockQueue();
    const items = Array.from({ length: 150 }, (_, i) => i);
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3600);
    expect(queue.sendBatch).toHaveBeenCalledTimes(2);
    expect(queue.sendBatch.mock.calls[0][0]).toHaveLength(100);
    expect(queue.sendBatch.mock.calls[1][0]).toHaveLength(50);
  });

  it("applies correct delay spreading", async () => {
    const queue = createMockQueue();
    const items = [0, 1, 2];
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3600);
    const messages = queue.sendBatch.mock.calls[0][0];
    expect(messages[0].delaySeconds).toBe(0);
    expect(messages[1].delaySeconds).toBe(1200);
    expect(messages[2].delaySeconds).toBe(2400);
  });

  it("clamps delay to 43200 seconds", async () => {
    const queue = createMockQueue();
    const items = [0, 1];
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 1, 50000);
    const messages = queue.sendBatch.mock.calls[0][0];
    expect(messages[1].delaySeconds).toBe(43200);
  });

  it("clamps delay to a custom maxDelaySeconds (e.g. 1h)", async () => {
    const queue = createMockQueue();
    const items = [0, 1, 2];
    // interval = max(2000, floor(6000/3)=2000) = 2000 → raw delays 0/2000/4000;
    // the 3600s cap must clamp the third message.
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 6000, 2000, 3600);
    const messages = queue.sendBatch.mock.calls[0][0];
    expect(messages[0].delaySeconds).toBe(0);
    expect(messages[1].delaySeconds).toBe(2000);
    expect(messages[2].delaySeconds).toBe(3600);
  });

  it("respects custom minInterval", async () => {
    const queue = createMockQueue();
    const items = [0, 1, 2];
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3, 10);
    const messages = queue.sendBatch.mock.calls[0][0];
    expect(messages[1].delaySeconds).toBe(10);
    expect(messages[2].delaySeconds).toBe(20);
  });
});
