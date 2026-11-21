import { describe, expect, it } from 'vitest';
import {
  acceptResponder,
  type ByteStream,
  generateIdentity,
  MAX_MESSAGE_BYTES,
  memoryByteStreamPair,
  openInitiator,
  type SecureChannelError,
  type SecureConnection,
  secureByteStream,
} from '../src/index.js';
import { connectPair, enc, mitmPair, settle, startSpliceRelay, type Tamper, wsStreams } from './support.js';

/**
 * Replayed, reordered and tampered transport records must fail the connection deterministically and promptly:
 * the side that detects it reports DECRYPT_FAILED to readers, pending senders and byte-stream waiters, and the
 * other side sees a failure too — never a connection that stays open with requests hanging (0.5.1 integration
 * report: a relay-replayed appliance record right after the welcome wedged the client session).
 */

const codeOf = (r: { ok: boolean; error?: unknown }) => (r.ok ? 'ok' : (r.error as SecureChannelError).code);
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
const codeWithin = async (p: Promise<SecureChannelError | undefined>, ms = 500) => {
  const r = await within(p, ms);
  return r === 'timeout' ? 'still open' : (r?.code ?? 'clean');
};

type Mode = 'duplicate' | 'reorder' | 'flip';
function tamperAt(dir: 'c2a' | 'a2c', index: number, mode: Mode): Tamper {
  let held: Uint8Array | undefined;
  return (d, chunk, i) => {
    if (d !== dir) return [chunk];
    if (mode === 'duplicate' && i === index) return [chunk, chunk];
    if (mode === 'flip' && i === index) {
      const x = chunk.slice();
      x[x.length >> 1] = (x[x.length >> 1] ?? 0) ^ 1;
      return [x];
    }
    if (mode === 'reorder' && i === index) {
      held = chunk;
      return [];
    }
    if (mode === 'reorder' && i === index + 1 && held) return [chunk, held];
    return [chunk];
  };
}

/**
 * Run a session through a tampering splice: the client sends numbered messages and the appliance echoes them.
 * Returns what each side ended with.
 */
async function session(streams: { client: ByteStream; appliance: ByteStream }) {
  const client = await generateIdentity();
  const appliance = await generateIdentity();
  const [c, a] = await Promise.all([
    settle(
      openInitiator({
        stream: streams.client,
        identity: client,
        expectedAppliancePeerId: appliance.peerId,
        limits: { handshakeTimeoutMs: 1000 },
      }),
    ),
    settle(
      acceptResponder({
        stream: streams.appliance,
        identity: appliance,
        limits: { handshakeTimeoutMs: 1000 },
      }),
    ),
  ]);
  if (!c.ok || !a.ok) return { phase: 'handshake', client: codeOf(c), appliance: codeOf(a) };
  const echo = (async () => {
    for await (const m of a.value) await a.value.send(m);
  })().catch(() => {});
  // Pipelined, so consecutive records exist in both directions (a reordering relay needs a next record).
  for (let i = 0; i < 6; i++) void c.value.send(enc(`m${i}`)).catch(() => {});
  for (let i = 0; i < 6; i++) {
    const got = await within(settle(c.value.receive()), 1000);
    if (got === 'timeout') return { phase: 'session', client: 'HUNG', appliance: 'HUNG' };
    if (!got.ok || got.value === null) break;
  }
  const result = {
    phase: 'session',
    client: await codeWithin(c.value.closed),
    appliance: await codeWithin(a.value.closed),
  };
  await echo;
  return result;
}

describe('replayed, reordered and tampered records fail the connection (either direction, every phase)', () => {
  for (const mode of ['duplicate', 'reorder', 'flip'] as const) {
    for (const dir of ['a2c', 'c2a'] as const) {
      it(`${mode} ${dir}: every record index`, async () => {
        // a2c: #0 message 2, #1 WINDOW grant, then echoes. c2a: #0 message 1, #1 message 3, #2 WINDOW grant, ...
        for (let index = 0; index <= 5; index++) {
          const r = await session(mitmPair(tamperAt(dir, index, mode)));
          const detecting = dir === 'a2c' ? r.client : r.appliance;
          const other = dir === 'a2c' ? r.appliance : r.client;
          if (r.phase === 'handshake') {
            // Handshake messages: authenticated by the handshake itself (holding one back is a stall: timeout).
            expect([
              'VERSION_MISMATCH',
              'HANDSHAKE_FAILED',
              'PEER_MISMATCH',
              'DECRYPT_FAILED',
              'HANDSHAKE_TIMEOUT',
            ]).toContain(detecting === 'ok' ? other : detecting);
            continue;
          }
          // After the handshake: the detecting side reports DECRYPT_FAILED, the other side a failure; nobody
          // ends cleanly or stays open. (The last tamperable index can fall after the session ended: then both
          // ended cleanly and nothing was tampered.)
          if (detecting === 'clean' && other === 'clean') continue;
          expect(detecting, `${mode} ${dir} #${index}`).toBe('DECRYPT_FAILED');
          expect(['TRANSPORT_ERROR', 'DECRYPT_FAILED']).toContain(other);
        }
      });
    }
  }

  it('duplicate right after the handshake over WebSockets: the client fails at once', async () => {
    for (const index of [1, 2, 3]) {
      const relay = await startSpliceRelay({
        tamper: (d, chunk, i) => (d === 'a2c' && i === index ? [chunk, chunk] : [chunk]),
      });
      try {
        const r = await session(await wsStreams(relay.url));
        expect(r.phase).toBe('session');
        expect(r.client).toBe('DECRYPT_FAILED');
        expect(r.appliance).not.toBe('still open');
      } finally {
        await relay.close();
      }
    }
  });
});

