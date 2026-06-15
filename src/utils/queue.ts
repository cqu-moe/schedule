const BATCH_SIZE = 100;
const MAX_DELAY_SECONDS = 43200;

export async function spreadEnqueue<TItem, TBody>(
  queue: Queue<TBody>,
  items: TItem[],
  mapFn: (item: TItem) => { body: TBody },
  spreadSeconds: number,
  minInterval: number = 5,
  maxDelaySeconds: number = MAX_DELAY_SECONDS,
): Promise<void> {
  if (items.length === 0) return;

  // The per-message delay cap: a caller-supplied bound (e.g. the cron period),
  // never above the platform max.
  const cap = Math.min(maxDelaySeconds, MAX_DELAY_SECONDS);
  const interval = Math.max(minInterval, Math.floor(spreadSeconds / items.length));

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    await queue.sendBatch(
      chunk.map((item, j) => ({
        ...mapFn(item),
        delaySeconds: Math.min((i + j) * interval, cap),
      })),
    );
  }
}
