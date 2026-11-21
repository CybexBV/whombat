import { generateKeyPair } from '@libp2p/crypto/keys';
import { noise } from '@libp2p/noise';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  acceptResponder,
  type ByteStream,
  DEFAULT_PROLOGUE,
  FRAME_CEILING,
  fingerprint,
  generateIdentity,
  MAX_MESSAGE_BYTES,
  memoryByteStreamPair,
  openInitiator,
  SecureChannelError,
} from '../src/index.js';
import { ByteStreamMessageStream, silentComponentLogger } from '../src/message-stream.js';
import { connectPair, dec, enc, identities, settle } from './support.js';

/** Record what one side writes to the transport. */
function recording(stream: ByteStream): { stream: ByteStream; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    stream: {
      read: () => stream.read(),
      write: (c) => {
        written.push(c.slice());
        return stream.write(c);
      },
      drained: () => stream.drained(),
      close: () => stream.close(),
      abort: (r) => stream.abort(r),
    },
  };
}

function codeOf(result: { ok: boolean; error?: unknown }): string | undefined {
  return result.ok ? undefined : (result.error as SecureChannelError).code;
}

describe('handshake and messages', () => {
  it('authenticates both identities and exchanges ordered bidirectional messages', async () => {
    const { c, a, client, appliance } = await connectPair();
    expect(c.role).toBe('initiator');
    expect(a.role).toBe('responder');
    expect(c.remotePeerId).toBe(appliance.peerId);
    expect(Array.from(c.remotePublicKey)).toEqual(Array.from(appliance.publicKey));
    expect(a.remotePeerId).toBe(client.peerId);
    expect(Array.from(a.remotePublicKey)).toEqual(Array.from(client.publicKey));

    const N = 500;
    const sending = (async () => {
      for (let i = 0; i < N; i++) await c.send(enc(`c${i}`));
      for (let i = 0; i < N; i++) await a.send(enc(`a${i}`));
    })();
    for (let i = 0; i < N; i++) expect(dec(await a.receive())).toBe(`c${i}`);
    for (let i = 0; i < N; i++) expect(dec(await c.receive())).toBe(`a${i}`);
    await sending;
    expect(c.stats().messagesSent).toBe(N);
    expect(a.stats().messagesReceived).toBe(N);
    expect(c.stats().framesSent).toBeGreaterThan(0);
    await c.close();
    expect(await a.receive()).toBeNull();
    expect(await a.closed).toBeUndefined();
    expect(await c.closed).toBeUndefined();
  });

  it('carries empty and maximum-size messages and a 64 MiB transfer intact', async () => {
    const { c, a } = await connectPair();
    await c.send(new Uint8Array(0));
    expect((await a.receive())?.byteLength).toBe(0);
    const max = new Uint8Array(MAX_MESSAGE_BYTES).map((_, i) => i & 0xff);
    await c.send(max);
    expect(Array.from((await a.receive()) ?? []).slice(0, 300)).toEqual(Array.from(max).slice(0, 300));

    const total = 64 * 1024 * 1024;
    const chunk = MAX_MESSAGE_BYTES;
    const source = new Uint8Array(total);
    crypto.getRandomValues(source.subarray(0, 65536));
    for (let o = 65536; o < total; o += 65536) source.copyWithin(o, 0, 65536);
    const expected = sha256(source);
    const t0 = performance.now();
    const sender = (async () => {
      for (let o = 0; o < total; o += chunk) await c.send(source.subarray(o, Math.min(o + chunk, total)));
    })();
    const received = new Uint8Array(total);
    let off = 0;
    while (off < total) {
      const m = await a.receive();
      if (!m) throw new Error('early end');
      received.set(m, off);
      off += m.byteLength;
    }
    await sender;
    const ms = performance.now() - t0;
    expect(Array.from(sha256(received))).toEqual(Array.from(expected));
    console.info(
      `in-memory 64 MiB transfer: ${ms.toFixed(0)} ms (${(total / 1024 / 1024 / (ms / 1000)).toFixed(0)} MiB/s)`,
    );
    await a.close();
    expect(await c.receive()).toBeNull();
  });

  it('many concurrent handshakes all authenticate the right peers', async () => {
    const appliance = await generateIdentity();
    const clients = await Promise.all(Array.from({ length: 200 }, () => generateIdentity()));
    const t0 = performance.now();
    const pairs = await Promise.all(clients.map((client) => connectPair({ client, appliance })));
    console.info(`200 concurrent in-memory handshakes: ${(performance.now() - t0).toFixed(0)} ms`);
    pairs.forEach(({ c, a }, i) => {
      expect(c.remotePeerId).toBe(appliance.peerId);
      expect(a.remotePeerId).toBe(clients[i]?.peerId);
    });
    await Promise.all(
      pairs.map(async ({ c, a }, i) => {
        await c.send(enc(`hi ${i}`));
        expect(dec(await a.receive())).toBe(`hi ${i}`);
        await c.close();
      }),
    );
  });
});