describe('the failure reaches every waiter promptly', () => {
  it('a pending receive, pending sends waiting for credit, and byte-stream writers all get DECRYPT_FAILED', async () => {
    // The appliance does not read, so the client's sends block on flow-control credit; then the appliance
    // sends one message and the relay delivers it twice.
    let arm = false;
    let seen = 0;
    const streams = mitmPair((d, chunk) => {
      if (d !== 'a2c' || !arm) return [chunk];
      seen++;
      return seen === 1 ? [chunk, chunk] : [chunk];
    });
    const { c, a } = await connectPair({ streams, applianceLimits: { receiveWindowBytes: 256 * 1024 } });
    const bytes = secureByteStream(c);
    const msg = new Uint8Array(MAX_MESSAGE_BYTES);
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) sends.push(settle(c.send(msg)));
    const writes = [...Array(8)].map(() => bytes.write(new Uint8Array(200_000)));
    expect(writes.some((w) => w === false)).toBe(true);
    const drained = settle(bytes.drained());
    const reading = settle(c.receive());
    await new Promise((r) => setTimeout(r, 50));
    arm = true;
    const t0 = performance.now();
    await a.send(enc('once'));
    const first = await reading;
    // The first copy is authentic and delivered; the replayed copy fails the connection.
    expect(first.ok).toBe(true);
    const closed = await within(c.closed, 500);
    expect(closed === 'timeout' ? 'timeout' : closed?.code).toBe('DECRYPT_FAILED');
    const all = await within(Promise.all(sends), 500);
    expect(all).not.toBe('timeout');
    const results = all as { ok: boolean; error?: unknown }[];
    expect(results.filter((r) => !r.ok).map(codeOf)).toEqual(
      results.filter((r) => !r.ok).map(() => 'DECRYPT_FAILED'),
    );
    expect(results.some((r) => !r.ok)).toBe(true);
    expect(codeOf((await drained) as { ok: boolean; error?: unknown })).toBe('DECRYPT_FAILED');
    expect(() => bytes.write(new Uint8Array(1))).toThrow(expect.objectContaining({ code: 'DECRYPT_FAILED' }));
    expect(codeOf(await settle(c.receive()))).toBe('DECRYPT_FAILED');
    expect(codeOf(await settle(bytes.read()))).toBe('DECRYPT_FAILED');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(await codeWithin(a.closed)).not.toBe('still open');
  });

  it('an idle byte-stream writer learns of the failure at once (write throws, drained rejects)', async () => {
    let arm = false;
    const streams = mitmPair((d, chunk) => (d === 'a2c' && arm ? [chunk, chunk] : [chunk]));
    const { c, a } = await connectPair({ streams });
    const bytes = secureByteStream(c);
    const reading = settle(bytes.read());
    arm = true;
    await a.send(enc('once'));
    expect((await reading).ok).toBe(true);
    expect(await codeWithin(c.closed)).toBe('DECRYPT_FAILED');
    await new Promise((r) => setTimeout(r, 0));
    // Nothing was queued when the connection failed: the writer must not be told `true` and lose its bytes.
    expect(() => bytes.write(new Uint8Array(10))).toThrow(
      expect.objectContaining({ code: 'DECRYPT_FAILED' }),
    );
    expect(codeOf(await settle(bytes.drained()))).toBe('DECRYPT_FAILED');
    expect(codeOf(await settle(bytes.close()))).toBe('DECRYPT_FAILED');
  });

  it('a replayed record in the same burst as the last handshake message (end of stream held): DECRYPT_FAILED, never a clean end', async () => {
    for (let round = 0; round < 10; round++) {
      // Coalesce everything the client sends after message 1 into one chunk, with the first transport record
      // after message 3 duplicated, and close.
      const [x, relayC] = memoryByteStreamPair();
      const [relayA, y] = memoryByteStreamPair();
      void (async () => {
        const m1 = await relayC.read();
        if (m1) relayA.write(m1);
        const parts: Uint8Array[] = [];
        for (;;) {
          const chunk = await relayC.read().catch(() => null);
          if (chunk === null) break;
          parts.push(chunk);
          if (parts.length === 1) parts.push(chunk.slice(0, 0));
        }
        // parts[0] = message 3, then the client's transport records; duplicate the first transport record.
        const burst = [parts[0], parts[2], parts[2], ...parts.slice(3)].filter(Boolean) as Uint8Array[];
        const all = new Uint8Array(burst.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of burst) {
          all.set(p, o);
          o += p.length;
        }
        relayA.write(all);
        await relayA.close();
      })();
      void (async () => {
        for (;;) {
          const chunk = await relayA.read().catch(() => null);
          if (chunk === null) return;
          try {
            relayC.write(chunk);
          } catch {
            return;
          }
        }
      })();
      const client = await generateIdentity();
      const appliance = await generateIdentity();
      const clientSide = openInitiator({
        stream: x,
        identity: client,
        expectedAppliancePeerId: appliance.peerId,
      })
        .then(async (conn) => {
          for (const m of ['one', 'two']) void conn.send(enc(m)).catch(() => {});
          await conn.close().catch(() => {});
        })
        .catch(() => {});
      const accepted = await settle(acceptResponder({ stream: y, identity: appliance }));
      let outcome: string;
      if (!accepted.ok) outcome = codeOf(accepted);
      else {
        const conn = accepted.value as SecureConnection;
        const got: string[] = [];
        const r = await settle(
          (async () => {
            for await (const m of conn) got.push(new TextDecoder().decode(m));
          })(),
        );
        outcome = r.ok ? 'clean' : codeOf(r);
        expect(got.length).toBeLessThanOrEqual(2);
      }
      expect(outcome).toBe('DECRYPT_FAILED');
      await clientSide;
    }
  });
});
