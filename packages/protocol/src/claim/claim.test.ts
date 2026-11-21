import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes.js';
import { claimCardPassword } from '../session/enrollment.js';
import {
  CLAIM_CODE_ALPHABET,
  type ClaimPakeContext,
  ClaimPakeError,
  CpaceError,
  claimBackoffSeconds,
  claimConfirmEqual,
  claimPakeInitiator,
  claimPakeInitiatorFinish,
  claimPakeResponder,
  cpaceInitiatorFinish,
  cpaceInitiatorStart,
  cpaceResponderRespond,
  cpaceScalarMultVfy,
  formatClaimCode,
  generateClaimLetters,
  normalizeClaimCode,
} from './index.js';

const hex = (b: Uint8Array) => bytesToHex(b);
const h = (s: string) => hexToBytes(s.replace(/\s+/g, ''));
/** A randomness source that returns exactly these bytes, in order. */
const stream = (bytes: Uint8Array) => {
  let o = 0;
  return (n: number) => {
    if (o + n > bytes.length) throw new Error('stream exhausted');
    const out = bytes.slice(o, o + n);
    o += n;
    return out;
  };
};

// draft-irtf-cfrg-cpace-21, Appendix B.3 (ristretto255, SHA-512).
const B3 = {
  prs: utf8Encode('Password'),
  ci: h('0b415f696e69746961746f720b425f726573706f6e646572'),
  sid: h('7e4b4791d6a8ef019b936c79fb7f2c57'),
  genStr: h(`11435061636552697374726574746f3235350850617373776f726464
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000180b415f696e69746961746f
    720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f
    2c57`),
  g: '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  ya: h('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08'),
  adA: utf8Encode('ADa'),
  Ya: 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157',
  yb: h('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d'),
  adB: utf8Encode('ADb'),
  Yb: '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258',
  K: '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f',
  transcript:
    '20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462',
  isk: 'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447',
};

describe('CPace (draft-irtf-cfrg-cpace-21 B.3)', () => {
  it('scalar_mult_vfy: valid input, and G.I for invalid encodings and the identity (B.3.10, B.3.11)', () => {
    const s = h('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05');
    expect(
      hex(cpaceScalarMultVfy(s, h('2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c'))),
    ).toBe('7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e');
    const I = '00'.repeat(32);
    expect(
      hex(cpaceScalarMultVfy(s, h('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c'))),
    ).toBe(I);
    expect(hex(cpaceScalarMultVfy(s, h(I)))).toBe(I);
    const inputs = { prs: B3.prs, ci: B3.ci, sid: B3.sid };
    expect(() => cpaceResponderRespond(inputs, h(I), stream(B3.yb))).toThrow(CpaceError);
    const a = cpaceInitiatorStart(inputs, stream(B3.ya));
    expect(() =>
      cpaceInitiatorFinish(a, h('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c')),
    ).toThrow(CpaceError);
  });
});

describe('claim code', () => {
  it('normalizes letters-only and full codes, never repairs', () => {
    expect(normalizeClaimCode(' kx qm ')).toEqual({ kind: 'letters', letters: 'KXQM' });
    expect(normalizeClaimCode('KX-4821-QM')).toEqual({ kind: 'code', letters: 'KXQM', lookup: '4821' });
    expect(normalizeClaimCode('kx 048211 qm')).toEqual({ kind: 'code', letters: 'KXQM', lookup: '048211' });
    expect(normalizeClaimCode('KO-4821-QM')).toEqual({ kind: 'invalid' });
    expect(normalizeClaimCode('KX-482-QM')).toEqual({ kind: 'invalid' });
    expect(normalizeClaimCode('KX.4821.QM')).toEqual({ kind: 'invalid' });
    expect(formatClaimCode('KXQM', '4821')).toBe('KX-4821-QM');
    expect(() => formatClaimCode('KXQO', '4821')).toThrow();
  });

  it('draws letters without modulo bias', () => {
    expect(generateClaimLetters(stream(Uint8Array.from([0, 19, 20, 239])))).toBe('AYAY');
    expect(generateClaimLetters(stream(Uint8Array.from([240, 255, 1, 2, 3, 4])))).toBe('BCDE');
    expect(CLAIM_CODE_ALPHABET).toHaveLength(20);
  });

  it('backs off after three free failures', () => {
    expect([1, 2, 3, 4, 5, 6, 9, 10, 40].map(claimBackoffSeconds)).toEqual([
      0, 0, 0, 60, 120, 240, 1920, 3600, 3600,
    ]);
  });
});

