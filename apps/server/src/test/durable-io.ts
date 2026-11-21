import type { TestContext } from 'vitest';

/** Keep a timed-out test's uncancellable fsync visible and give it bounded cleanup time. */
export function durableIO(context: TestContext, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const pending = task(context.signal);
  context.onTestFinished(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.catch(() => {}), // The test itself retains its original failure.
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Durable test I/O did not drain within 5 seconds')),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  return pending;
}
