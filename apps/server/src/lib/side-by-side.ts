/**
 * Work over a list, a few items at once (page-speed.md PS-04): the health pass looks at several connections side by
 * side, so one slow service doesn't hold up the others.
 */

/** Runs `work` for every item in their order, at most `limit` at once; resolves when all are done. */
export async function sideBySide<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker));
}

/**
 * A gate that lets at most `limit` pieces of work run at once; the rest start, in order, as others end. Work that waits
 * on other gated work must not hold a place while it waits, or the gate can stop.
 */
export function atMost(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}
