import { describe, expect, it } from 'vitest';
import { CLAIM_CODE_ALPHABET } from './claim/alphabet.js';
import {
  LINK_OFFER_TEXT,
  LINK_PRICE_CENTS,
  LINK_PRICE_TEXT,
  LINK_PRICE_YEAR_CENTS,
  LINK_PRICE_YEAR_TEXT,
  LINK_TRIAL_TEXT,
  LinkCode,
  LinkState,
  NativePushToken,
  normalizeLinkCode,
} from './link.js';
import { ASSISTANT_SETTINGS } from './session/assistant-settings/index.js';
import { APP_ERROR_CODES } from './session/errors.js';
import { OPERATION_SAFETY } from './session/operation-safety.js';
import { SESSION_OPERATIONS } from './session/operations.js';
import { APPLIANCE_EVENT_TYPES } from './session/providers.js';
import { LINK_ERROR_CODES, LinkOutput, ReachGetOutput, UpdatesChannelOutput } from './session/reach.js';

describe('Whombat Link', () => {
  it('has the five states', () => {
    expect(LinkState.options).toEqual(['off', 'starting', 'on', 'grace', 'ended']);
  });

  it('writes the code in the claim alphabet, upper case, 4 + 4', () => {
    expect(LinkCode.safeParse('KXQM-TRVW').success).toBe(true);
    expect(LinkCode.safeParse('KXQMTRVW').success).toBe(false);
    expect(LinkCode.safeParse('KXQM-TRVO').success).toBe(false);
    for (const c of 'ABCDEFGHJKMNPQRTVWXY') expect(CLAIM_CODE_ALPHABET).toContain(c);
  });

  it('reads a code the way people type it', () => {
    expect(normalizeLinkCode('kxqm trvw')).toBe('KXQM-TRVW');
    expect(normalizeLinkCode(' KXQM-TRVW ')).toBe('KXQM-TRVW');
    expect(normalizeLinkCode('kx-qm-tr-vw')).toBe('KXQM-TRVW');
    expect(normalizeLinkCode('KXQM-TRV')).toBeNull();
    expect(normalizeLinkCode('KXQM-TRVWX')).toBeNull();
    expect(normalizeLinkCode('KXQM-TRV0')).toBeNull();
    for (const typed of ['kxqm trvw', 'KXQMTRVW'])
      expect(LinkCode.safeParse(normalizeLinkCode(typed)).success).toBe(true);
  });

  it('keeps the price in one place', () => {
    expect(LINK_PRICE_CENTS).toBe(250);
    expect(LINK_PRICE_TEXT).toContain('2.50');
    expect(LINK_PRICE_YEAR_CENTS).toBe(2_500);
    expect(LINK_PRICE_YEAR_TEXT).toContain('€25');
  });

  it('builds the one offer sentence from the free month and both prices (4.6)', () => {
    expect(LINK_OFFER_TEXT.startsWith(LINK_TRIAL_TEXT)).toBe(true);
    expect(LINK_OFFER_TEXT).toContain(LINK_PRICE_TEXT);
    expect(LINK_OFFER_TEXT).toContain(LINK_PRICE_YEAR_TEXT);
    expect(LINK_OFFER_TEXT.indexOf(LINK_PRICE_TEXT)).toBeLessThan(
      LINK_OFFER_TEXT.indexOf(LINK_PRICE_YEAR_TEXT),
    );
  });

  it('takes an APNs or FCM token only', () => {
    const token = { platform: 'apns', token: 'f'.repeat(64), appId: 'com.whombat.mobile' };
    expect(NativePushToken.safeParse(token).success).toBe(true);
    expect(NativePushToken.safeParse({ ...token, platform: 'webpush' }).success).toBe(false);
  });

  it('adds the session ops with their safety and assistant access', () => {
    const ops = [
      'reach.get',
      'link.on',
      'link.off',
      'updates.channel.get',
      'updates.channel.set',
      'push.token.set',
      'push.token.clear',
    ];
    for (const op of ops) {
      expect(SESSION_OPERATIONS.get(op)?.channel, op).toBe('app');
      expect(OPERATION_SAFETY[op as keyof typeof OPERATION_SAFETY], op).toBeDefined();
      expect(ASSISTANT_SETTINGS[op as keyof typeof ASSISTANT_SETTINGS], op).toBeDefined();
    }
    expect(SESSION_OPERATIONS.get('reach.get')?.mutating).toBe(false);
    expect(SESSION_OPERATIONS.get('link.on')?.mutating).toBe(true);
    for (const op of ['link.on', 'link.off', 'updates.channel.set'])
      expect(ASSISTANT_SETTINGS[op as keyof typeof ASSISTANT_SETTINGS].access, op).toBe('never');
    for (const code of LINK_ERROR_CODES) expect(APP_ERROR_CODES, code).toHaveProperty(code);
    expect(APP_ERROR_CODES).toHaveProperty('update_channel_unavailable');
    for (const type of ['link.on', 'link.off', 'link.state_changed', 'update.channel_set'])
      expect(APPLIANCE_EVENT_TYPES).toContain(type);
  });

  it('answers Reach with every part optional for a box that lacks it', () => {
    expect(ReachGetOutput.parse({ link: null, ownAddress: null, tailscale: null })).toEqual({
      link: null,
      ownAddress: null,
      tailscale: null,
    });
    const starting = {
      state: 'starting',
      since: '2026-11-18T12:00:00.000Z',
      pending: {
        code: 'KXQM-TRVW',
        url: 'https://app.whombat.com/link',
        expiresAt: '2026-11-18T12:15:00.000Z',
      },
    };
    expect(LinkOutput.parse({ link: starting })).toEqual({ link: starting });
    expect(UpdatesChannelOutput.safeParse({ channel: 'development' }).success).toBe(true);
    expect(UpdatesChannelOutput.safeParse({ channel: 'beta' }).success).toBe(false);
  });
});
