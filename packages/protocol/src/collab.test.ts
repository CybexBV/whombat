import { describe, expect, it } from 'vitest';
import { CollabMessageDecoder, collabDataPayloads, encodeCollabMessages } from './collab.js';

describe('collab framing', () => {
  it('round-trips messages across arbitrary DATA splits', () => {
    const messages = [Uint8Array.of(0, 0, 1), new Uint8Array(200_000).fill(7), Uint8Array.of(1, 2)];
    const encoded = encodeCollabMessages(messages);
    for (const maxData of [1, 3, 4096, 65_536]) {
      const decoder = new CollabMessageDecoder();
      const out = collabDataPayloads(encoded, maxData).flatMap((p) => decoder.push(p));
      expect(out).toEqual(messages);
      expect(decoder.pending).toBe(0);
    }
  });

  it('refuses empty and oversized messages and stays failed', () => {
    const d = new CollabMessageDecoder();
    expect(() => d.push(Uint8Array.of(1, 0, 0, 1))).toThrowError(/collab message of/);
    expect(() => d.push(Uint8Array.of(0))).toThrowError(/failed earlier/);
    expect(() => encodeCollabMessages([new Uint8Array(0)])).toThrowError(/empty/);
    expect(() => collabDataPayloads(new Uint8Array(1), 70_000)).toThrowError(RangeError);
  });
});
