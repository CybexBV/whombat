import { deriveSeedKeypair, fingerprintOf } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { KeyCustody } from './custody';

const MASTER = Buffer.alloc(32, 9).toString('base64');

describe('KeyCustody', () => {
  it('round-trips a secret key and binds it to the principal', () => {
    const custody = new KeyCustody(MASTER);
    const { secretKey } = deriveSeedKeypair('prn_dusty');
    const stored = custody.encrypt('prn_dusty', secretKey);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(secretKey);
    expect(custody.decrypt('prn_dusty', stored)).toBe(secretKey);
    expect(() => new KeyCustody(MASTER).decrypt('prn_mara', stored)).toThrow();
  });

  it('refuses to decrypt with another master key', () => {
    const stored = new KeyCustody(MASTER).encrypt('prn_dusty', deriveSeedKeypair('prn_dusty').secretKey);
    const other = new KeyCustody(Buffer.alloc(32, 1).toString('base64'));
    expect(() => other.decrypt('prn_dusty', stored)).toThrow();
  });

  it('derives stable seed keys and random keys otherwise', () => {
    const custody = new KeyCustody(undefined);
    expect(custody.usingDevKey).toBe(true);
    const seeded = custody.newPrincipalKeys('prn_dusty', { seed: 'whombat-demo' });
    expect(seeded.fingerprint).toBe('1035 d0ed');
    expect(seeded.fingerprint).toBe(fingerprintOf(seeded.publicKey));
    const a = custody.newPrincipalKeys('prn_x');
    const b = custody.newPrincipalKeys('prn_x');
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('rejects a master key of the wrong size', () => {
    expect(() => new KeyCustody(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
