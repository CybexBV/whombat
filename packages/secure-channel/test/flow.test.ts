import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptResponder,
  assertSecureRandom,
  type ByteStream,
  FRAME_CEILING,
  generateIdentity,
  MAX_MESSAGE_BYTES,
  memoryByteStreamPair,
  openInitiator,
  type SecureChannelError,
  type SecureConnection,
  secureByteStream,
  webSocketByteStream,
} from '../src/index.js';
import { RnLikeWebSocket } from './rn-websocket.js';
import { connectPair, dec, enc, mitmPair, openWs, settle, startSpliceRelay } from './support.js';

const codeOf = (r: { ok: boolean; error?: unknown }) => (r.ok ? 'ok' : (r.error as SecureChannelError).code);

/** Drain a byte stream: total bytes, then how it ended. */
async function drain(stream: ByteStream): Promise<{ bytes: number; end: string }> {
  let bytes = 0;
  for (;;) {
    const r = await settle(stream.read());
    if (!r.ok) return { bytes, end: codeOf(r) };
    if (r.value === null) return { bytes, end: 'clean' };
    bytes += r.value.byteLength;
  }
}

describe('secureByteStream never turns a lost write into a clean end (review M-1)', () => {
  it('rekey threshold mid-write: close() rejects and the reader sees a failure, not EOF', async () => {
    const { c, a } = await connectPair({ clientLimits: { rekey: { maxMessages: 3 } } });
    const writer = secureByteStream(c);
    const reader = secureByteStream(a);
    const piece = new Uint8Array(40 * 1024).fill(7);
    for (let i = 0; i < 5; i++) expect(writer.write(piece)).toBe(true);
    const closing = await settle(writer.close());
    expect(codeOf(closing)).toBe('REKEY_REQUIRED');
    const got = await drain(reader);
    expect(got.bytes).toBeLessThan(5 * piece.byteLength);
    expect(got.end).not.toBe('clean');
    expect(await a.closed).toBeDefined();
    expect(() => writer.write(piece)).toThrow();
    await expect(writer.drained()).rejects.toMatchObject({ code: 'REKEY_REQUIRED' });
  });

  it('transport failure mid-write: close() rejects, reader fails', async () => {
    const [x, y] = memoryByteStreamPair();
    const { c, a } = await connectPair({ streams: { client: x, appliance: y } });
    const writer = secureByteStream(c);
    const reader = secureByteStream(a);
    writer.write(new Uint8Array(64 * 1024));
    x.abort(new Error('cable cut'));
    for (let i = 0; i < 10; i++) {
      try {
        writer.write(new Uint8Array(64 * 1024));
      } catch {
        break;
      }
    }
    expect((await settle(writer.close())).ok).toBe(false);
    expect((await drain(reader)).end).not.toBe('clean');
  });

  it('a complete write + close reads as a clean end with every byte', async () => {
    const { c, a } = await connectPair();
    const writer = secureByteStream(c);
    const reader = secureByteStream(a);
    const total = 3 * 1024 * 1024 + 17;
    const reading = drain(reader);
    for (let o = 0; o < total; o += 100_000) {
      if (!writer.write(new Uint8Array(Math.min(100_000, total - o)))) await writer.drained();
    }
    await writer.close();
    expect(await reading).toEqual({ bytes: total, end: 'clean' });
  });

  it('Connection.close() on a failed connection rejects instead of sending a close record', async () => {
    const { c, a } = await connectPair();
    c.abort(new Error('local failure'));
    await expect(c.close()).rejects.toMatchObject({ code: 'CLOSED' });
    expect((await settle(a.receive())).ok).toBe(false);
  });
});