describe('claim PAKE', () => {
  const ctx: ClaimPakeContext = {
    method: 'code',
    password: 'KXQM',
    deviceId: 'dev_7Hq2mXk3',
    appliancePeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    clientPeerId: '12D3KooWACa6VJfb1zWBv7pi2NstUM7jKxK6wYS4x47gm4GvctK8',
    claimId: 'clm_8Hq2mXk3pZ',
  };
  const rnd = (seed: number) => stream(Uint8Array.from({ length: 64 }, (_, i) => (seed * 31 + i * 7) & 0xff));

  const run = (client: ClaimPakeContext, appliance: ClaimPakeContext) => {
    const c = claimPakeInitiator(client, rnd(1));
    const a = claimPakeResponder(appliance, c.share, rnd(2));
    return { client: claimPakeInitiatorFinish(c.state, a.share), appliance: a.tags };
  };

  it('disagrees on a wrong password, another PeerId, swapped PeerIds or another claim', () => {
    const variants: Partial<ClaimPakeContext>[] = [
      { password: 'KXQN' },
      { appliancePeerId: '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo' },
      { appliancePeerId: ctx.clientPeerId, clientPeerId: ctx.appliancePeerId },
      { claimId: 'clm_other00' },
      { deviceId: 'dev_other' },
    ];
    for (const v of variants) {
      const t = run({ ...ctx, ...v }, ctx);
      expect(claimConfirmEqual(t.appliance.client, t.client.client), JSON.stringify(v)).toBe(false);
      expect(claimConfirmEqual(t.client.appliance, t.appliance.appliance), JSON.stringify(v)).toBe(false);
    }
  });

  it('refuses identity and malformed shares, and passwords of the wrong shape', () => {
    expect(() => claimPakeResponder(ctx, 'A'.repeat(43), rnd(2))).toThrow(ClaimPakeError);
    expect(() => claimPakeResponder(ctx, 'B'.repeat(43), rnd(2))).toThrow(ClaimPakeError);
    expect(() => claimPakeResponder(ctx, 'short', rnd(2))).toThrow(ClaimPakeError);
    const c = claimPakeInitiator(ctx, rnd(1));
    expect(() => claimPakeInitiatorFinish(c.state, 'A'.repeat(43))).toThrow(ClaimPakeError);
    expect(() => claimPakeInitiator({ ...ctx, password: 'KXQO' }, rnd(1))).toThrow(ClaimPakeError);
    expect(() => claimPakeInitiator({ ...ctx, method: 'card', password: 'KXQM' }, rnd(1))).toThrow(
      ClaimPakeError,
    );
    // CT-66: the card password is claimCardPassword (43 base64url characters), never the raw secret.
    expect(() =>
      claimPakeInitiator({ ...ctx, method: 'card', password: 'MZXW6YTBOI2DAMRTGQ3DMNZYHE' }, rnd(1)),
    ).toThrow(ClaimPakeError);
    expect(() =>
      claimPakeInitiator(
        { ...ctx, method: 'card', password: claimCardPassword(ctx.deviceId, 'MZXW6YTBOI2DAMRTGQ3DMNZYHE') },
        rnd(1),
      ),
    ).not.toThrow();
    expect(claimConfirmEqual('A'.repeat(43), 'A'.repeat(42))).toBe(false);
  });
});
