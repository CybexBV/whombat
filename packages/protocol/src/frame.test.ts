import { describe, expect, it } from 'vitest';
import { utf8Encode } from './bytes.js';
import { decodeFrameBody, encodeFrame, type Frame, FrameDecoder, FrameError } from './frame.js';
import { SESSION_MAX_CONTROL_BYTES, SESSION_MAX_DATA_BYTES } from './limits.js';

const frames: Frame[] = [
  { type: 'control', streamId: 0, payload: utf8Encode('{"t":"ping","n":1}') },
  { type: 'data', streamId: 3, payload: new Uint8Array([1, 2, 3]) },
  { type: 'credit', streamId: 3, credit: 65_536 },
  { type: 'end', streamId: 3 },
  { type: 'reset', streamId: 0xffff_ffff, code: 5 },
];

describe('frame codec', () => {
  it('decodes frames split and joined arbitrarily', () => {
    const all = frames.map(encodeFrame);
    const stream = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of all) {
      stream.set(b, o);
      o += b.length;
    }
    for (const step of [1, 2, 7, 1000]) {
      const decoder = new FrameDecoder();
      const out: Frame[] = [];
      for (let i = 0; i < stream.length; i += step) out.push(...decoder.push(stream.subarray(i, i + step)));
      expect(out).toEqual(frames);
      expect(decoder.pending).toBe(0);
    }
  });

  it('rejects frames that break the rules', () => {
    const bad: [Frame, string][] = [
      [{ type: 'control', streamId: 1, payload: new Uint8Array([1]) } as unknown as Frame, 'bad_stream'],
      [{ type: 'data', streamId: 0, payload: new Uint8Array([1]) }, 'bad_stream'],
      [{ type: 'data', streamId: 1, payload: new Uint8Array(0) }, 'bad_payload'],
      [{ type: 'data', streamId: 1, payload: new Uint8Array(SESSION_MAX_DATA_BYTES + 1) }, 'frame_too_large'],
      [
        { type: 'control', streamId: 0, payload: new Uint8Array(SESSION_MAX_CONTROL_BYTES + 1) },
        'frame_too_large',
      ],
      [{ type: 'credit', streamId: 1, credit: 0 }, 'bad_payload'],
      [{ type: 'credit', streamId: 1, credit: 16_777_217 }, 'bad_payload'],
      [{ type: 'reset', streamId: 1, code: 70_000 }, 'bad_payload'],
      [{ type: 'end', streamId: 2 ** 32 }, 'bad_stream'],
    ];
    for (const [frame, code] of bad) {
      expect(() => encodeFrame(frame)).toThrowError(FrameError);
      try {
        encodeFrame(frame);
      } catch (e) {
        expect((e as FrameError).code).toBe(code);
      }
    }
  });

  it('decodes a max-size frame fed one byte at a time in linear time', () => {
    const payload = new Uint8Array(SESSION_MAX_DATA_BYTES).map((_, i) => i & 0xff);
    const wire = encodeFrame({ type: 'data', streamId: 1, payload });
    const time = (step: number) => {
      const decoder = new FrameDecoder();
      const out: Frame[] = [];
      const t0 = Date.now();
      for (let i = 0; i < wire.length; i += step) out.push(...decoder.push(wire.subarray(i, i + step)));
      const ms = Date.now() - t0;
      expect(out).toHaveLength(1);
      expect((out[0] as { payload: Uint8Array }).payload).toEqual(payload);
      expect(decoder.pending).toBe(0);
      return ms;
    };
    time(1);
    // Quadratic accumulation took ~350 ms at 1-byte pieces (review L-6); linear decoding stays far below.
    expect(time(1)).toBeLessThan(100);
    const decoder = new FrameDecoder();
    decoder.push(wire.subarray(0, 2));
    expect(decoder.pending).toBe(2);
    decoder.push(wire.subarray(2, 10));
    expect(decoder.pending).toBe(10);
  });

  it('rejects an oversized length before buffering it', () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(new Uint8Array([0x00, 0x10, 0x00, 0x00]))).toThrowError(/frame length/);
    expect(() => decoder.push(new Uint8Array([0]))).toThrowError(/failed earlier/);
  });

  it('rejects unknown types and short bodies', () => {
    expect(() => decodeFrameBody(new Uint8Array([9, 0, 0, 0, 1]))).toThrowError(/unknown frame type/);
    expect(() => decodeFrameBody(new Uint8Array([1, 0, 0, 0]))).toThrowError(/shorter/);
    expect(() => decodeFrameBody(new Uint8Array([4, 0, 0, 0, 1, 0]))).toThrowError(/must be empty/);
    expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 4, 1, 0, 0, 0]))).toThrowError(
      /frame length 4/,
    );
  });
});
