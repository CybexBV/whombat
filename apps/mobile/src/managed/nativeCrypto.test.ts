import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeAead, Sha256 } from '../../modules/whombat-crypto';
import {
  checkedNativeCrypto,
  checkedNativeSha256,
  nativeNoiseCrypto,
  resetCheckedNativeCrypto,
  selfTest,
  sha256SelfTest,
} from './nativeCrypto';

// The module's Expo import doesn't load under Node; the tests hand the cipher in.
vi.mock('../../modules/whombat-crypto', () => ({
  nativeChaCha20Poly1305: () => null,
  nativeSha256: () => null,
}));

/** Node's ChaCha20-Poly1305 in the native module's shape (ciphertext ‖ tag), as `javax.crypto` returns it. */
const nodeAead: NativeAead = {
  seal(key, nonce, ad, plaintext) {
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(ad, { plaintextLength: plaintext.byteLength });
    return new Uint8Array(Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]));
  },
  open(key, nonce, ad, sealed) {
    const ct = sealed.subarray(0, sealed.byteLength - 16);
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAAD(ad, { plaintextLength: ct.byteLength });
    d.setAuthTag(sealed.subarray(sealed.byteLength - 16));
    return new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
  },
};

afterEach(() => resetCheckedNativeCrypto());

describe('native AEAD (AP-890)', () => {
  it('matches the pure-JS cipher both ways and rejects a tampered message', () => {
    expect(selfTest(nativeNoiseCrypto(nodeAead))).toBeNull();
  });

  it('is refused when its output differs', () => {
    const off: NativeAead = {
      ...nodeAead,
      seal: (k, n, a, p) => {
        const out = nodeAead.seal(k, n, a, p);
        if (out.byteLength > 0) out[0] = (out[0] ?? 0) ^ 1;
        return out;
      },
    };
    expect(selfTest(nativeNoiseCrypto(off))).toBe('ciphertext differs at 0');
  });

  it('is refused when it accepts a flipped bit', () => {
    const lax: NativeAead = {
      ...nodeAead,
      open: (k, n, a, sealed) => {
        try {
          return nodeAead.open(k, n, a, sealed);
        } catch {
          return new Uint8Array(sealed.byteLength - 16);
        }
      },
    };
    expect(selfTest(nativeNoiseCrypto(lax))).toBe('tampered ciphertext accepted');
  });

  it('checks once per process and falls back to pure JS without the module (AP-891)', () => {
    let asked = 0;
    const source = () => {
      asked++;
      return nodeAead;
    };
    const first = checkedNativeCrypto(source);
    expect(first).not.toBeNull();
    expect(checkedNativeCrypto(source)).toBe(first);
    expect(asked).toBe(1);
    resetCheckedNativeCrypto();
    expect(checkedNativeCrypto(() => null)).toBeNull();
  });
});

/** Node's SHA-256 in the native module's shape, as CryptoKit and `MessageDigest` run it. */
const nodeHash = (): Sha256 => {
  const h = createHash('sha256');
  const self: Sha256 = {
    update(data) {
      h.update(data);
      return self;
    },
    digest: () => new Uint8Array(h.digest()),
  };
  return self;
};

describe('native SHA-256', () => {
  it('matches the pure-JS hash, whole and in pieces', () => {
    expect(sha256SelfTest(nodeHash)).toBeNull();
  });

  it('is refused when a piece is lost or it hashes otherwise', () => {
    const firstPieceOnly = (): Sha256 => {
      const h = nodeHash();
      let fed = false;
      const self: Sha256 = {
        update(data) {
          if (!fed) h.update(data);
          fed = true;
          return self;
        },
        digest: () => h.digest(),
      };
      return self;
    };
    expect(sha256SelfTest(firstPieceOnly)).toMatch(/^pieces differ/);
    const wrong = (): Sha256 => ({ update: () => wrong(), digest: () => new Uint8Array(32) });
    expect(sha256SelfTest(wrong)).toMatch(/^hash differs/);
  });

  it('checks once per process and keeps pure JS without the module', () => {
    let asked = 0;
    const source = () => {
      asked++;
      return nodeHash;
    };
    expect(checkedNativeSha256(source)).toBe(nodeHash);
    expect(checkedNativeSha256(source)).toBe(nodeHash);
    expect(asked).toBe(1);
    resetCheckedNativeCrypto();
    expect(checkedNativeSha256(() => null)).toBeNull();
  });
});
