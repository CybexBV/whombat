import { nodeCrypto } from '@libp2p/noise/crypto';
import { describe, expect, it } from 'vitest';
import { PINNED_DEPENDENCIES } from '../src/index.js';
import { nodeNoiseCrypto, verifyInstalledDependencies } from '../src/node/index.js';
import { connectPair, dec, enc, mitmPair, settle } from './support.js';

describe('nodeNoiseCrypto (review L-7)', () => {
  it('uses OpenSSL ChaCha20-Poly1305 at every size (not @chainsafe/as-chacha20poly1305)', () => {
    expect(nodeNoiseCrypto.chaCha20Poly1305Encrypt).toBe(nodeCrypto.chaCha20Poly1305Encrypt);
    expect(nodeNoiseCrypto.chaCha20Poly1305Decrypt).toBe(nodeCrypto.chaCha20Poly1305Decrypt);
    expect(nodeNoiseCrypto.hashSHA256).toBe(nodeCrypto.hashSHA256);
  });

  it('interoperates with the pure-JS default and detects tampering', async () => {
    const { c, a } = await connectPair({ clientCrypto: nodeNoiseCrypto });
    for (const m of ['small', 'x'.repeat(5000)]) {
      await c.send(enc(m));
      expect(dec(await a.receive())).toBe(m);
      await a.send(enc(m));
      expect(dec(await c.receive())).toBe(m);
    }
    await c.close();
    const streams = mitmPair((dir, chunk, i) => {
      if (dir === 'c2a' && i === 2) {
        const x = chunk.slice();
        x[4] = (x[4] ?? 0) ^ 1;
        return [x];
      }
      return [chunk];
    });
    // The tampered frame is the client's first transport frame; the appliance may meet it while its handshake
    // call is still returning, so the failure surfaces from acceptResponder or from the connection.
    const t = await settle(
      connectPair({ streams, clientCrypto: nodeNoiseCrypto, applianceCrypto: nodeNoiseCrypto }),
    );
    const code = t.ok ? (await t.value.a.closed)?.code : (t.error as { code: string }).code;
    expect(code).toBe('DECRYPT_FAILED');
  });
});

describe('dependency pins (review L-8)', () => {
  it('the installed closure is exactly the reviewed set', () => {
    expect(verifyInstalledDependencies()).toEqual([]);
    expect(Object.keys(PINNED_DEPENDENCIES)).toContain('@noble/ciphers');
  });
});
