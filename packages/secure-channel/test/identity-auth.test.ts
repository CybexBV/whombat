import { readFileSync } from 'node:fs';
import {
  generateKeyPair,
  privateKeyToProtobuf,
  publicKeyFromRaw,
  publicKeyToProtobuf,
} from '@libp2p/crypto/keys';
import type { PrivateKey, PublicKey } from '@libp2p/interface';
import { noise, pureJsCrypto } from '@libp2p/noise';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyEd25519Strict } from '@whombat/core/audit';
import { describe, expect, it } from 'vitest';
import {
  checkHandshakePayload,
  type IdentityRejected,
  verifyEd25519StrictLocal,
} from '../src/identity-guard.js';
import {
  acceptResponder,
  type ByteStream,
  DEFAULT_PROLOGUE,
  deserializeIdentity,
  fingerprint,
  generateIdentity,
  generateWebCryptoIdentity,
  identityFromCryptoKeyPair,
  isStrongEd25519PublicKey,
  memoryByteStreamPair,
  openInitiator,
  type SecureChannelError,
} from '../src/index.js';
import { ByteStreamMessageStream, silentComponentLogger } from '../src/message-stream.js';
import { dec, enc, settle } from './support.js';

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const codeOf = (r: { ok: boolean; error?: unknown }) => (r.ok ? 'ok' : (r.error as SecureChannelError).code);

/** Count bytes one side writes. */
function tap(stream: ByteStream): { stream: ByteStream; written: () => number } {
  let n = 0;
  return {
    written: () => n,
    stream: {
      read: () => stream.read(),
      write: (c) => {
        n += c.byteLength;
        return stream.write(c);
      },
      drained: () => stream.drained(),
      close: () => stream.close(),
      abort: (r) => stream.abort(r),
    },
  };
}

/**
 * The upstream Noise encrypter with an arbitrary libp2p private-key object and NO checks of ours: what an
 * attacker speaking the protocol directly can do, and the library's own behaviour as a regression target.
 */
function rawNoise(privateKey: unknown, publicKey: PublicKey) {
  return noise({ prologueBytes: enc(DEFAULT_PROLOGUE), crypto: pureJsCrypto })({
    peerId: peerIdFromPublicKey(publicKey),
    privateKey: privateKey as PrivateKey,
    logger: silentComponentLogger,
    upgrader: { getStreamMuxers: () => new Map() } as never,
  } as never);
}
const rawStream = (s: ByteStream, direction: 'inbound' | 'outbound') =>
  new ByteStreamMessageStream(s, { direction, maxReadBufferLength: 1 << 22, maxChunkBytes: 1 << 16 });

/** A key object that claims `victim` but signs with a key of its own: a forged identity binding. */
async function impostorKey(victim: PublicKey) {
  const own = await generateKeyPair('Ed25519');
  return { type: 'Ed25519', publicKey: victim, raw: own.raw, sign: (d: Uint8Array) => own.sign(d) };
}

/** The eight points of the Ed25519 torsion subgroup (all small order), encoded. */
function torsionPoints(): Uint8Array[] {
  const order8 = ed25519.Point.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a');
  const points: Uint8Array[] = [];
  let p = ed25519.Point.ZERO;
  for (let i = 0; i < 8; i++) {
    points.push(p.toBytes());
    p = p.add(order8);
  }
  return points;
}

/** A "keyless" identity: a small-order key and a signature that verifies for any message under lax rules. */
function keylessKey(point: Uint8Array) {
  const publicKey = publicKeyFromRaw(point);
  const sig = new Uint8Array(64);
  sig.set(ed25519.Point.ZERO.toBytes(), 0); // R = identity, S = 0
  return { key: { type: 'Ed25519', publicKey, raw: new Uint8Array(64), sign: async () => sig }, publicKey };
}

