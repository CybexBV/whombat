import { describe, expect, it } from 'vitest';
import { BackgroundWork } from './background';

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('BackgroundWork (server-efficiency.md SV-02)', () => {
  it('runs work without the caller waiting, and settle waits for it and for work it started', async () => {
    const warned: string[] = [];
    const work = new BackgroundWork(() => ({ warn: (_o, msg) => warned.push(msg ?? '') }));
    const g = gate();
    const done: string[] = [];
    work.run('first', async () => {
      await g.opened;
      done.push('first');
      work.run('second', async () => {
        done.push('second');
      });
    });
    expect(done).toEqual([]);
    expect(work.size).toBe(1);
    const settled = work.settle();
    g.open();
    await settled;
    expect(done).toEqual(['first', 'second']);
    expect(work.size).toBe(0);
    expect(warned).toEqual([]);
  });

  it('runs one key’s work in the order it came, each after the one before, and a failure stops nothing', async () => {
    const warned: string[] = [];
    const work = new BackgroundWork(() => ({ warn: (_o, msg) => warned.push(msg ?? '') }));
    const g = gate();
    const order: string[] = [];
    work.serial('room', 'a', async () => {
      await g.opened;
      order.push('a');
    });
    work.serial('room', 'b', async () => {
      order.push('b');
      throw new Error('boom');
    });
    work.serial('room', 'c', async () => {
      order.push('c');
    });
    // Another key doesn't wait for this one.
    work.serial('other', 'x', async () => {
      order.push('x');
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['x']);
    g.open();
    await work.settle();
    expect(order).toEqual(['x', 'a', 'b', 'c']);
    expect(warned).toEqual(['background: b failed']);
    // The chain is gone once it ran: new work for the key starts at once.
    work.serial('room', 'd', async () => {
      order.push('d');
    });
    await work.settle();
    expect(order.at(-1)).toBe('d');
  });
});
