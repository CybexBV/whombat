import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateIdentity,
  INITIAL_WINDOW_BYTES,
  MAX_MESSAGE_BYTES,
  type SecureChannelError,
  webSocketByteStream,
} from '../src/index.js';
import { connectPair, dec, enc, openWs, settle, startSpliceRelay, wsStreams } from './support.js';

describe('over real WebSockets through a splice relay', () => {
  let relay: Awaited<ReturnType<typeof startSpliceRelay>>;
  beforeAll(async () => {
    relay = await startSpliceRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  it('handshakes, pins, and exchanges bidirectional messages', async () => {
    const { c, a, client, appliance } = await connectPair({ streams: await wsStreams(relay.url) });
    expect(c.remotePeerId).toBe(appliance.peerId);
    expect(a.remotePeerId).toBe(client.peerId);
    await c.send(enc('ping'));
    expect(dec(await a.receive())).toBe('ping');
    await a.send(enc('pong'));
    expect(dec(await c.receive())).toBe('pong');
    await c.close();
    expect(await a.receive()).toBeNull();
    expect(await a.closed).toBeUndefined();
  });

  it('transfers 32 MiB each way intact', async () => {
    const { c, a } = await connectPair({ streams: await wsStreams(relay.url) });
    const total = 32 * 1024 * 1024;
    const src = new Uint8Array(total);
    for (let o = 0; o < total; o += 65536) crypto.getRandomValues(src.subarray(o, o + 65536));
    const want = Buffer.from(sha256(src)).toString('hex');
    const pump = async (from: typeof c, to: typeof a) => {
      const sending = (async () => {
        for (let o = 0; o < total; o += MAX_MESSAGE_BYTES) {
          await from.send(src.subarray(o, Math.min(o + MAX_MESSAGE_BYTES, total)));
        }
      })();
      const got = new Uint8Array(total);
      let off = 0;
      while (off < total) {
        const m = await to.receive();
        if (!m) throw new Error('early end');
        got.set(m, off);
        off += m.byteLength;
      }
      await sending;
      return Buffer.from(sha256(got)).toString('hex');
    };
    const t0 = performance.now();
    const [h1, h2] = await Promise.all([pump(c, a), pump(a, c)]);
    const ms = performance.now() - t0;
    expect(h1).toBe(want);
    expect(h2).toBe(want);
    console.info(
      `ws 2×32 MiB concurrent: ${ms.toFixed(0)} ms (${((2 * total) / 1048576 / (ms / 1000)).toFixed(0)} MiB/s aggregate)`,
    );
    await c.close();
  });

  it('wrong appliance PeerId aborts before application data', async () => {
    const streams = await wsStreams(relay.url);
    const before = relay.forwarded();
    const res = await settle(connectPair({ streams, expected: (await generateIdentity()).peerId }));
    expect((res as { error: SecureChannelError }).error.code).toBe('PEER_MISMATCH');
    // Client -> appliance: only Noise message A (2 + 32 bytes): no identity, no application data.
    expect(relay.forwarded().c2a - before.c2a).toBe(34);
  });

  it('many concurrent handshakes through the relay', async () => {
    const appliance = await generateIdentity();
    const t0 = performance.now();
    const pairs = await Promise.all(
      Array.from({ length: 50 }, async () => connectPair({ appliance, streams: await wsStreams(relay.url) })),
    );
    console.info(`50 concurrent ws handshakes (incl. connect): ${(performance.now() - t0).toFixed(0)} ms`);
    await Promise.all(
      pairs.map(async ({ c, a }, i) => {
        await c.send(enc(`n${i}`));
        expect(dec(await a.receive())).toBe(`n${i}`);
        await c.close();
      }),
    );
  });

  it('rekey threshold then a fresh reconnect over new sockets', async () => {
    const client = await generateIdentity();
    const appliance = await generateIdentity();
    const one = await connectPair({
      client,
      appliance,
      streams: await wsStreams(relay.url),
      clientLimits: { rekey: { maxMessages: 2 } },
    });
    await one.c.send(enc('a'));
    await one.c.send(enc('b'));
    await expect(one.c.send(enc('c'))).rejects.toMatchObject({ code: 'REKEY_REQUIRED' });
    await one.c.close();
    const two = await connectPair({ client, appliance, streams: await wsStreams(relay.url) });
    await two.c.send(enc('c'));
    expect(dec(await two.a.receive())).toBe('c');
    await two.c.close();
  });
});

describe('slow consumer over WebSockets', () => {
  it('a secure sender blocks while the receiver does not read, then everything arrives', async () => {
    const relay = await startSpliceRelay();
    try {
      const { c, a } = await connectPair({ streams: await wsStreams(relay.url) });
      const msg = new Uint8Array(MAX_MESSAGE_BYTES);
      let accepted = 0;
      const target = 2000;
      const sender = (async () => {
        for (let i = 0; i < target; i++) {
          await c.send(msg);
          accepted++;
        }
      })();
      await new Promise((r) => setTimeout(r, 800));
      const stalled = accepted;
      await new Promise((r) => setTimeout(r, 400));
      expect(accepted).toBe(stalled);
      expect(accepted).toBeLessThan(target);
      console.info(
        `secure ws slow consumer: sender stalled after ${((accepted * msg.byteLength) / 1048576).toFixed(1)} MiB`,
      );
      let n = 0;
      while (n < target) {
        const m = await a.receive();
        if (!m) throw new Error('early end');
        n++;
      }
      await sender;
      await c.close();
    } finally {
      await relay.close();
    }
  });
});

describe('malicious relay over WebSockets', () => {
  it('bit flip in a forwarded frame -> DECRYPT_FAILED', async () => {
    const relay = await startSpliceRelay({
      tamper: (dir, chunk, i) => {
        if (dir === 'c2a' && i === 3) {
          const x = chunk.slice();
          x[20] = (x[20] ?? 0) ^ 0x80;
          return [x];
        }
        return [chunk];
      },
    });
    try {
      const { c, a } = await connectPair({
        streams: await wsStreams(relay.url),
        clientLimits: { receiveWindowBytes: INITIAL_WINDOW_BYTES },
        applianceLimits: { receiveWindowBytes: INITIAL_WINDOW_BYTES },
      });
      await c.send(enc('fine'));
      await c.send(enc('tampered'));
      expect(dec(await a.receive())).toBe('fine');
      const r = await settle(a.receive());
      expect((r as { error: SecureChannelError }).error.code).toBe('DECRYPT_FAILED');
      // The appliance tears the socket down; the client observes the failure too.
      const cr = await c.closed;
      expect(cr).toBeDefined();
    } finally {
      await relay.close();
    }
  });
});

describe('WebSocket adapter bounds', () => {
  it('oversize WebSocket message -> FRAME_TOO_LARGE; text message -> PROTOCOL_ERROR', async () => {
    const relay = await startSpliceRelay({ maxPayload: 4 * 1024 * 1024 });
    try {
      for (const [payload, code] of [
        [new Uint8Array(300 * 1024), 'FRAME_TOO_LARGE'],
        ['text', 'PROTOCOL_ERROR'],
      ] as const) {
        const sid = `bounds-${code}`;
        const [evil, victimWs] = await Promise.all([
          openWs(`${relay.url}/c/${sid}`, 4 * 1024 * 1024),
          openWs(`${relay.url}/a/${sid}`, 4 * 1024 * 1024),
        ]);
        const victim = webSocketByteStream(victimWs as never, { maxMessageBytes: 256 * 1024 });
        // The splice closes both sides on text; send text straight to the victim's peer socket instead.
        if (typeof payload === 'string') {
          const r = settle(victim.read());
          victimWs.emit('message', Buffer.from(payload), false);
          expect(((await r) as { error: SecureChannelError }).error.code).toBe(code);
        } else {
          evil.send(payload);
          const r = await settle(victim.read());
          expect((r as { error: SecureChannelError }).error.code).toBe(code);
        }
        evil.close();
      }
    } finally {
      await relay.close();
    }
  });

  it('pauses a Node ws socket when the reader lags (receive backpressure reaches TCP)', async () => {
    const relay = await startSpliceRelay();
    try {
      const { client, appliance } = await wsStreams(relay.url);
      const big = new Uint8Array(200 * 1024);
      let written = 0;
      // Nobody reads `appliance`; writer honours backpressure.
      const writer = (async () => {
        for (let i = 0; i < 400; i++) {
          if (!client.write(big)) await client.drained();
          written += big.byteLength;
        }
      })();
      await new Promise((r) => setTimeout(r, 800));
      const stalled = written;
      await new Promise((r) => setTimeout(r, 500));
      console.info(
        `ws backpressure: writer stalled at ${(written / 1048576).toFixed(1)} MiB of 78 MiB while reader idle`,
      );
      // Stalled (not growing) and bounded by adapter + relay + kernel socket buffers.
      expect(written).toBe(stalled);
      expect(written).toBeLessThan(40 * 1024 * 1024);
      let got = 0;
      while (got < 400 * big.byteLength) {
        const m = await appliance.read();
        if (!m) break;
        got += m.byteLength;
      }
      await writer;
      expect(got).toBe(400 * big.byteLength);
      await client.close();
    } finally {
      await relay.close();
    }
  });
});