describe('identity authentication (review M-3)', () => {
  it('client rejects an impostor claiming the pinned appliance key with a bad signature, after 34 bytes', async () => {
    const appliance = await generateIdentity();
    const client = await generateIdentity();
    for (const pin of ['peerId', 'fingerprint'] as const) {
      const [x, y] = memoryByteStreamPair();
      const t = tap(x);
      const impostor = rawNoise(
        await impostorKey(appliance.privateKey.publicKey),
        appliance.privateKey.publicKey,
      );
      const imp = settle(
        impostor.secureInbound(rawStream(y, 'inbound'), { skipStreamMuxerNegotiation: true }),
      );
      const c = await settle(
        openInitiator({
          stream: t.stream,
          identity: client,
          ...(pin === 'peerId'
            ? { expectedAppliancePeerId: appliance.peerId }
            : { expectedApplianceFingerprint: fingerprint(appliance.peerId) }),
        }),
      );
      expect(codeOf(c)).toBe('PEER_MISMATCH');
      // Message 1 only: the client's identity (message 3) and application data never left.
      expect(t.written()).toBe(34);
      await imp;
    }
  });

  it('appliance rejects an initiator claiming an enrolled endpoint key with a bad signature', async () => {
    const appliance = await generateIdentity();
    const enrolled = await generateIdentity();
    const [x, y] = memoryByteStreamPair();
    const attacker = rawNoise(
      await impostorKey(enrolled.privateKey.publicKey),
      enrolled.privateKey.publicKey,
    );
    const [, a] = await Promise.all([
      settle(attacker.secureOutbound(rawStream(x, 'outbound'), { skipStreamMuxerNegotiation: true })),
      settle(acceptResponder({ stream: y, identity: appliance })),
    ]);
    expect(codeOf(a)).toBe('HANDSHAKE_FAILED');
    expect((a as { error: Error }).error.message).toMatch(/signature/);
  });

  it('the pinned upstream library alone verifies the identity signature (dependency regression gate)', async () => {
    // No wrapper of ours on either side: if an @libp2p/noise update stops verifying the signed static key
    // (CVE-2022-24759 class), this test fails even though our own checks would still catch it.
    const victim = await generateKeyPair('Ed25519');
    const honest = await generateKeyPair('Ed25519');
    {
      const [x, y] = memoryByteStreamPair();
      const imp = rawNoise(await impostorKey(victim.publicKey), victim.publicKey);
      const real = rawNoise(honest, honest.publicKey);
      const [, r] = await Promise.all([
        settle(
          imp.secureOutbound(rawStream(x, 'outbound'), {
            skipStreamMuxerNegotiation: true,
            signal: AbortSignal.timeout(2000),
          }),
        ),
        settle(
          real.secureInbound(rawStream(y, 'inbound'), {
            skipStreamMuxerNegotiation: true,
            signal: AbortSignal.timeout(2000),
          }),
        ),
      ]);
      expect(r.ok).toBe(false);
      expect((r as { error: Error }).error.name).toBe('UnexpectedPeerError');
    }
    {
      const [x, y] = memoryByteStreamPair();
      const imp = rawNoise(await impostorKey(victim.publicKey), victim.publicKey);
      const real = rawNoise(honest, honest.publicKey);
      const [i] = await Promise.all([
        settle(
          real.secureOutbound(rawStream(x, 'outbound'), {
            skipStreamMuxerNegotiation: true,
            signal: AbortSignal.timeout(2000),
            remotePeer: peerIdFromPublicKey(victim.publicKey),
          }),
        ),
        settle(
          imp.secureInbound(rawStream(y, 'inbound'), {
            skipStreamMuxerNegotiation: true,
            signal: AbortSignal.timeout(2000),
          }),
        ),
      ]);
      expect(i.ok).toBe(false);
      expect((i as { error: Error }).error.name).toBe('UnexpectedPeerError');
    }
  });

  it('a hostile relay that terminates Noise on both legs cannot substitute either peer', async () => {
    const appliance = await generateIdentity();
    const client = await generateIdentity();
    const relayKey = await generateIdentity();
    // Leg 1: client <-> relay. The relay answers with its own identity: the pin fails after message 1.
    const [cx, rx] = memoryByteStreamPair();
    const t = tap(cx);
    const [c1, r1] = await Promise.all([
      settle(
        openInitiator({ stream: t.stream, identity: client, expectedAppliancePeerId: appliance.peerId }),
      ),
      settle(acceptResponder({ stream: rx, identity: relayKey })),
    ]);
    expect(codeOf(c1)).toBe('PEER_MISMATCH');
    expect(t.written()).toBe(34);
    expect(r1.ok).toBe(false);
    // Leg 2: relay <-> appliance as itself: the appliance authenticates the relay's key, not the client's.
    const [ry, ay] = memoryByteStreamPair();
    const [r2, a2] = await Promise.all([
      settle(openInitiator({ stream: ry, identity: relayKey, expectedAppliancePeerId: appliance.peerId })),
      settle(acceptResponder({ stream: ay, identity: appliance })),
    ]);
    expect(r2.ok && a2.ok).toBe(true);
    if (a2.ok) expect(a2.value.remotePeerId).not.toBe(client.peerId);
    if (r2.ok) await r2.value.close();
    // Leg 2 claiming the client's identity (it has no signature for it): refused.
    const [rz, az] = memoryByteStreamPair();
    const forged = rawNoise(await impostorKey(client.privateKey.publicKey), client.privateKey.publicKey);
    const [, a3] = await Promise.all([
      settle(forged.secureOutbound(rawStream(rz, 'outbound'), { skipStreamMuxerNegotiation: true })),
      settle(acceptResponder({ stream: az, identity: appliance })),
    ]);
    expect(codeOf(a3)).toBe('HANDSHAKE_FAILED');
  });
});

