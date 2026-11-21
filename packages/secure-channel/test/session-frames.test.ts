import { encodeFrame, type Frame, FrameDecoder } from '@whombat/protocol/frame';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secureByteStream } from '../src/index.js';
import { connectPair, startSpliceRelay, wsStreams } from './support.js';

/** CT-05 session frames ([u32 len][u8 type][u32 stream][payload], payload ≤ 64 KiB) over secureByteStream. */
describe('session protocol frames over the secure channel', () => {
  let relay: Awaited<ReturnType<typeof startSpliceRelay>>;
  beforeAll(async () => {
    relay = await startSpliceRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  it('carries max-size CT-05 frames (larger than one Noise record) intact over WebSockets', async () => {
    const { c, a } = await connectPair({ streams: await wsStreams(relay.url) });
    const out = secureByteStream(c);
    const inbound = secureByteStream(a);
    const big = new Uint8Array(64 * 1024).map((_, i) => (i * 13) & 0xff);
    const frames: Frame[] = [
      { type: 'control', streamId: 0, payload: new TextEncoder().encode('{"t":"hello"}') },
      { type: 'data', streamId: 1, payload: big },
      { type: 'credit', streamId: 1, credit: 16 * 1024 * 1024 },
      { type: 'data', streamId: 3, payload: big.subarray(1) },
      { type: 'end', streamId: 1 },
      { type: 'reset', streamId: 3, code: 1 },
    ];
    const N = 200;
    const writer = (async () => {
      for (let i = 0; i < N; i++) {
        for (const f of frames) if (!out.write(encodeFrame(f))) await out.drained();
      }
      await out.close();
    })();
    const decoder = new FrameDecoder();
    const got: Frame[] = [];
    for (let chunk = await inbound.read(); chunk; chunk = await inbound.read())
      got.push(...decoder.push(chunk));
    await writer;
    expect(decoder.pending).toBe(0);
    expect(got).toHaveLength(N * frames.length);
    for (let i = 0; i < got.length; i++) {
      const want = frames[i % frames.length] as Frame;
      const have = got[i] as Frame;
      expect(have.type).toBe(want.type);
      expect(have.streamId).toBe(want.streamId);
      if ('payload' in want && 'payload' in have) expect(Buffer.compare(have.payload, want.payload)).toBe(0);
    }
    expect(await a.closed).toBeUndefined();
  });
});
