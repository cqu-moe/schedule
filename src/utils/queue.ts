const BATCH_SIZE = 100;
const MAX_DELAY_SECONDS = 43200;

/**
 * Thrown when a `sendBatch` fails partway through. Carries `enqueued` — the count
 * already queued by earlier successful batches — so callers can report partial
 * progress instead of "0", which would otherwise prompt a duplicating retry.
 */
export class SpreadEnqueueError extends Error {
  constructor(message: string, readonly enqueued: number) {
    super(message);
    this.name = "SpreadEnqueueError";
  }
}

/** Enqueue items spread over a window. Returns the number successfully enqueued. */
export async function spreadEnqueue<TItem, TBody>(
  queue: Queue<TBody>,
  items: TItem[],
  mapFn: (item: TItem) => { body: TBody },
  spreadSeconds: number,
  minInterval: number = 5,
  maxDelaySeconds: number = MAX_DELAY_SECONDS,
): Promise<number> {
  if (items.length === 0) return 0;

  // The per-message delay cap: a caller-supplied bound (e.g. the cron period),
  // never above the platform max.
  const cap = Math.min(maxDelaySeconds, MAX_DELAY_SECONDS);
  const interval = Math.max(minInterval, Math.floor(spreadSeconds / items.length));

  let enqueued = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    try {
      await queue.sendBatch(
        chunk.map((item, j) => ({
          ...mapFn(item),
          delaySeconds: Math.min((i + j) * interval, cap),
        })),
      );
    } catch (e) {
      throw new SpreadEnqueueError(e instanceof Error ? e.message : String(e), enqueued);
    }
    enqueued += chunk.length;
  }
  return enqueued;
}
