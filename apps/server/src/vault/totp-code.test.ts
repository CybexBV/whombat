/** A login's authenticator key makes the codes RFC 6238 says (vault-simplify.md VLT-46): its own test values. */
import { describe, expect, it } from 'vitest';
import { canonicalTotp, totpCodeOf } from './totp-code';

const SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SHA512 =
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';
const link = (secret: string, algorithm: string) =>
  `otpauth://totp/Test?secret=${secret}&algorithm=${algorithm}&digits=8&period=30`;

describe('the authenticator key’s code', () => {
  it('is RFC 6238’s for SHA-1, SHA-256 and SHA-512', () => {
    for (const [seconds, sha1, sha256, sha512] of [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [20000000000, '65353130', '77737706', '47863826'],
    ] as const) {
      const at = seconds * 1000;
      expect(totpCodeOf(canonicalTotp(link(SHA1, 'SHA1')), at)).toBe(sha1);
      expect(totpCodeOf(canonicalTotp(link(SHA256, 'SHA256')), at)).toBe(sha256);
      expect(totpCodeOf(canonicalTotp(link(SHA512, 'SHA512')), at)).toBe(sha512);
    }
  });

  it('takes a setup key as sites show it, and refuses what isn’t one on its field', () => {
    const canonical = canonicalTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
    expect(canonical).toContain(`secret=${SHA1}`);
    expect(totpCodeOf(canonical, 59_000)).toHaveLength(6);
    expect(() => canonicalTotp('not a key!')).toThrow();
    expect(() => canonicalTotp('otpauth://hotp/X?secret=GEZDGNBVGY3TQOJQ')).toThrow();
  });
});
