import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode, utf8Encode } from './bytes.js';
import { signCompactEdDsa, verifyCompactEdDsa } from './jws.js';

const secret = new Uint8Array(32).fill(9);
const sign = (m: Uint8Array) => ed25519.sign(m, secret);
const Header = z.strictObject({ alg: z.literal('EdDSA'), kid: z.string(), typ: z.literal('test+jwt') });
const Claims = z.strictObject({ sub: z.string() });
const header = { alg: 'EdDSA', kid: 'k-1', typ: 'test+jwt' };
const claims = { sub: 'dev_1' };
const keys = [{ kid: 'k-1', x: base64urlEncode(ed25519.getPublicKey(secret)) }];
const opts = { maxLength: 4096, header: Header, claims: Claims, keys };

const segment = (value: unknown) => base64urlEncode(utf8Encode(JSON.stringify(value)));
/** A token whose signature is valid over whatever segments it is given. */
function signed(h: string, p: string): string {
  return `${h}.${p}.${base64urlEncode(sign(utf8Encode(`${h}.${p}`)))}`;
}
/** The same token with one signature bit flipped. */
function badSignature(token: string): string {
  const [h, p, s] = token.split('.') as [string, string, string];
  const sig = base64urlDecode(s);
  sig[0] = (sig[0] as number) ^ 1;
  return `${h}.${p}.${base64urlEncode(sig)}`;
}

describe('compact EdDSA tokens', () => {
  it('verify what they sign', () => {
    const token = signCompactEdDsa(header, claims, sign);
    expect(verifyCompactEdDsa(token, opts)).toEqual({ ok: true, header, claims });
  });

  it('refuse a token over the size limit before reading it', () => {
    const token = signCompactEdDsa(header, claims, sign);
    expect(verifyCompactEdDsa(token, { ...opts, maxLength: token.length }).ok).toBe(true);
    expect(verifyCompactEdDsa(token, { ...opts, maxLength: token.length - 1 })).toEqual({
      ok: false,
      error: 'malformed',
    });
  });

  it('report the first check a token fails', () => {
    const token = signCompactEdDsa(header, claims, sign);
    const [h, p, s] = token.split('.') as [string, string, string];
    const wrongHeader = segment({ ...header, typ: 'JWT' });
    const otherKid = segment({ ...header, kid: 'k-2' });
    const cases: [string, string, string][] = [
      ['two segments', `${h}.${p}`, 'malformed'],
      ['not base64url', `${h}.${p}.${s}=`, 'malformed'],
      ['header not JSON', signed(base64urlEncode(utf8Encode('{')), p), 'malformed'],
      // The signature's length is checked before the header's members.
      [
        'short signature and bad header',
        `${wrongHeader}.${p}.${base64urlEncode(new Uint8Array(63))}`,
        'malformed',
      ],
      ['bad header and unknown kid', signed(segment({ ...header, kid: 'k-2', typ: 'JWT' }), p), 'bad_header'],
      ['unknown kid and bad signature', badSignature(signed(otherKid, p)), 'unknown_kid'],
      // The claims are read only once the signature holds.
      [
        'bad signature and claims not JSON',
        badSignature(signed(h, base64urlEncode(utf8Encode('{')))),
        'bad_signature',
      ],
      ['bad signature and bad claims', badSignature(signed(h, segment({ sub: 1 }))), 'bad_signature'],
      ['claims not JSON', signed(h, base64urlEncode(utf8Encode('{'))), 'malformed'],
      ['claims with an extra member', signed(h, segment({ ...claims, extra: 1 })), 'bad_claims'],
    ];
    for (const [name, t, error] of cases)
      expect(verifyCompactEdDsa(t, opts), name).toEqual({ ok: false, error });
  });

  it('treat a key that is not 32 bytes as unknown', () => {
    const token = signCompactEdDsa(header, claims, sign);
    const short = [{ kid: 'k-1', x: base64urlEncode(new Uint8Array(31)) }];
    expect(verifyCompactEdDsa(token, { ...opts, keys: short })).toEqual({ ok: false, error: 'unknown_kid' });
  });

  it('turn a throwing verify callback into a bad signature', () => {
    const token = signCompactEdDsa(header, claims, sign);
    const verify = () => {
      throw new Error('boom');
    };
    expect(verifyCompactEdDsa(token, { ...opts, verify })).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('refuse to sign with anything but a 64-byte signature', () => {
    expect(() => signCompactEdDsa(header, claims, () => new Uint8Array(63))).toThrow(/64/);
  });
});
