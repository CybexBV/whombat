import { describe, expect, it } from 'vitest';
import { INITIAL_WINDOW_BYTES, type SecureChannelError } from '../src/index.js';
import { connectPair, dec, enc, mitmPair, settle, type Tamper } from './support.js';

/** Receive windows at the protocol's initial value: no WINDOW record follows the handshake, so chunk indices
 * below are exactly the handshake messages and then one application record per chunk. */
const FIXED = {
  clientLimits: { receiveWindowBytes: INITIAL_WINDOW_BYTES },
  applianceLimits: { receiveWindowBytes: INITIAL_WINDOW_BYTES },
};

/**
 * A malicious relay splice rewriting transport chunks. Handshake chunks: c2a #0 (msg A), a2c #0 (msg B),
 * c2a #1 (msg C). Each application send afterwards is one chunk = one Noise frame.
 */
async function scenario(tamper: Tamper, sends = ['one', 'two', 'three']) {
  const streams = mitmPair(tamper);
  const pair = await settle(connectPair({ streams, ...FIXED }));
  if (!pair.ok) return { handshake: pair.error as SecureChannelError, received: [] as string[] };
  const { c, a } = pair.value;
  for (const s of sends) await c.send(enc(s)).catch(() => {});
  const received: string[] = [];
  let error: SecureChannelError | undefined;
  for (;;) {
    const r = await settle(a.receive());
    if (!r.ok) {
      error = r.error as SecureChannelError;
      break;
    }
    if (r.value === null) break;
    received.push(dec(r.value));
  }
  return { error, received, closed: await a.closed };
}

const flip = (chunk: Uint8Array, at: number) => {
  const copy = chunk.slice();
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
};

