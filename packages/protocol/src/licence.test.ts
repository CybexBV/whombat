import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { type AdmissionHeader, ed25519Jwk, signAdmissionTicket } from './admission.js';
import { base64urlEncode, utf8Encode } from './bytes.js';
import {
  LICENCE_GRACE_S,
  LICENCE_LIFETIME_S,
  type LicenceClaims,
  type LicenceHeader,
  LicenceKeySet,
  licenceAudience,
  licenceStatus,
  signLicenceToken,
  verifyLicenceToken,
} from './licence.js';

const secret = new Uint8Array(32).fill(9);
const other = new Uint8Array(32).fill(3);
const sign = (sk: Uint8Array) => (m: Uint8Array) => ed25519.sign(m, sk);
const keySet = LicenceKeySet.parse({
  v: 1,
  env: 'test',
  keys: [ed25519Jwk('lic-1', ed25519.getPublicKey(secret))],
});
const header: LicenceHeader = { alg: 'EdDSA', kid: 'lic-1', typ: 'whombat-licence+jwt' };
const now = 1_790_000_000;
const claims: LicenceClaims = {
  iss: 'https://control.test',
  aud: licenceAudience('test'),
  sub: 'dev_1',
  org: 'org_1',
  plan: 'whombat',
  state: 'active',
  limits: { devices: 1, connectors: 2 },
  iat: now,
  nbf: now,
  exp: now + LICENCE_LIFETIME_S,
  jti: 'AAAAAAAAAAAAAAAAAAAAAA',
};
const opts = { keySet, device: 'dev_1', now };

function forge(h: unknown, c: unknown, sk = secret): string {
  const hp = `${base64urlEncode(utf8Encode(JSON.stringify(h)))}.${base64urlEncode(utf8Encode(JSON.stringify(c)))}`;
  return `${hp}.${base64urlEncode(sign(sk)(utf8Encode(hp)))}`;
}

describe('licence tokens', () => {
  it('verifies a well-formed token, also after it expired', () => {
    const token = signLicenceToken(header, claims, sign(secret));
    expect(verifyLicenceToken(token, opts)).toEqual({ ok: true, header, claims });
    expect(verifyLicenceToken(token, { ...opts, now: now + 10 * LICENCE_LIFETIME_S }).ok).toBe(true);
  });

  it('refuses each failure with its code', () => {
    const admission: AdmissionHeader = { alg: 'EdDSA', kid: 'lic-1', typ: 'whombat-admission+jwt' };
    const cases: [string, Parameters<typeof verifyLicenceToken>[1], string][] = [
      ['a.b', opts, 'malformed'],
      [forge({ ...header, typ: 'JWT' }, claims), opts, 'bad_header'],
      [forge(admission, claims), opts, 'bad_header'],
      [forge({ ...header, kid: 'lic-2' }, claims), opts, 'unknown_kid'],
      [forge(header, claims, other), opts, 'bad_signature'],
      [forge(header, { ...claims, extra: 1 }), opts, 'bad_claims'],
      [forge(header, { ...claims, aud: 'whombat-appliance:prod' }), opts, 'wrong_audience'],
      [forge(header, claims), { ...opts, device: 'dev_2' }, 'wrong_device'],
      [forge(header, { ...claims, exp: now + LICENCE_LIFETIME_S + 1 }), opts, 'bad_lifetime'],
      [forge(header, claims), { ...opts, now: now - 301 }, 'not_yet_valid'],
    ];
    for (const [token, o, code] of cases)
      expect(verifyLicenceToken(token, o)).toEqual({ ok: false, error: code });
    expect(verifyLicenceToken(forge(header, claims), { ...opts, now: now - 300 }).ok).toBe(true);
  });

  it('never accepts an admission ticket', () => {
    const ticket = signAdmissionTicket(
      { alg: 'EdDSA', kid: 'lic-1', typ: 'whombat-admission+jwt' },
      {
        iss: 'https://control.test',
        aud: 'whombat-relay:test',
        rol: 'appliance',
        apl: 'apl_1',
        sub: 'dev_1',
        wrk: 'relay-1',
        chn: 'app',
        iat: now,
        nbf: now,
        exp: now + 60,
        jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
      sign(secret),
    );
    expect(verifyLicenceToken(ticket, opts)).toEqual({ ok: false, error: 'bad_header' });
  });
});

describe('licenceStatus', () => {
  const s = (c: LicenceClaims | null, t: number, extra: Partial<Parameters<typeof licenceStatus>[0]> = {}) =>
    licenceStatus({ claims: c, now: t, highWater: 0, clockMark: 0, claimedAt: now - 100, ...extra });

  it('follows LC-09', () => {
    expect(s(claims, now)).toMatchObject({ state: 'licensed', reason: 'active', plan: 'whombat' });
    expect(s({ ...claims, state: 'trialing' }, now)).toMatchObject({ state: 'licensed', reason: 'trial' });
    expect(s({ ...claims, state: 'past_due' }, now)).toMatchObject({ state: 'licensed', reason: 'past_due' });
    expect(s({ ...claims, state: 'grace' }, now)).toMatchObject({ state: 'grace', reason: 'payment' });
    expect(s({ ...claims, state: 'cancelled' }, now)).toMatchObject({
      state: 'lapsed',
      reason: 'cancelled',
      graceEndsAt: null,
    });
    expect(s(claims, claims.exp)).toMatchObject({ state: 'grace', reason: 'not_renewed' });
    expect(s(claims, claims.exp + LICENCE_GRACE_S)).toMatchObject({ state: 'lapsed', reason: 'expired' });
    expect(s(null, now)).toMatchObject({
      state: 'grace',
      reason: 'no_licence',
      graceEndsAt: now - 100 + LICENCE_GRACE_S,
    });
    expect(s(null, now + LICENCE_GRACE_S)).toMatchObject({ state: 'lapsed', reason: 'no_licence' });
    expect(s(null, now, { claimedAt: null })).toBeNull();
  });

  it('never goes back in time', () => {
    const late = claims.exp + LICENCE_GRACE_S;
    expect(s(claims, now, { highWater: late })).toMatchObject({ state: 'lapsed', effectiveAt: late });
    expect(s(claims, now, { clockMark: claims.exp })).toMatchObject({
      state: 'grace',
      reason: 'not_renewed',
    });
  });
});
