import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { base64urlEncode, utf8Encode } from '../bytes.js';
import {
  CLAIM_CODE_ALPHABET,
  ClaimPakeError,
  claimConfirmEqual,
  claimPakeCi,
  cpaceInitiatorFinish,
  cpaceInitiatorStart,
  cpaceResponderRespond,
  formatScreenSignInLetters,
  generateScreenSignInLetters,
  normalizeScreenSignInLetters,
  SCREEN_SIGNIN_CI_TAG,
  SCREEN_SIGNIN_CONFIRM_INFO,
  SCREEN_SIGNIN_LETTERS_LENGTH,
  ScreenSignInLetters,
  type ScreenSignInPakeContext,
  screenSignInPakeCi,
  screenSignInPakeInitiator,
  screenSignInPakeInitiatorFinish,
  screenSignInPakeInputs,
  screenSignInPakeResponder,
} from './index.js';

/** A randomness source that returns exactly these bytes, in order, and records what it was asked for. */
const stream = (bytes: number[]) => {
  let o = 0;
  const asked: number[] = [];
  const next = (n: number) => {
    asked.push(n);
    if (o + n > bytes.length) throw new Error('stream exhausted');
    const out = Uint8Array.from(bytes.slice(o, o + n));
    o += n;
    return out;
  };
  return Object.assign(next, { asked });
};
const ch = (cp: number) => String.fromCodePoint(cp);

describe('screen sign-in letters (BX-04)', () => {
  it('draws six letters by the claim’s byte rule, skipping bytes of 240 and above', () => {
    expect(SCREEN_SIGNIN_LETTERS_LENGTH).toBe(6);
    expect(generateScreenSignInLetters(stream([0, 19, 20, 239, 1, 2]))).toBe('AYAYBC');
    const skipping = stream([240, 255, 0, 1, 2, 3, 250, 4, 5]);
    // Six bytes give four letters; then it asks for the two still missing, and once more for the last one.
    expect(generateScreenSignInLetters(skipping)).toBe('ABCDEF');
    expect(skipping.asked).toEqual([6, 2, 1]);
    expect(() => generateScreenSignInLetters(() => new Uint8Array(6).fill(240))).toThrow();
    expect(() => generateScreenSignInLetters(() => new Uint8Array(5))).toThrow();
    const drawn = generateScreenSignInLetters(randomBytes);
    expect(ScreenSignInLetters.safeParse(drawn).success).toBe(true);
    expect([...drawn].every((c) => CLAIM_CODE_ALPHABET.includes(c))).toBe(true);
  });

  it('normalizes what was typed: case, spaces and dashes, never repairs', () => {
    expect(normalizeScreenSignInLetters('KXQMTR')).toBe('KXQMTR');
    expect(normalizeScreenSignInLetters(' kxq mtr ')).toBe('KXQMTR');
    expect(normalizeScreenSignInLetters('KXQ-MTR')).toBe('KXQMTR');
    expect(normalizeScreenSignInLetters(`${ch(9)}KX${ch(0xa0)}Q${ch(0x3000)}MTR${ch(0xfeff)}\n`)).toBe(
      'KXQMTR',
    );
    expect(normalizeScreenSignInLetters('KXQMTO')).toBeNull(); // O isn't in the alphabet
    expect(normalizeScreenSignInLetters('KXQMT1')).toBeNull();
    expect(normalizeScreenSignInLetters('KXQMT')).toBeNull();
    expect(normalizeScreenSignInLetters('KXQMTRA')).toBeNull();
    expect(normalizeScreenSignInLetters('KXQM')).toBeNull(); // a claim code's letters aren't enough
    expect(normalizeScreenSignInLetters('KXQ.MTR')).toBeNull();
    expect(normalizeScreenSignInLetters('ＫＸＱＭＴＲ')).toBeNull(); // full-width isn't folded
    expect(normalizeScreenSignInLetters('')).toBeNull();
  });

  it('groups three and three for display', () => {
    expect(formatScreenSignInLetters('KXQMTR')).toBe('KXQ MTR');
    for (const bad of ['KXQMT', 'kxqmtr', 'KXQ MTR', 'KXQMTO'])
      expect(() => formatScreenSignInLetters(bad)).toThrow();
  });
});

