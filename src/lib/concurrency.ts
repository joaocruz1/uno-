/**
 * Runs `task` for every item with at most `limit` in flight and resolves with
 * the results in input order. The first rejection rejects the whole call; tasks
 * already running are not cancelled.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await task(items[index], index);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
  return results;
}
