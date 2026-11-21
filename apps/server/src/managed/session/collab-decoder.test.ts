import { encodeCollabMessages } from '@whombat/protocol/collab';
import { describe, expect, it } from 'vitest';
import { AWARENESS_MAX_BYTES, BoundedCollabDecoder, CollabBudget } from './collab-decoder';

const header = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

describe('bounded collaboration decoder (review L-7, MR-33)', () => {
  it('reassembles messages across payloads and several in one payload', () => {
    const budget = new CollabBudget();
    const d = new BoundedCollabDecoder(budget);
    const a = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const b = new Uint8Array([0, 9]);
    const bytes = encodeCollabMessages([a, b]);
    expect(d.push(bytes.subarray(0, 3))).toEqual([]);
    expect(d.push(bytes.subarray(3, 7))).toEqual([]);
    expect(d.push(bytes.subarray(7))).toEqual([a, b]);
    expect(budget.used).toBe(0);
  });

  it('a 16 MiB announcement costs nothing until the bytes arrive', () => {
    const budget = new CollabBudget();
    const d = new BoundedCollabDecoder(budget);
    expect(d.push(header(16 * 1024 * 1024))).toEqual([]);
    expect(budget.used).toBe(0);
    d.push(new Uint8Array(1000));
    expect(budget.used).toBe(1000);
    expect(d.held).toBe(1000);
  });

  it('what incomplete messages hold is bounded per session, across streams, and given back on failure', () => {
    const budget = new CollabBudget(10_000);
    const one = new BoundedCollabDecoder(budget);
    const two = new BoundedCollabDecoder(budget);
    one.push(header(1_000_000));
    two.push(header(1_000_000));
    one.push(new Uint8Array(6_000).fill(0));
    expect(() => two.push(new Uint8Array(6_000).fill(0))).toThrow(/budget/);
    expect(budget.used).toBe(6_000);
    one.fail();
    expect(budget.used).toBe(0);
    expect(() => one.push(new Uint8Array(1))).toThrow(/failed earlier/);
  });

  it('refuses a large awareness message, an empty one and one over the protocol maximum', () => {
    const d = new BoundedCollabDecoder(new CollabBudget());
    expect(() => d.push(new Uint8Array([...header(AWARENESS_MAX_BYTES + 1), 1]))).toThrow(/awareness/);
    expect(() => new BoundedCollabDecoder(new CollabBudget()).push(header(0))).toThrow(/empty/);
    expect(() => new BoundedCollabDecoder(new CollabBudget()).push(header(16 * 1024 * 1024 + 1))).toThrow(
      /bytes/,
    );
  });
});