describe('screen sign-in PAKE (BX-03)', () => {
  const ctx: ScreenSignInPakeContext = {
    password: 'KXQMTR',
    deviceId: 'dev_7Hq2mXk3',
    appliancePeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    clientPeerId: '12D3KooWACa6VJfb1zWBv7pi2NstUM7jKxK6wYS4x47gm4GvctK8',
    signinId: 'scr_8Hq2mXk3pZ',
  };
  const relay = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
  const seeded = (label: string) =>
    sha512(utf8Encode(`whombat-screen-signin-vectors/${label}`)).subarray(0, 32);
  const once = (b: Uint8Array) => (n: number) => {
    if (n !== b.length) throw new Error('unexpected draw');
    return b;
  };
  const run = (client: ScreenSignInPakeContext, appliance: ScreenSignInPakeContext) => {
    const c = screenSignInPakeInitiator(client, once(seeded('client')));
    const a = screenSignInPakeResponder(appliance, c.share, once(seeded('appliance')));
    return {
      clientShare: c.share,
      applianceShare: a.share,
      client: screenSignInPakeInitiatorFinish(c.state, a.share),
      appliance: a.tags,
    };
  };

  it('a fixed run: both sides agree', () => {
    expect(bytesToHex(screenSignInPakeCi(ctx))).toBe(
      `17${bytesToHex(utf8Encode(SCREEN_SIGNIN_CI_TAG))}0c${bytesToHex(utf8Encode(ctx.deviceId))}34${bytesToHex(utf8Encode(ctx.appliancePeerId))}34${bytesToHex(utf8Encode(ctx.clientPeerId))}`,
    );
    const t = run(ctx, ctx);
    expect(t.clientShare).toBe('qhcy9cCZHy7d-p0M6Bu1tqPHYQmEdIkKmpajfgQQdF8');
    expect(t.applianceShare).toBe('OnSVkWfRjhJhA9WzLPbVgd6STVU3hQSuchtHsYrGvFY');
    expect(t.client).toEqual({
      client: '3v6Bsd46bn5ypK3P7aVRGQAe8EMHV0Zc6O_uojTwRxw',
      appliance: 'osAIzTUZX4QoPHr4PMfyGJjfiO6bH75Mw8_C3EQQYe8',
    });
    expect(t.appliance).toEqual(t.client);
    expect(claimConfirmEqual(t.appliance.client, t.client.client)).toBe(true);
    expect(claimConfirmEqual(t.client.appliance, t.appliance.appliance)).toBe(true);
  });

  it('tags are HKDF-SHA512(ISK, "whombat-screen-signin-confirm/1") and HMACs over the role and transcript', () => {
    const inputs = screenSignInPakeInputs(ctx);
    const a = cpaceInitiatorStart(inputs, once(seeded('client')));
    const b = cpaceResponderRespond(inputs, a.share, once(seeded('appliance')));
    const { isk, transcript } = cpaceInitiatorFinish(a, b.share);
    const k = hkdf(sha512, isk, undefined, utf8Encode(SCREEN_SIGNIN_CONFIRM_INFO), 64);
    const tag = (role: string) =>
      base64urlEncode(hmac(sha512, k, Uint8Array.from([...utf8Encode(role), ...transcript])).subarray(0, 32));
    expect(run(ctx, ctx).client).toEqual({ client: tag('client'), appliance: tag('appliance') });
  });

  it('disagrees on wrong letters, a relay’s key, swapped PeerIds, another sign-in or another box', () => {
    const variants: Partial<ScreenSignInPakeContext>[] = [
      { password: 'KXQMTW' },
      { appliancePeerId: relay },
      { clientPeerId: relay },
      { appliancePeerId: ctx.clientPeerId, clientPeerId: ctx.appliancePeerId },
      { signinId: 'scr_other000' },
      { deviceId: 'dev_other' },
    ];
    for (const v of variants) {
      const t = run({ ...ctx, ...v }, ctx);
      expect(claimConfirmEqual(t.appliance.client, t.client.client), JSON.stringify(v)).toBe(false);
      expect(claimConfirmEqual(t.client.appliance, t.appliance.appliance), JSON.stringify(v)).toBe(false);
    }
  });

  it('is its own exchange: another CI than the claim’s for the same box and keys', () => {
    expect(bytesToHex(screenSignInPakeCi(ctx))).not.toBe(bytesToHex(claimPakeCi({ ...ctx, method: 'code' })));
  });

  it('refuses identity and malformed shares, and passwords that aren’t six letters', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof ClaimPakeError ? e.code : 'other';
      }
      return 'none';
    };
    expect(code(() => screenSignInPakeResponder(ctx, 'A'.repeat(43), once(seeded('a'))))).toBe(
      'invalid_share',
    );
    expect(code(() => screenSignInPakeResponder(ctx, 'short', once(seeded('a'))))).toBe('invalid_share');
    const c = screenSignInPakeInitiator(ctx, once(seeded('client')));
    expect(code(() => screenSignInPakeInitiatorFinish(c.state, 'A'.repeat(43)))).toBe('invalid_share');
    for (const password of ['KXQM', 'kxqmtr', 'KXQ MTR', 'KXQMTO'])
      expect(code(() => screenSignInPakeInitiator({ ...ctx, password }, once(seeded('c'))))).toBe(
        'invalid_password',
      );
  });
});
