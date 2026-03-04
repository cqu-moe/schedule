const BATCH_SIZE = 100;
const MAX_DELAY_SECONDS = 43200;

export async function spreadEnqueue<TItem, TBody>(
  queue: Queue<TBody>,
  items: TItem[],
  mapFn: (item: TItem) => { body: TBody },
  spreadSeconds: number,
  minInterval: number = 5,
): Promise<void> {
  if (items.length === 0) return;

  const interval = Math.max(minInterval, Math.floor(spreadSeconds / items.length));

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    await queue.sendBatch(
      chunk.map((item, j) => ({
        ...mapFn(item),
        delaySeconds: Math.min((i + j) * interval, MAX_DELAY_SECONDS),
      })),
    );
  }
}