describe('malicious splice', () => {
  it('passes an untouched session (control)', async () => {
    const streams = mitmPair((_dir, chunk) => [chunk]);
    const { c, a } = await connectPair({ streams, ...FIXED });
    for (const s of ['one', 'two', 'three']) await c.send(enc(s));
    await c.close();
    const got: string[] = [];
    for await (const m of a) got.push(dec(m));
    expect(got).toEqual(['one', 'two', 'three']);
    expect(await a.closed).toBeUndefined();
  });

  it('bit flip in a ciphertext frame -> DECRYPT_FAILED, earlier messages intact', async () => {
    const r = await scenario((dir, chunk, i) => (dir === 'c2a' && i === 3 ? [flip(chunk, 10)] : [chunk]));
    expect(r.received).toEqual(['one']);
    expect(r.error?.code).toBe('DECRYPT_FAILED');
    expect(r.closed?.code).toBe('DECRYPT_FAILED');
  });

  it('bit flip in the authentication tag -> DECRYPT_FAILED', async () => {
    const r = await scenario((dir, chunk, i) =>
      dir === 'c2a' && i === 2 ? [flip(chunk, chunk.length - 1)] : [chunk],
    );
    expect(r.received).toEqual([]);
    expect(r.error?.code).toBe('DECRYPT_FAILED');
  });

  it('replayed (duplicated) frame -> DECRYPT_FAILED', async () => {
    const r = await scenario((dir, chunk, i) => (dir === 'c2a' && i === 2 ? [chunk, chunk] : [chunk]));
    expect(r.received).toEqual(['one']);
    expect(r.error?.code).toBe('DECRYPT_FAILED');
  });

  it('reordered frames -> DECRYPT_FAILED', async () => {
    let held: Uint8Array | undefined;
    const r = await scenario((dir, chunk, i) => {
      if (dir !== 'c2a') return [chunk];
      if (i === 2) {
        held = chunk;
        return [];
      }
      if (i === 3 && held) return [chunk, held];
      return [chunk];
    });
    expect(r.received).toEqual([]);
    expect(r.error?.code).toBe('DECRYPT_FAILED');
  });

  it('dropped frame -> the next frame fails (nonce mismatch)', async () => {
    const r = await scenario((dir, chunk, i) => (dir === 'c2a' && i === 3 ? [] : [chunk]));
    expect(r.received).toEqual(['one']);
    expect(r.error?.code).toBe('DECRYPT_FAILED');
  });

  it('frame shorter than the tag -> DECRYPT_FAILED', async () => {
    const r = await scenario((dir, chunk, i) =>
      dir === 'c2a' && i === 3 ? [new Uint8Array([0x00, 0x05, 1, 2, 3, 4, 5])] : [chunk],
    );
    expect(r.received).toEqual(['one']);
    expect(r.error?.code).toBe('DECRYPT_FAILED');
  });

  it('truncated frame then close -> TRUNCATED (never delivered)', async () => {
    const r = await scenario((dir, chunk, i) => {
      if (dir === 'c2a' && i === 3) return [chunk.subarray(0, 9)];
      if (dir === 'c2a' && i > 3) return 'close';
      return [chunk];
    });
    expect(r.received).toEqual(['one']);
    expect(r.error?.code).toBe('TRUNCATED');
  });

  it('dropping the close record -> TRUNCATED, not a clean end', async () => {
    const streams = mitmPair((dir, chunk, i) => (dir === 'c2a' && i === 3 ? 'close' : [chunk]));
    const { c, a } = await connectPair({ streams, ...FIXED });
    await c.send(enc('only'));
    await c.close();
    expect(dec(await a.receive())).toBe('only');
    const r = await settle(a.receive());
    expect((r as { error: SecureChannelError }).error?.code).toBe('TRUNCATED');
  });

  it('tampered handshake message B: static-key part -> VERSION_MISMATCH, payload part -> HANDSHAKE_FAILED', async () => {
    // Message 2 = [u16 len][32 B ephemeral][48 B encrypted static key][encrypted payload]. A tampered static key
    // is indistinguishable from a peer with another prologue (the first encrypted handshake message fails).
    const s1 = await scenario((dir, chunk, i) => (dir === 'a2c' && i === 0 ? [flip(chunk, 60)] : [chunk]));
    expect(s1.handshake?.code).toBe('VERSION_MISMATCH');
    const s2 = await scenario((dir, chunk, i) => (dir === 'a2c' && i === 0 ? [flip(chunk, 100)] : [chunk]));
    expect(s2.handshake?.code).toBe('HANDSHAKE_FAILED');
  });

  it('tampered handshake message C -> HANDSHAKE_FAILED on the appliance', async () => {
    for (let i = 0; i < 10; i++) {
      const streams = mitmPair((dir, chunk, n) => (dir === 'c2a' && n === 1 ? [flip(chunk, 60)] : [chunk]));
      const { generateIdentity, openInitiator, acceptResponder } = await import('../src/index.js');
      const appliance = await generateIdentity();
      const [, a] = await Promise.all([
        settle(
          openInitiator({
            stream: streams.client,
            identity: await generateIdentity(),
            expectedAppliancePeerId: appliance.peerId,
          }),
        ),
        settle(acceptResponder({ stream: streams.appliance, identity: appliance })),
      ]);
      expect((a as { error: SecureChannelError }).error.code).toBe('HANDSHAKE_FAILED');
    }
  });

  it('replayed handshake from an old session cannot open a new one', async () => {
    // Record a whole client flight from session 1 and replay it into session 2's appliance.
    const recorded: Uint8Array[] = [];
    const s1 = mitmPair((dir, chunk) => {
      if (dir === 'c2a') recorded.push(chunk.slice());
      return [chunk];
    });
    const { generateIdentity } = await import('../src/index.js');
    const appliance = await generateIdentity();
    const first = await connectPair({ streams: s1, appliance });
    await first.c.send(enc('secret'));
    expect(dec(await first.a.receive())).toBe('secret');
    await first.c.close();

    const { memoryByteStreamPair, acceptResponder } = await import('../src/index.js');
    const [attacker, applianceSide] = memoryByteStreamPair();
    const accepting = settle(
      acceptResponder({ stream: applianceSide, identity: appliance, limits: { handshakeTimeoutMs: 500 } }),
    );
    for (const c of recorded) attacker.write(c);
    const res = await accepting;
    // Same appliance identity, but msg C was bound to the old responder ephemeral: the replay fails.
    expect(res.ok).toBe(false);
  });
});