describe('weak and foreign identity keys (review L-1, L-5)', () => {
  it('rejects all eight small-order ("keyless") Ed25519 identities as initiator', async () => {
    const appliance = await generateIdentity();
    const points = torsionPoints();
    expect(new Set(points.map((p) => Buffer.from(p).toString('hex'))).size).toBe(8);
    for (const point of points) {
      const { key, publicKey } = keylessKey(point);
      const [x, y] = memoryByteStreamPair();
      const [, a] = await Promise.all([
        settle(
          rawNoise(key, publicKey).secureOutbound(rawStream(x, 'outbound'), {
            skipStreamMuxerNegotiation: true,
          }),
        ),
        settle(acceptResponder({ stream: y, identity: appliance })),
      ]);
      expect(codeOf(a)).toBe('HANDSHAKE_FAILED');
      expect((a as { error: Error }).error.message).toMatch(/small order|non-canonical/);
    }
  });

  it('client refuses a small-order responder identity before sending message 3', async () => {
    const client = await generateIdentity();
    const appliance = await generateIdentity();
    const { key, publicKey } = keylessKey(torsionPoints()[0] as Uint8Array);
    const [x, y] = memoryByteStreamPair();
    const t = tap(x);
    const r = settle(
      rawNoise(key, publicKey).secureInbound(rawStream(y, 'inbound'), { skipStreamMuxerNegotiation: true }),
    );
    const c = await settle(
      openInitiator({ stream: t.stream, identity: client, expectedAppliancePeerId: appliance.peerId }),
    );
    expect(codeOf(c)).toBe('PEER_MISMATCH');
    expect(t.written()).toBe(34);
    await r;
  });

  it('rejects a non-canonically encoded identity key', async () => {
    const appliance = await generateIdentity();
    // y = p + 1: a non-canonical encoding of the identity point.
    const nonCanonical = hex('eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');
    expect(isStrongEd25519PublicKey(nonCanonical)).toBe(false);
    const { key, publicKey } = keylessKey(nonCanonical);
    const [x, y] = memoryByteStreamPair();
    const [, a] = await Promise.all([
      settle(
        rawNoise(key, publicKey).secureOutbound(rawStream(x, 'outbound'), {
          skipStreamMuxerNegotiation: true,
        }),
      ),
      settle(acceptResponder({ stream: y, identity: appliance })),
    ]);
    expect(codeOf(a)).toBe('HANDSHAKE_FAILED');
    expect((a as { error: Error }).error.message).toMatch(/non-canonical or of small order/);
  });

  it('rejects an RSA identity before the library parses or verifies it', async () => {
    const appliance = await generateIdentity();
    const rsa = await generateKeyPair('RSA', 2048);
    const [x, y] = memoryByteStreamPair();
    const [, a] = await Promise.all([
      settle(
        rawNoise(rsa, rsa.publicKey).secureOutbound(rawStream(x, 'outbound'), {
          skipStreamMuxerNegotiation: true,
        }),
      ),
      settle(acceptResponder({ stream: y, identity: appliance })),
    ]);
    expect(codeOf(a)).toBe('HANDSHAKE_FAILED');
    // Our guard's message: the payload was refused on its key type, not by upstream's RSA verify.
    expect((a as { error: Error }).error.message).toBe('identity key type 0 is not Ed25519');
  });

  it('agrees with core verifyEd25519Strict (CT-15) on the conformance vectors and the torsion points', () => {
    const vectors = JSON.parse(
      readFileSync(new URL('../../../contracts/vectors/signed.json', import.meta.url), 'utf8'),
    ) as {
      ed25519: { name: string; publicKey: string; message: string; signature: string; expect: boolean }[];
    };
    expect(vectors.ed25519.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors.ed25519) {
      const args = [hex(v.signature), hex(v.message), hex(v.publicKey)] as const;
      expect(verifyEd25519StrictLocal(...args), v.name).toBe(v.expect);
      expect(verifyEd25519Strict(...args), v.name).toBe(v.expect);
    }
    for (const point of torsionPoints()) {
      expect(isStrongEd25519PublicKey(point)).toBe(false);
      const sig = new Uint8Array(64);
      sig.set(ed25519.Point.ZERO.toBytes());
      expect(verifyEd25519StrictLocal(sig, enc('m'), point)).toBe(false);
      expect(verifyEd25519Strict(sig, enc('m'), point)).toBe(false);
    }
  });
});