describe('identity pinning', () => {
  it('aborts on a wrong appliance PeerId before the client reveals itself or sends any byte after message 1', async () => {
    const { client, appliance } = await identities();
    const impostorExpected = (await generateIdentity()).peerId;
    const [x, y] = memoryByteStreamPair();
    const rec = recording(x);
    const [ci, re] = await Promise.all([
      settle(
        openInitiator({ stream: rec.stream, identity: client, expectedAppliancePeerId: impostorExpected }),
      ),
      settle(acceptResponder({ stream: y, identity: appliance })),
    ]);
    expect(codeOf(ci)).toBe('PEER_MISMATCH');
    expect(re.ok).toBe(false);
    // Only Noise message A (2-byte length + 32-byte ephemeral) left the client: no identity, no app data.
    expect(rec.written.reduce((n, c) => n + c.byteLength, 0)).toBe(34);
  });

  it('pins by claim-card fingerprint, and aborts before app data on a fingerprint mismatch', async () => {
    const { client, appliance } = await identities();
    {
      const [x, y] = memoryByteStreamPair();
      const [c, a] = await Promise.all([
        openInitiator({
          stream: x,
          identity: client,
          expectedApplianceFingerprint: fingerprint(appliance.peerId).toLowerCase().replaceAll('-', ' '),
        }),
        acceptResponder({ stream: y, identity: appliance }),
      ]);
      await c.send(enc('ok'));
      expect(dec(await a.receive())).toBe('ok');
      await c.close();
    }
    {
      const [x, y] = memoryByteStreamPair();
      const other = await generateIdentity();
      const [ci, re] = await Promise.all([
        settle(
          openInitiator({
            stream: x,
            identity: client,
            expectedApplianceFingerprint: fingerprint(other.peerId),
          }),
        ),
        settle(acceptResponder({ stream: y, identity: appliance })),
      ]);
      expect(codeOf(ci)).toBe('PEER_MISMATCH');
      // The responder completed the handshake but receives no message: the connection just fails.
      if (re.ok) {
        const r = await settle(re.value.receive());
        expect(r.ok).toBe(false);
      }
    }
  });

  it('requires exactly one pin', async () => {
    const { client, appliance } = await identities();
    const [x] = memoryByteStreamPair();
    await expect(openInitiator({ stream: x, identity: client })).rejects.toMatchObject({
      code: 'PEER_MISMATCH',
    });
    const [y] = memoryByteStreamPair();
    await expect(
      openInitiator({
        stream: y,
        identity: client,
        expectedAppliancePeerId: appliance.peerId,
        expectedApplianceFingerprint: fingerprint(appliance.peerId),
      }),
    ).rejects.toMatchObject({ code: 'PEER_MISMATCH' });
    const [z] = memoryByteStreamPair();
    await expect(
      openInitiator({ stream: z, identity: client, expectedAppliancePeerId: 'not-a-peer-id' }),
    ).rejects.toMatchObject({ code: 'PEER_MISMATCH' });
  });

  it('exposes an unknown client identity to the responder, whose policy can refuse it', async () => {
    const { a, c, client } = await connectPair();
    const enrolled = new Set<string>([(await generateIdentity()).peerId]);
    expect(enrolled.has(a.remotePeerId)).toBe(false);
    expect(a.remotePeerId).toBe(client.peerId);
    a.abort(new Error('not enrolled'));
    const r = await settle(c.receive());
    expect(r.ok).toBe(false);
    expect(await c.closed).toBeInstanceOf(SecureChannelError);
  });

  it('rejects a client whose identity is not Ed25519', async () => {
    const { client } = await identities();
    const secp = await generateKeyPair('secp256k1');
    const evil = noise({ prologueBytes: enc(DEFAULT_PROLOGUE) })({
      peerId: peerIdFromPrivateKey(secp),
      privateKey: secp,
      logger: silentComponentLogger,
      upgrader: { getStreamMuxers: () => new Map() } as never,
    });
    const [x, y] = memoryByteStreamPair();
    const evilSide = settle(
      evil.secureOutbound(
        new ByteStreamMessageStream(x, {
          direction: 'outbound',
          maxReadBufferLength: 1 << 22,
          maxChunkBytes: 1 << 16,
        }),
        {
          skipStreamMuxerNegotiation: true,
        },
      ),
    );
    const re = await settle(acceptResponder({ stream: y, identity: client }));
    expect(codeOf(re)).toBe('HANDSHAKE_FAILED');
    await evilSide;
  });
});

