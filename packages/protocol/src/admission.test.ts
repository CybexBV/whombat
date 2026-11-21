import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  type AdmissionClaims,
  type AdmissionHeader,
  admissionJwk,
  signAdmissionTicket,
  verifyAdmissionTicket,
} from './admission.js';
import { base64urlDecode, base64urlEncode, utf8Encode } from './bytes.js';

const secret = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(secret);
const sign = (m: Uint8Array) => ed25519.sign(m, secret);
const verify = (s: Uint8Array, m: Uint8Array, p: Uint8Array) => ed25519.verify(s, m, p);
const jwks = { keys: [admissionJwk('adm-1', publicKey)] };
const header: AdmissionHeader = { alg: 'EdDSA', kid: 'adm-1', typ: 'whombat-admission+jwt' };
const now = 1_790_000_000;
const claims: AdmissionClaims = {
  iss: 'https://api.dev.whombat.com',
  aud: 'whombat-relay:dev',
  rol: 'client',
  apl: 'apl_7Hq2',
  sub: 'acc_91xz',
  org: 'org_42',
  wrk: 'relay-1',
  chn: 'app',
  iat: now,
  nbf: now,
  exp: now + 120,
  jti: 'AAAAAAAAAAAAAAAAAAAAAA',
};
const opts = { jwks, verify, now, audience: 'whombat-relay:dev' };

function forge(h: unknown, c: unknown): string {
  const hp = `${base64urlEncode(utf8Encode(JSON.stringify(h)))}.${base64urlEncode(utf8Encode(JSON.stringify(c)))}`;
  return `${hp}.${base64urlEncode(sign(utf8Encode(hp)))}`;
}

describe('admission tickets', () => {
  it('refuses each failure with its code', () => {
    const token = signAdmissionTicket(header, claims, sign);
    const [h, p, s] = token.split('.') as [string, string, string];
    const flipped = base64urlDecode(s);
    flipped[0] = (flipped[0] as number) ^ 1;
    const cases: [string, Parameters<typeof verifyAdmissionTicket>[1], string][] = [
      ['a.b', opts, 'malformed'],
      [`${h}.${p}.${base64urlEncode(flipped)}`, opts, 'bad_signature'],
      [`${h}.${p}.${s.slice(0, -4)}`, opts, 'malformed'],
      [forge({ ...header, alg: 'none' }, claims), opts, 'bad_header'],
      [forge({ ...header, typ: 'JWT' }, claims), opts, 'bad_header'],
      [forge({ ...header, kid: 'adm-2' }, claims), opts, 'unknown_kid'],
      [forge(header, { ...claims, extra: 1 }), opts, 'bad_claims'],
      [token, { ...opts, audience: 'whombat-relay:prod' }, 'wrong_audience'],
      [token, { ...opts, issuer: 'https://api.whombat.com' }, 'wrong_issuer'],
      [token, { ...opts, role: 'appliance' }, 'wrong_role'],
      [token, { ...opts, worker: 'relay-2' }, 'wrong_worker'],
      [forge(header, { ...claims, exp: now + 301 }), opts, 'bad_lifetime'],
      [forge(header, { ...claims, nbf: now - 1 }), opts, 'bad_lifetime'],
      [token, { ...opts, now: now - 31 }, 'not_yet_valid'],
      [token, { ...opts, now: now + 120 + 30 }, 'expired'],
    ];
    for (const [t, o, code] of cases)
      expect(verifyAdmissionTicket(t, o), code).toEqual({ ok: false, error: code });
  });

  it('accepts an unclaimed appliance ticket without org, for its own worker', () => {
    const { org: _org, ...unclaimed } = claims;
    const token = signAdmissionTicket(header, { ...unclaimed, rol: 'appliance', chn: 'enroll' }, sign);
    const r = verifyAdmissionTicket(token, { ...opts, worker: 'relay-1', role: 'appliance' });
    expect(r.ok && r.claims.org).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('verifies strictly by default', () => {
    const token = signAdmissionTicket(header, claims, sign);
    const { verify: _v, ...defaults } = opts;
    expect(verifyAdmissionTicket(token, defaults).ok).toBe(true);
    // S + L: the same signature with a non-canonical S.
    const [h, p, s] = token.split('.') as [string, string, string];
    const sig = base64urlDecode(s);
    let S = 0n;
    for (let i = 63; i >= 32; i--) S = (S << 8n) | BigInt(sig[i] as number);
    S += 2n ** 252n + 27742317777372353535851937790883648493n;
    for (let i = 32; i < 64; i++) {
      sig[i] = Number(S & 0xffn);
      S >>= 8n;
    }
    expect(verifyAdmissionTicket(`${h}.${p}.${base64urlEncode(sig)}`, defaults)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('accepts within the clock skew', () => {
    const token = signAdmissionTicket(header, claims, sign);
    expect(verifyAdmissionTicket(token, { ...opts, now: now - 30 }).ok).toBe(true);
    expect(verifyAdmissionTicket(token, { ...opts, now: now + 149 }).ok).toBe(true);
  });

  it('never lets the verify callback throw through', () => {
    const token = signAdmissionTicket(header, claims, sign);
    const throwing = () => {
      throw new Error('boom');
    };
    expect(verifyAdmissionTicket(token, { ...opts, verify: throwing })).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });
});
