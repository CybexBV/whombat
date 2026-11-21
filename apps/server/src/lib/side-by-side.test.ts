/** Work over a list, a few items at once (page-speed.md PS-04). */
import { describe, expect, it } from 'vitest';
import { atMost, sideBySide } from './side-by-side';

describe('sideBySide', () => {
  it('runs every item, at most the limit at once, and a slow one doesn’t hold up the rest', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done: string[] = [];
    let running = 0;
    let most = 0;
    const all = sideBySide(['slow', 'a', 'b', 'c', 'd'], 2, async (item) => {
      running++;
      most = Math.max(most, running);
      if (item === 'slow') await slow;
      else await Promise.resolve();
      running--;
      done.push(item);
    });
    // Everything else finishes while the slow one still waits.
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toEqual(['a', 'b', 'c', 'd']);
    release();
    await all;
    expect(done).toEqual(['a', 'b', 'c', 'd', 'slow']);
    expect(most).toBe(2);
  });

  it('does nothing for no items', async () => {
    let calls = 0;
    await sideBySide([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});

describe('atMost', () => {
  it('runs at most the limit at once, starts the rest in order, and passes answers and errors through', async () => {
    const gate = atMost(2);
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const job = (n: number) =>
      gate(async () => {
        started.push(n);
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setImmediate(resolve));
        running--;
        if (n === 3) throw new Error('three');
        return n * 10;
      });
    const all = await Promise.allSettled([1, 2, 3, 4, 5].map(job));
    expect(most).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(all.map((r) => (r.status === 'fulfilled' ? r.value : 'failed'))).toEqual([
      10,
      20,
      'failed',
      40,
      50,
    ]);
    // A failure frees its place: the gate still runs work.
    expect(await gate(async () => 'after')).toBe('after');
  });
});