describe('handshake payload guard (unit)', () => {
  async function validPayload() {
    const key = await generateKeyPair('Ed25519');
    const rs = crypto.getRandomValues(new Uint8Array(32));
    const msg = new Uint8Array([...enc('noise-libp2p-static-key:'), ...rs]);
    const sig = await key.sign(msg);
    const idKey = publicKeyToProtobuf(key.publicKey);
    const payload = (extra: number[] = []) =>
      Uint8Array.from([0x0a, idKey.length, ...idKey, 0x12, sig.length, ...sig, ...extra]);
    return { key, rs, sig, idKey, payload };
  }

  it('accepts a valid payload (with or without empty extensions) and returns the key', async () => {
    const { key, rs, payload } = await validPayload();
    expect(Array.from(checkHandshakePayload(payload(), rs))).toEqual(Array.from(key.publicKey.raw));
    expect(checkHandshakePayload(payload([0x22, 0x00]), rs)).toHaveLength(32);
    expect(checkHandshakePayload(payload(), rs, key.publicKey.raw)).toHaveLength(32);
  });

  it('refuses bad signatures, wrong static keys, pins, extensions, unknown or repeated fields', async () => {
    const { rs, payload, sig } = await validPayload();
    const kind = (f: () => unknown) => {
      try {
        f();
        return 'accepted';
      } catch (e) {
        return (e as IdentityRejected).kind;
      }
    };
    const otherRs = rs.slice();
    otherRs[0] = (otherRs[0] ?? 0) ^ 1;
    expect(kind(() => checkHandshakePayload(payload(), otherRs))).toBe('signature');
    const badSig = payload();
    badSig[badSig.length - 1] = (badSig[badSig.length - 1] ?? 0) ^ 1;
    expect(kind(() => checkHandshakePayload(badSig, rs))).toBe('signature');
    expect(kind(() => checkHandshakePayload(payload(), rs, new Uint8Array(32).fill(9)))).toBe('pin');
    expect(kind(() => checkHandshakePayload(payload([0x22, 0x02, 0x0a, 0x00]), rs))).toBe('early-data');
    expect(kind(() => checkHandshakePayload(payload([0x2a, 0x01, 0x00]), rs))).toBe('early-data');
    expect(kind(() => checkHandshakePayload(payload([0x12, 0x40, ...sig]), rs))).toBe('payload');
    expect(kind(() => checkHandshakePayload(Uint8Array.from([0x0a, 0x80]), rs))).toBe('payload');
    expect(kind(() => checkHandshakePayload(new Uint8Array(0), rs))).toBe('payload');
  });
});

describe('identity helpers (review I-1, I-2, I-7)', () => {
  it('refuses a stored key whose public half does not match its seed', async () => {
    const a = await generateKeyPair('Ed25519');
    const b = await generateKeyPair('Ed25519');
    const bytes = privateKeyToProtobuf(a);
    bytes.set(b.publicKey.raw, bytes.length - 32);
    expect(() => deserializeIdentity(bytes)).toThrow(/does not match/);
  });

  it('accepts a CID-form pin of the right appliance; a malformed or weak pin writes nothing', async () => {
    const appliance = await generateIdentity();
    const client = await generateIdentity();
    const cid = peerIdFromString(appliance.peerId).toCID().toString();
    const [x, y] = memoryByteStreamPair();
    const [c] = await Promise.all([
      openInitiator({ stream: x, identity: client, expectedAppliancePeerId: cid }),
      acceptResponder({ stream: y, identity: appliance }),
    ]);
    expect(c.remotePeerId).toBe(appliance.peerId);
    await c.close();
    const weak = peerIdFromPublicKey(publicKeyFromRaw(torsionPoints()[1] as Uint8Array)).toString();
    for (const pin of ['nonsense', weak]) {
      const [p] = memoryByteStreamPair();
      const t = tap(p);
      const r = await settle(
        openInitiator({ stream: t.stream, identity: client, expectedAppliancePeerId: pin }),
      );
      expect(codeOf(r)).toBe('PEER_MISMATCH');
      expect(t.written()).toBe(0);
    }
    const [q] = memoryByteStreamPair();
    const tq = tap(q);
    const r = await settle(
      openInitiator({ stream: tq.stream, identity: client, expectedApplianceFingerprint: 'AAAA' }),
    );
    expect(codeOf(r)).toBe('PEER_MISMATCH');
    expect(tq.written()).toBe(0);
  });

  it('refuses an extractable WebCrypto private key unless asked for', async () => {
    const { keyPair } = await generateWebCryptoIdentity({ extractable: true });
    await expect(identityFromCryptoKeyPair(keyPair)).rejects.toMatchObject({ code: 'KEY_STORE' });
    const id = await identityFromCryptoKeyPair(keyPair, { allowExtractable: true });
    expect(id.extractable).toBe(false);
    expect(dec(enc('x'))).toBe('x');
  });
});
