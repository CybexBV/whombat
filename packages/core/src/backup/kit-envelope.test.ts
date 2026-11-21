import { describe, expect, it } from 'vitest';
import {
  fromBase64url,
  KIT_PRF_SALT_V2,
  KIT_PRF_SALT_V2_B64,
  kitKeyFromPrf,
  newKitPrfSalt,
  openKit,
  openKitWithKey,
  PLACE_KIT_RECORD_KIND,
  PlaceKitRecord,
  sealKit,
  sealKitWithKey,
  toBase64url,
} from './kit-envelope.js';

const prf = new Uint8Array(32).map((_, i) => i + 1);
const appliance = '12D3KooWExampleWhombat';
const nonce = new Uint8Array(24).map((_, i) => 0xa0 + i);
const material = '{"kind":"whombat.backup-recovery-material/1"}';

/** Fixed vectors, checked once against Node's own SHA-256 and HKDF. */
const VECTORS = {
  salt: '2RI2EH8wqFcj9KLMi35oIHhH2q4fWvGu-Czr0iSrw-Y',
  key: 't0GhcsCpstSBPL3qreqcW5eo23lMeSLLt6QkotKy9zw',
  envelope:
    'wbkit1.oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3.PCcUYiW45pIXAPRmQggriWSMzUClixuHgIl6WZ5S_EgudL8jgMWH5vSn_f8LVM1I-lVXQZn4rGYp54cdUw',
};

describe('kit envelope', () => {
  it('opens with the same passkey output and Whombat', () => {
    const env = sealKit('the kit', prf, appliance);
    expect(env.startsWith('wbkit1.')).toBe(true);
    expect(openKit(env, prf, appliance)).toBe('the kit');
  });

  it('stays shut for another passkey, another Whombat or a changed byte', () => {
    const env = sealKit('the kit', prf, appliance);
    expect(
      openKit(
        env,
        prf.map((b) => b ^ 1),
        appliance,
      ),
    ).toBeNull();
    expect(openKit(env, prf, 'other')).toBeNull();
    const parts = env.split('.');
    const ct = fromBase64url(parts[2] ?? '') as Uint8Array;
    ct[0] = (ct[0] as number) ^ 1;
    expect(openKit(`${parts[0]}.${parts[1]}.${toBase64url(ct)}`, prf, appliance)).toBeNull();
    expect(openKit('nonsense', prf, appliance)).toBeNull();
  });

  it('refuses a short PRF output', () => {
    expect(() => sealKit('x', new Uint8Array(16), appliance)).toThrow();
  });

  it('base64url round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect(fromBase64url(toBase64url(b))).toEqual(b);
    }
    expect(newKitPrfSalt()).toHaveLength(32);
  });
});

describe('the backup key', () => {
  it('the constant salt is SHA-256 of its phrase', () => {
    expect(KIT_PRF_SALT_V2).toHaveLength(32);
    expect(KIT_PRF_SALT_V2_B64).toBe(VECTORS.salt);
  });

  it('derives the vector key and seals the vector envelope', () => {
    const key = kitKeyFromPrf(prf, appliance);
    expect(toBase64url(key)).toBe(VECTORS.key);
    expect(sealKitWithKey(material, key, appliance, nonce)).toBe(VECTORS.envelope);
  });

  it('an envelope the box sealed with the key opens with the passkey output on a device', () => {
    expect(openKit(VECTORS.envelope, prf, appliance)).toBe(material);
    const key = fromBase64url(VECTORS.key) as Uint8Array;
    expect(openKitWithKey(sealKit(material, prf, appliance), key, appliance)).toBe(material);
  });

  it('is per Whombat: another PeerId gives another key, and its envelope stays shut', () => {
    const other = kitKeyFromPrf(prf, '12D3KooWAnotherWhombat');
    expect(toBase64url(other)).not.toBe(VECTORS.key);
    expect(openKitWithKey(VECTORS.envelope, other, appliance)).toBeNull();
    expect(openKitWithKey(VECTORS.envelope, fromBase64url(VECTORS.key) as Uint8Array, 'other')).toBeNull();
  });

  it('refuses a key or a nonce of the wrong length', () => {
    expect(() => sealKitWithKey('x', new Uint8Array(16), appliance)).toThrow();
    expect(() => sealKitWithKey('x', kitKeyFromPrf(prf, appliance), appliance, new Uint8Array(12))).toThrow();
    expect(openKitWithKey(VECTORS.envelope, new Uint8Array(16), appliance)).toBeNull();
  });
});

describe('a place’s envelope file', () => {
  const record = {
    kind: PLACE_KIT_RECORD_KIND,
    appliance: '12D3KooWBdXx3Cq9hpm8vNrLy8kgLe7Hx1WXDf5wSZ6aw9PUVQhE',
    applianceName: 'Home',
    credentialId: 'Y3JlZA',
    salt: VECTORS.salt,
    envelope: VECTORS.envelope,
    generation: 3,
    createdAt: '2026-11-04T10:00:00.000Z',
  };

  it('reads one, also with a member a newer box adds', () => {
    expect(PlaceKitRecord.parse(record)).toEqual(record);
    expect(PlaceKitRecord.parse({ ...record, newer: true })).toEqual(record);
  });

  it('refuses another kind, an envelope that isn’t one, or no PeerId', () => {
    expect(PlaceKitRecord.safeParse({ ...record, kind: 'other' }).success).toBe(false);
    expect(PlaceKitRecord.safeParse({ ...record, envelope: 'plain' }).success).toBe(false);
    expect(PlaceKitRecord.safeParse({ ...record, appliance: 'home' }).success).toBe(false);
  });
});