describe('connection-level flow control', () => {
  it('a peer that sends beyond the granted window is cut off (PROTOCOL_ERROR)', async () => {
    const { c, a } = await connectPair({ applianceLimits: { receiveWindowBytes: 256 * 1024 } });
    // Forge credit on the client (as a misbehaving peer would) and send past the appliance's window.
    (c as unknown as { sendCredit: number }).sendCredit = 64 * 1024 * 1024;
    const msg = new Uint8Array(MAX_MESSAGE_BYTES);
    for (let i = 0; i < 6; i++) await c.send(msg).catch(() => {});
    const r = await (async () => {
      for (;;) {
        const x = await settle(a.receive());
        if (!x.ok) return x;
      }
    })();
    expect(codeOf(r)).toBe('PROTOCOL_ERROR');
    expect((r as { error: Error }).error.message).toMatch(/flow-control window/);
  });

  describe('WINDOW record validation (review N-2, re-review PoC cases 1-4)', () => {
    const u32 = (n: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n >>> 0, false);
      return b;
    };
    type Raw = { write(r: Uint8Array): boolean; record(t: number, p: Uint8Array): Uint8Array };
    const raw = (c: SecureConnection) => c as unknown as Raw;
    const outcome = async (victim: SecureConnection) =>
      Promise.race([victim.closed, new Promise((r) => setTimeout(() => r('still open'), 300))]);

    for (const [label, payload, message] of [
      ['increment 0', u32(0), /invalid window increment/],
      ['increment 2^32-1', u32(0xffffffff), /invalid window increment/],
      ['3-byte payload', new Uint8Array(3), /window record must carry 4 bytes/],
      ['5-byte payload', new Uint8Array(5), /window record must carry 4 bytes/],
    ] as const) {
      it(`${label} -> PROTOCOL_ERROR`, async () => {
        const { c, a } = await connectPair();
        raw(c).write(raw(c).record(0x02, payload));
        const r = (await outcome(a)) as SecureChannelError;
        expect(r?.code).toBe('PROTOCOL_ERROR');
        expect(r.message).toMatch(message);
      });
    }

    it('outstanding credit is capped at 64 MiB', async () => {
      const { c, a } = await connectPair();
      // The victim already holds 1 MiB of credit from the attacker's default window.
      raw(c).write(raw(c).record(0x02, u32(63 * 1024 * 1024 - 1024 * 1024)));
      expect(await outcome(a)).toBe('still open');
      raw(c).write(raw(c).record(0x02, u32(1024 * 1024 + 1)));
      expect(((await outcome(a)) as SecureChannelError)?.code).toBe('PROTOCOL_ERROR');
    });
  });

  it('a peer past the receive-side frame ceiling without rekeying is cut off (I-5)', async () => {
    const { c, a } = await connectPair();
    await c.send(enc('before'));
    expect(dec(await a.receive())).toBe('before');
    (a as unknown as { counters: { framesReceived: number } }).counters.framesReceived =
      FRAME_CEILING + 2 ** 20;
    await c.send(enc('after'));
    const r = await settle(a.receive());
    expect(codeOf(r)).toBe('PROTOCOL_ERROR');
    expect((r as { error: Error }).error.message).toMatch(/frame limit/);
  });

  it('an unknown record type from an authenticated peer is a PROTOCOL_ERROR', async () => {
    const { c, a } = await connectPair();
    const raw = new Uint8Array([0x07, 0, 0, 0, 1, 42]);
    (c as unknown as { secured: { send(b: Uint8Array): boolean } }).secured.send(raw);
    const r = await settle(a.receive());
    expect(codeOf(r)).toBe('PROTOCOL_ERROR');
    expect((r as { error: Error }).error.message).toMatch(/unknown record type 7/);
  });

  it('both directions stay bounded by the window with nobody reading, then deliver everything', async () => {
    const { c, a } = await connectPair();
    const msg = new Uint8Array(32 * 1024);
    let cSent = 0;
    let aSent = 0;
    let stop = false;
    const pumpC = (async () => {
      while (!stop) {
        await c.send(msg);
        cSent++;
      }
    })();
    const pumpA = (async () => {
      while (!stop) {
        await a.send(msg);
        aSent++;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    const [c0, a0] = [cSent, aSent];
    await new Promise((r) => setTimeout(r, 200));
    expect([cSent, aSent]).toEqual([c0, a0]);
    // Default 1 MiB window, 32 KiB + 64 bytes per message.
    expect(cSent).toBeLessThanOrEqual(32);
    expect(aSent).toBeLessThanOrEqual(32);
    stop = true;
    let ca = 0;
    let ac = 0;
    while (ac < cSent || ca < aSent) {
      if (ac < cSent) ac += (await a.receive()) ? 1 : 0;
      if (ca < aSent) ca += (await c.receive()) ? 1 : 0;
    }
    await Promise.race([Promise.all([pumpC, pumpA]), new Promise((r) => setTimeout(r, 100))]);
    await c.close().catch(() => {});
  });
});

describe('close races are deterministic (review L-3)', () => {
  async function fastClient(streams: { client: ByteStream; appliance: ByteStream }) {
    const client = await generateIdentity();
    const appliance = await generateIdentity();
    // The client sends and closes as soon as its own handshake completes, without waiting for the appliance.
    const clientSide = openInitiator({
      stream: streams.client,
      identity: client,
      expectedAppliancePeerId: appliance.peerId,
    }).then(async (c) => {
      for (const m of ['one', 'two', 'three']) await c.send(enc(m));
      await c.close();
      return c.closed;
    });
    const a = await acceptResponder({ stream: streams.appliance, identity: appliance });
    const got: string[] = [];
    const r = await settle(
      (async () => {
        for await (const m of a) got.push(dec(m));
      })(),
    );
    return { got, err: r.ok ? undefined : codeOf(r), closed: await a.closed, clientClosed: await clientSide };
  }

  it('a client that sends and closes before the appliance finishes its handshake loses nothing (memory, x40)', async () => {
    for (let i = 0; i < 40; i++) {
      const [x, y] = memoryByteStreamPair();
      const r = await fastClient({ client: x, appliance: y });
      expect(r).toEqual({
        got: ['one', 'two', 'three'],
        err: undefined,
        closed: undefined,
        clientClosed: undefined,
      });
    }
  });

  it('same through a relay that splits into 1-byte chunks or coalesces everything', async () => {
    const split = mitmPair((_d, chunk) => Array.from(chunk, (b) => new Uint8Array([b])));
    expect(await fastClient(split)).toMatchObject({ got: ['one', 'two', 'three'], closed: undefined });
    let held: Uint8Array[] = [];
    const coalesce = mitmPair((dir, chunk, i) => {
      if (dir !== 'c2a' || i === 0) return [chunk];
      held.push(chunk);
      const all = new Uint8Array(held.reduce((n, h) => n + h.length, 0));
      let o = 0;
      for (const h of held) {
        all.set(h, o);
        o += h.length;
      }
      held = [];
      return [all];
    });
    expect(await fastClient(coalesce)).toMatchObject({ got: ['one', 'two', 'three'], closed: undefined });
  });

  it('after the peer’s authenticated close, both ends report a clean end (no CLOSED/TRANSPORT_ERROR)', async () => {
    for (let i = 0; i < 20; i++) {
      const { c, a } = await connectPair();
      await c.send(enc('x'));
      await c.close();
      expect(dec(await a.receive())).toBe('x');
      expect(await a.receive()).toBeNull();
      expect(await a.closed).toBeUndefined();
      expect(await c.closed).toBeUndefined();
    }
  });

  it('the peer’s CLOSE ends the connection at once, even if our transport never finishes closing', async () => {
    const [x, y] = memoryByteStreamPair();
    const stuck: ByteStream = {
      ...y,
      read: () => y.read(),
      write: (c) => y.write(c),
      close: () => new Promise(() => {}),
    };
    const { c, a } = await connectPair({ streams: { client: x, appliance: stuck } });
    await c.send(enc('last'));
    // The client's CLOSE record, without the client closing its transport.
    (c as unknown as { secured: { send(b: Uint8Array): boolean } }).secured.send(
      new Uint8Array([1, 0, 0, 0, 0]),
    );
    expect(dec(await a.receive())).toBe('last');
    expect(await a.receive()).toBeNull();
    const outcome = await Promise.race([a.closed, new Promise((r) => setTimeout(() => r('timeout'), 500))]);
    expect(outcome).toBeUndefined();
    await expect(a.send(enc('late'))).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('a lost DATA write is reported even when the peer then closes cleanly', async () => {
    const [x, y] = memoryByteStreamPair();
    let failWrites = false;
    const flaky: ByteStream = {
      read: () => y.read(),
      write: (chunk) => {
        if (failWrites) throw new Error('socket write failed');
        return y.write(chunk);
      },
      drained: () => y.drained(),
      close: () => y.close(),
      abort: (r) => y.abort(r),
    };
    const { c, a } = await connectPair({ streams: { client: x, appliance: flaky } });
    await a.send(enc('delivered'));
    expect(dec(await c.receive())).toBe('delivered');
    failWrites = true;
    await expect(a.send(enc('lost'))).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    // The appliance answers the client's close by failing the transport (its own data was lost), so the client's
    // close may reject too: neither side reports a clean session.
    await c.close().catch(() => {});
    // The appliance must not report a clean end: 'lost' never arrived.
    await expect(a.receive()).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    expect((await a.closed)?.code).toBe('TRANSPORT_ERROR');
  });

  it('over WebSockets through the splice relay (x20)', async () => {
    const relay = await startSpliceRelay();
    try {
      for (let i = 0; i < 20; i++) {
        const sid = `race-${i}-${Math.random().toString(36).slice(2)}`;
        const [cw, aw] = await Promise.all([
          openWs(`${relay.url}/c/${sid}`),
          openWs(`${relay.url}/a/${sid}`),
        ]);
        const r = await fastClient({
          client: webSocketByteStream(cw as never),
          appliance: webSocketByteStream(aw as never),
        });
        expect(r).toMatchObject({ got: ['one', 'two', 'three'], closed: undefined });
      }
    } finally {
      await relay.close();
    }
  });
});

describe('React Native WebSocket (review M-2)', () => {
  let relay: Awaited<ReturnType<typeof startSpliceRelay>>;
  beforeAll(async () => {
    relay = await startSpliceRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  async function rnPair() {
    const sid = `rn-${Math.random().toString(36).slice(2)}`;
    const [rn, aw] = await Promise.all([
      RnLikeWebSocket.open(`${relay.url}/c/${sid}`),
      openWs(`${relay.url}/a/${sid}`),
    ]);
    expect(rn.bufferedAmount).toBeUndefined();
    return { rn, client: webSocketByteStream(rn as never), appliance: webSocketByteStream(aw as never) };
  }

  it('the simulation is faithful: raw writes with no flow control overflow OkHttp’s queue (1001)', async () => {
    const { rn, client } = await rnPair();
    // Nobody reads the appliance end; the relay and the appliance socket push back; RN cannot see it, and
    // `write` keeps returning true (no bufferedAmount).
    for (let i = 0; i < 400 && !rn.refused; i++) {
      expect(client.write(new Uint8Array(256 * 1024))).toBe(true);
      await new Promise((r) => setTimeout(r, 2));
    }
    // OkHttp would now drop the message and close with 1001 ("going away").
    expect(rn.refused).toBe(true);
    expect(rn.maxNativeQueue).toBeGreaterThan(15 * 1024 * 1024);
    client.abort(new Error('test done'));
  });

  it('handshakes, pins and echoes over the RN socket', async () => {
    const { client, appliance } = await rnPair();
    const { c, a, appliance: id } = await connectPair({ streams: { client, appliance } });
    expect(c.remotePeerId).toBe(id.peerId);
    for (const size of [0, 1, 1000, MAX_MESSAGE_BYTES]) {
      await c.send(new Uint8Array(size).fill(3));
      const m = await a.receive();
      await a.send(m ?? new Uint8Array(0));
      expect((await c.receive())?.byteLength).toBe(size);
    }
    await c.close();
    expect(await a.closed).toBeUndefined();
  });

  it('a 48 MiB upload to a slow appliance stays within the flow-control window in the native queue', async () => {
    const { rn, client, appliance } = await rnPair();
    const { c, a } = await connectPair({ streams: { client, appliance } });
    const total = 48 * 1024 * 1024;
    const sending = (async () => {
      const msg = new Uint8Array(MAX_MESSAGE_BYTES);
      for (let s = 0; s < total; s += msg.byteLength)
        await c.send(msg.subarray(0, Math.min(msg.byteLength, total - s)));
    })();
    let got = 0;
    let n = 0;
    const reader = async (conn: SecureConnection) => {
      while (got < total) {
        const m = await conn.receive();
        if (!m) throw new Error('early end');
        got += m.byteLength;
        // A slow consumer: 1 ms every 16 messages.
        if (++n % 16 === 0) await new Promise((r) => setTimeout(r, 1));
      }
    };
    await Promise.all([sending, reader(a)]);
    console.info(`RN upload 48 MiB: max native (OkHttp) queue ${(rn.maxNativeQueue / 1024).toFixed(0)} KiB`);
    expect(got).toBe(total);
    // 1 MiB window + one transport chunk of slack, far from the 16 MiB OkHttp limit.
    expect(rn.maxNativeQueue).toBeLessThan(2 * 1024 * 1024);
    await c.close();
    expect(await a.closed).toBeUndefined();
  });

  it('a 16 MiB download to the RN client is bounded by the client’s window (no receive-buffer overflow)', async () => {
    const { client, appliance } = await rnPair();
    const { c, a } = await connectPair({ streams: { client, appliance } });
    const total = 16 * 1024 * 1024;
    const msg = new Uint8Array(MAX_MESSAGE_BYTES);
    let sent = 0;
    const sending = (async () => {
      while (sent < total) {
        await a.send(msg);
        sent += msg.byteLength;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    // The client has not read yet: the appliance is held at the client's 1 MiB window.
    expect(sent).toBeLessThanOrEqual(1024 * 1024);
    let got = 0;
    while (got < sent || got < total) got += (await c.receive())?.byteLength ?? Number.NaN;
    await sending;
    await a.close();
    expect(await c.closed).toBeUndefined();
  });
});

describe('React Native AbortSignal without throwIfAborted', () => {
  it('a handshake under transport backpressure works when AbortSignal lacks throwIfAborted', async () => {
    const proto = AbortSignal.prototype as unknown as { throwIfAborted?: () => void };
    const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted');
    delete proto.throwIfAborted; // emulate React Native's abort-controller polyfill
    try {
      // highWaterBytes 0: every handshake write reports backpressure, so upstream waits for 'drain' (p-event).
      const [x, y] = memoryByteStreamPair({ highWaterBytes: 0 });
      const { c, a } = await connectPair({ streams: { client: x, appliance: y } });
      await c.send(enc('rn'));
      expect(dec(await a.receive())).toBe('rn');
      await c.close();
    } finally {
      if (original) Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', original);
    }
  });
});

describe('random-source self-test (review L-2)', () => {
  it('rejects constant, counter and repeating sources', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const install = (getRandomValues: (a: Uint8Array) => Uint8Array) =>
      Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues }, configurable: true });
    try {
      install((a) => a.fill(0x42));
      expect(() => assertSecureRandom()).toThrow(/getRandomValues/);
      let n = 0;
      install((a) => a.map(() => n++ & 0xff));
      expect(() => assertSecureRandom()).toThrow();
      const fixed = new Uint8Array(64).map((_, i) => (i * 97 + 13) ^ (i >> 1));
      install((a) => {
        a.set(fixed.subarray(0, a.length));
        return a;
      });
      expect(() => assertSecureRandom()).toThrow();
      install((a) => {
        throw new Error(`no entropy for ${a.length}`);
      });
      expect(() => assertSecureRandom()).toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
    expect(() => assertSecureRandom()).not.toThrow();
  });
});
