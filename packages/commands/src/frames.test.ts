import { describe, expect, it } from 'vitest';
import { encodeFrame, FRAME, FrameDecoder, MAX_FRAME } from './frames.mjs';
import { encodeFrame as encodeGitFrame, FrameReader } from './whombat-git.mjs';

/** Hand-built wire bytes keep the encoder and decoder from proving only that they agree. */
function wireFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

it('is the codec git’s GitHub transport speaks', () => {
  expect(FrameReader).toBe(FrameDecoder);
  expect(encodeGitFrame).toBe(encodeFrame);
});

describe('frame decoding', () => {
  it('reads split headers, split payloads, empty frames and several frames together', () => {
    const expected = [
      { type: FRAME.stdout, payload: Buffer.from('hello') },
      { type: FRAME.eof, payload: Buffer.alloc(0) },
      { type: FRAME.stderr, payload: Buffer.from('héllo 🦫') },
      { type: 255, payload: Buffer.from([0, 255, 7]) },
    ];
    const bytes = Buffer.concat(expected.map((f) => wireFrame(f.type, f.payload)));
    for (const size of [1, 2, 4, 5, 7, bytes.length]) {
      const decoder = new FrameDecoder();
      const actual = [];
      for (let at = 0; at < bytes.length; at += size)
        actual.push(...decoder.push(bytes.subarray(at, at + size)));
      expect(actual).toEqual(expected);
      expect(decoder.push(Buffer.alloc(0))).toEqual([]);
    }
  });

  it('keeps completed payloads independent of later input and reusable read buffers', () => {
    const decoder = new FrameDecoder();
    const chunk = wireFrame(FRAME.stdout, Buffer.from('first'));
    const first = decoder.push(chunk);
    chunk.fill(0);
    decoder.push(wireFrame(FRAME.stderr, Buffer.from('second')));
    expect(first).toEqual([{ type: FRAME.stdout, payload: Buffer.from('first') }]);
  });

  it('accepts a maximum-sized fragmented frame and the following frame', () => {
    const body = Buffer.alloc(MAX_FRAME, 0xa5);
    const bytes = Buffer.concat([wireFrame(FRAME.stdout, body), wireFrame(FRAME.eof, Buffer.alloc(0))]);
    const decoder = new FrameDecoder();
    const actual = [];
    for (let at = 0; at < bytes.length; at += 1024)
      actual.push(...decoder.push(bytes.subarray(at, at + 1024)));
    expect(actual).toEqual([
      { type: FRAME.stdout, payload: body },
      { type: FRAME.eof, payload: Buffer.alloc(0) },
    ]);
  });

  it('refuses an oversized frame as soon as its header arrives', () => {
    const header = Buffer.alloc(5);
    header[0] = FRAME.stdout;
    header.writeUInt32BE(MAX_FRAME + 1, 1);
    const decoder = new FrameDecoder();
    expect(decoder.push(header.subarray(0, 4))).toEqual([]);
    expect(() => decoder.push(header.subarray(4))).toThrow('frame too large');
  });
});

describe('frame encoding', () => {
  it('writes the wire format for empty, binary and multibyte text payloads', () => {
    expect(encodeFrame(FRAME.eof)).toEqual(wireFrame(FRAME.eof, Buffer.alloc(0)));
    expect(encodeFrame(FRAME.stdout, 'héllo 🦫')).toEqual(wireFrame(FRAME.stdout, Buffer.from('héllo 🦫')));
    expect(encodeFrame(FRAME.stdin, Buffer.from([0, 255, 10]))).toEqual(
      wireFrame(FRAME.stdin, Buffer.from([0, 255, 10])),
    );
  });

  it('splits large payloads at the frame bound and owns the encoded bytes', () => {
    const body = Buffer.alloc(MAX_FRAME * 2 + 17, 0xa5);
    const expected = Buffer.concat([
      wireFrame(FRAME.stdout, body.subarray(0, MAX_FRAME)),
      wireFrame(FRAME.stdout, body.subarray(MAX_FRAME, MAX_FRAME * 2)),
      wireFrame(FRAME.stdout, body.subarray(MAX_FRAME * 2)),
    ]);
    const encoded = encodeFrame(FRAME.stdout, body);
    body.fill(0);
    expect(encoded).toEqual(expected);
  });
});

it('reports only bytes of the unfinished frame, including a partial header', () => {
  const decoder = new FrameDecoder();
  const bytes = wireFrame(FRAME.stdout, Buffer.from('hello'));
  decoder.push(new Uint8Array(bytes.subarray(0, 2)));
  expect(decoder.pending).toBe(2);
  decoder.push(bytes.subarray(2, 7));
  expect(decoder.pending).toBe(7);
  decoder.push(Buffer.concat([bytes.subarray(7), bytes.subarray(0, 1)]));
  expect(decoder.pending).toBe(1);
  decoder.push(bytes.subarray(1));
  expect(decoder.pending).toBe(0);
});