describe('handshake binding and early data', () => {
  it('a peer of another protocol version (prologue) fails the handshake with VERSION_MISMATCH (review N-1)', async () => {
    expect(DEFAULT_PROLOGUE).toBe('whombat-secure-session/2');
    const { client, appliance } = await identities();
    // New client against a /1 appliance (contracts <= 0.5.0 speak whombat-secure-session/1).
    {
      const [x, y] = memoryByteStreamPair();
      const [ci, re] = await Promise.all([
        settle(openInitiator({ stream: x, identity: client, expectedAppliancePeerId: appliance.peerId })),
        settle(acceptResponder({ stream: y, identity: appliance, prologue: 'whombat-secure-session/1' })),
      ]);
      expect(codeOf(ci)).toBe('VERSION_MISMATCH');
      expect((ci as { error: Error }).error.message).toMatch(/whombat-secure-session\/2/);
      expect(re.ok).toBe(false);
    }
    // A /1 client against the new appliance: the appliance never completes a handshake (no session, no
    // application byte), the old client fails at message 2.
    {
      const [x, y] = memoryByteStreamPair();
      const [ci, re] = await Promise.all([
        settle(
          openInitiator({
            stream: x,
            identity: client,
            expectedAppliancePeerId: appliance.peerId,
            prologue: 'whombat-secure-session/1',
          }),
        ),
        settle(acceptResponder({ stream: y, identity: appliance, limits: { handshakeTimeoutMs: 2000 } })),
      ]);
      expect(codeOf(ci)).toBe('VERSION_MISMATCH');
      expect(codeOf(re)).toBe('HANDSHAKE_FAILED');
    }
  });

  it('rejects handshake extension payloads (no early data)', async () => {
    const { client, appliance } = await identities();
    // A responder built from the same library that stuffs data into the handshake extensions.
    const evil = noise({
      prologueBytes: enc(DEFAULT_PROLOGUE),
      extensions: { webtransportCerthashes: [enc('smuggled application bytes')] },
    })({
      peerId: peerIdFromPrivateKey(appliance.privateKey),
      privateKey: appliance.privateKey,
      logger: silentComponentLogger,
      upgrader: { getStreamMuxers: () => new Map() } as never,
    });
    const [x, y] = memoryByteStreamPair();
    const evilSide = settle(
      evil.secureInbound(
        new ByteStreamMessageStream(y, {
          direction: 'inbound',
          maxReadBufferLength: 1 << 22,
          maxChunkBytes: 1 << 16,
        }),
        {
          skipStreamMuxerNegotiation: true,
        },
      ),
    );
    const ci = await settle(
      openInitiator({ stream: x, identity: client, expectedAppliancePeerId: appliance.peerId }),
    );
    expect(codeOf(ci)).toBe('EARLY_DATA');
    await evilSide;
  });

  it('times out a handshake the peer never answers', async () => {
    const { client, appliance } = await identities();
    const [x] = memoryByteStreamPair();
    const t0 = performance.now();
    const r = await settle(
      openInitiator({
        stream: x,
        identity: client,
        expectedAppliancePeerId: appliance.peerId,
        limits: { handshakeTimeoutMs: 200 },
      }),
    );
    expect(codeOf(r)).toBe('HANDSHAKE_TIMEOUT');
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('fails closed without a CSPRNG', async () => {
    const { client, appliance } = await identities();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const [x] = memoryByteStreamPair();
      await expect(
        openInitiator({ stream: x, identity: client, expectedAppliancePeerId: appliance.peerId }),
      ).rejects.toMatchObject({ code: 'NO_SECURE_RANDOM' });
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: (a: Uint8Array) => a.fill(0) },
        configurable: true,
      });
      await expect(generateIdentity()).rejects.toMatchObject({ code: 'NO_SECURE_RANDOM' });
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

describe('limits', () => {
  it('refuses oversize sends and receives without allocating the claimed size', async () => {
    const { c, a } = await connectPair({ applianceLimits: { maxMessageBytes: 1024 } });
    await expect(c.send(new Uint8Array(MAX_MESSAGE_BYTES + 1))).rejects.toMatchObject({
      code: 'FRAME_TOO_LARGE',
    });
    await c.send(new Uint8Array(1024));
    expect((await a.receive())?.byteLength).toBe(1024);
    // The client's limit allows 2000 bytes; the appliance's does not: it fails on the record header.
    await c.send(new Uint8Array(2000));
    const r = await settle(a.receive());
    expect(codeOf(r)).toBe('FRAME_TOO_LARGE');
    expect(await a.closed).toMatchObject({ code: 'FRAME_TOO_LARGE' });
    await expect(connectPair({ clientLimits: { maxMessageBytes: MAX_MESSAGE_BYTES + 1 } })).rejects.toThrow(
      RangeError,
    );
  });

  it('requires a rekey after the message, byte and age thresholds, and a fresh handshake works', async () => {
    const { client, appliance } = await identities();
    const first = await connectPair({ client, appliance, clientLimits: { rekey: { maxMessages: 3 } } });
    for (let i = 0; i < 3; i++) await first.c.send(enc(`m${i}`));
    await expect(first.c.send(enc('m3'))).rejects.toMatchObject({
      code: 'REKEY_REQUIRED',
      reason: 'messages',
    });
    expect(first.c.rekeyRequired).toBe(true);
    for (let i = 0; i < 3; i++) expect(dec(await first.a.receive())).toBe(`m${i}`);
    await first.c.close();

    const second = await connectPair({ client, appliance, clientLimits: { rekey: { maxBytes: 10 } } });
    expect(second.c.stats().messagesSent).toBe(0);
    await second.c.send(new Uint8Array(10));
    await expect(second.c.send(new Uint8Array(1))).rejects.toMatchObject({ reason: 'bytes' });
    await second.c.close();

    let now = 1_000;
    const third = await connectPair({
      client,
      appliance,
      clientLimits: { rekey: { maxAgeMs: 60_000 }, now: () => now },
    });
    await third.c.send(enc('fresh'));
    expect(dec(await third.a.receive())).toBe('fresh');
    now += 60_000;
    await expect(third.c.send(enc('stale'))).rejects.toMatchObject({ reason: 'age' });
    await third.c.close();
  });

  it('requires a rekey before the Noise nonce space can run out', async () => {
    const { c, a } = await connectPair();
    await c.send(enc('before'));
    expect(dec(await a.receive())).toBe('before');
    // Simulate a connection that has used almost half the 32-bit nonce space libp2p-noise allows.
    (c as unknown as { counters: { framesSent: number } }).counters.framesSent = FRAME_CEILING - 1;
    await expect(c.send(enc('after'))).rejects.toMatchObject({ code: 'REKEY_REQUIRED', reason: 'messages' });
    expect(FRAME_CEILING).toBeLessThan(2 ** 32 - 1);
    await c.close();
  });

  it('applies backpressure to a fast sender when the receiver does not read (bounded memory)', async () => {
    const { c, a } = await connectPair({ applianceLimits: { receiveWindowBytes: 256 * 1024 } });
    let acceptedBytes = 0;
    let stop = false;
    const msg = new Uint8Array(MAX_MESSAGE_BYTES);
    const sender = (async () => {
      while (!stop && acceptedBytes < 256 * 1024 * 1024) {
        await c.send(msg);
        acceptedBytes += msg.byteLength;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    const stalledAt = acceptedBytes;
    await new Promise((r) => setTimeout(r, 300));
    // The sender is blocked by the receiver's 256 KiB flow-control window.
    expect(acceptedBytes).toBe(stalledAt);
    expect(acceptedBytes).toBeLessThanOrEqual(256 * 1024);
    console.info(`backpressure: sender blocked after ${(acceptedBytes / 1024).toFixed(0)} KiB in flight`);
    stop = true;
    let received = 0;
    while (received < acceptedBytes) {
      const m = await a.receive();
      received += m?.byteLength ?? 0;
    }
    await sender;
    while (received < acceptedBytes) received += (await a.receive())?.byteLength ?? 0;
    expect(received).toBe(acceptedBytes);
    await c.close();
  });

  it('distinguishes an authenticated close from a truncated transport', async () => {
    const [x, y] = memoryByteStreamPair();
    const { c, a } = await connectPair({ streams: { client: x, appliance: y } });
    await c.send(enc('last'));
    // Cut the transport without the close record.
    await new Promise((r) => setTimeout(r, 20));
    await x.close();
    expect(dec(await a.receive())).toBe('last');
    const r = await settle(a.receive());
    expect(codeOf(r)).toBe('TRUNCATED');
    expect(await c.send(enc('x')).catch((e: SecureChannelError) => e.code)).toMatch(
      /CLOSED|TRUNCATED|TRANSPORT_ERROR/,
    );
  });

  it('refuses sends after close', async () => {
    const { c, a } = await connectPair();
    await c.close();
    await expect(c.send(enc('x'))).rejects.toMatchObject({ code: 'CLOSED' });
    expect(await a.receive()).toBeNull();
    await expect(a.send(enc('x'))).rejects.toMatchObject({ code: 'CLOSED' });
  });
});
