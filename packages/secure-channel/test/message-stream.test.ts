import type { StreamMessageEvent } from '@libp2p/interface';
import { describe, expect, it } from 'vitest';
import type { ByteStream } from '../src/index.js';
import { ByteStreamMessageStream } from '../src/message-stream.js';

/** A byte source whose reads the test resolves by hand. */
function manualStream(): { stream: ByteStream; feed: (c: Uint8Array | null) => void } {
  const queue: (Uint8Array | null)[] = [];
  let waiting: ((c: Uint8Array | null) => void) | undefined;
  return {
    feed(c) {
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w(c);
      } else queue.push(c);
    },
    stream: {
      read: () =>
        queue.length > 0
          ? Promise.resolve(queue.shift() ?? null)
          : new Promise((r) => {
              waiting = r;
            }),
      write: () => true,
      drained: () => Promise.resolve(),
      close: async () => {},
      abort: () => {},
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ByteStreamMessageStream end of stream (review L-3)', () => {
  it('delivers bytes handed back by the handshake reader before an end of stream that arrives later', async () => {
    const { stream, feed } = manualStream();
    const raw = new ByteStreamMessageStream(stream, {
      direction: 'inbound',
      maxReadBufferLength: 1 << 20,
      maxChunkBytes: 1 << 16,
      handshakeFramesToRead: 1,
    });
    feed(new Uint8Array([0, 1, 0xaa]));
    await tick();
    const events: string[] = [];
    raw.addEventListener('message', (e: StreamMessageEvent) => events.push(`data:${e.data.byteLength}`));
    raw.addEventListener('close', () => events.push('close'));
    await tick();
    events.length = 0;
    raw.releaseEof();
    // What lpStream.unwrap() does with bytes it read past the handshake: dispatched from a timer.
    raw.unshift(new Uint8Array(5));
    feed(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['data:5', 'close']);
  });

  it('delivers the end at once when the handshake cannot complete', async () => {
    const { stream, feed } = manualStream();
    const raw = new ByteStreamMessageStream(stream, {
      direction: 'inbound',
      maxReadBufferLength: 1 << 20,
      maxChunkBytes: 1 << 16,
      handshakeFramesToRead: 2,
    });
    feed(new Uint8Array([0, 3, 1]));
    feed(null);
    await tick();
    expect(raw.status).toBe('closed');
  });

  it('holds the end until release when the handshake messages are complete', async () => {
    const { stream, feed } = manualStream();
    const raw = new ByteStreamMessageStream(stream, {
      direction: 'inbound',
      maxReadBufferLength: 1 << 20,
      maxChunkBytes: 1 << 16,
      handshakeFramesToRead: 2,
    });
    feed(new Uint8Array([0, 1, 7, 0, 0, 9, 9]));
    feed(null);
    await new Promise((r) => setTimeout(r, 10));
    expect(raw.status).toBe('open');
    raw.addEventListener('message', () => {});
    raw.releaseEof();
    await new Promise((r) => setTimeout(r, 10));
    expect(raw.status).toBe('closed');
  });
});
