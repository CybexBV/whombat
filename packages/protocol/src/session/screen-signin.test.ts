import { describe, expect, it } from 'vitest';
import { ENROLL_CLAIM_BEGIN_TTL_S } from '../limits.js';
import {
  ENDPOINT_ENROLLED_VIA,
  EnrollClaimOutput,
  EnrollScreenBeginInput,
  EnrollScreenInput,
  EnrollScreenOutput,
  EnrollScreenRequestInput,
  EnrollScreenRequestOutput,
  SCREEN_SIGNIN_ERROR_CODES,
  SCREEN_SIGNIN_ERROR_STATUS,
  SCREEN_SIGNIN_REQUESTS_PER_KEY,
  SCREEN_SIGNIN_REQUESTS_TOTAL,
  SCREEN_SIGNIN_TTL_S,
  ScreenBackoffDetails,
  ScreenSignInId,
} from './enrollment.js';
import { APP_ERROR_CODES, appErrorCode } from './errors.js';
import { OPERATION_SAFETY } from './operation-safety.js';
import { createOperationAllowlist, SESSION_OPERATIONS } from './operations.js';

const SHARE = 'qhcy9cCZHy7d-p0M6Bu1tqPHYQmEdIkKmpajfgQQdF8';
const TAG = '3v6Bsd46bn5ypK3P7aVRGQAe8EMHV0Zc6O_uojTwRxw';
const T = '2026-10-20T12:05:00.000Z';
const endpoint = { label: 'Pixel 9', platform: 'android' };

describe('the screen sign-in’s ops (CT-622)', () => {
  it('are on the enrollment channel: request and begin ephemeral, enroll.screen never resent', () => {
    const allow = createOperationAllowlist();
    for (const op of ['enroll.screen.request', 'enroll.screen.begin', 'enroll.screen']) {
      expect(allow.resolve(op, { enrolled: false }).ok, op).toBe(true);
      const spec = SESSION_OPERATIONS.get(op);
      expect(spec, op).toMatchObject({ channel: 'enroll', mutating: true, secret: false, retry: 'never' });
      expect(spec?.destructive, op).toBe(false);
    }
    expect(SESSION_OPERATIONS.get('enroll.screen.request')?.ephemeral).toBe(true);
    expect(SESSION_OPERATIONS.get('enroll.screen.begin')?.ephemeral).toBe(true);
    expect(SESSION_OPERATIONS.get('enroll.screen')?.ephemeral).toBe(false);
    expect(OPERATION_SAFETY['enroll.screen']).toEqual(OPERATION_SAFETY['enroll.claim']);
  });

  it('request: the new endpoint only, strict (3.0: no email, CT-1509); answers the sign-in id and when it ends', () => {
    expect(EnrollScreenRequestInput.safeParse({ endpoint }).success).toBe(true);
    expect(EnrollScreenRequestInput.safeParse({}).success).toBe(false);
    // The account is the person's; no email, and the letters never travel.
    for (const extra of [{ email: 'mara@example.com' }, { accountId: 'acc_mara0001' }, { code: 'KXQMTR' }])
      expect(EnrollScreenRequestInput.safeParse({ endpoint, ...extra }).success).toBe(false);
    expect(EnrollScreenRequestOutput.safeParse({ signinId: 'scr_8Hq2mXk3pZ', expiresAt: T }).success).toBe(
      true,
    );
    expect(EnrollScreenRequestOutput.safeParse({ signinId: 'scr_8Hq2mXk3pZ' }).success).toBe(false);
  });

  it('begin and confirm carry the claim’s share and tag shapes and the sign-in id', () => {
    expect(EnrollScreenBeginInput.safeParse({ signinId: 'scr_8Hq2mXk3pZ', share: SHARE }).success).toBe(true);
    expect(
      EnrollScreenBeginInput.safeParse({ signinId: 'scr_8Hq2mXk3pZ', share: SHARE.slice(1) }).success,
    ).toBe(false);
    expect(
      EnrollScreenBeginInput.safeParse({ signinId: 'scr_8Hq2mXk3pZ', share: SHARE, letters: 'KXQMTR' })
        .success,
    ).toBe(false);
    expect(EnrollScreenInput.safeParse({ signinId: 'scr_8Hq2mXk3pZ', confirm: TAG }).success).toBe(true);
    expect(
      EnrollScreenInput.safeParse({ signinId: 'scr_8Hq2mXk3pZ', confirm: TAG, email: 'mara@example.com' })
        .success,
    ).toBe(false);
    for (const id of ['short', 'scr 8Hq2mXk3pZ', 'x'.repeat(65)])
      expect(ScreenSignInId.safeParse(id).success, id).toBe(false);
    expect(EnrollScreenOutput.shape.confirm).toBeDefined();
    expect(EnrollScreenOutput.shape.endpoint).toBeDefined();
    expect(EnrollScreenOutput.shape).not.toHaveProperty('recoveryKitRequired');
    // No recovery kit is required at claim (BX-01): the member is gone (CT-1281).
    expect(EnrollClaimOutput.shape).not.toHaveProperty('recoveryKitRequired');
  });

  it('limits: five minutes on screen, 5 requests per key and 30 per box an hour, the claim’s begin TTL', () => {
    expect(SCREEN_SIGNIN_TTL_S).toBe(300);
    expect(SCREEN_SIGNIN_REQUESTS_PER_KEY).toBe(5);
    expect(SCREEN_SIGNIN_REQUESTS_TOTAL).toBe(30);
    expect(ENROLL_CLAIM_BEGIN_TTL_S).toBe(120);
  });

  it('refusals: their codes are known, each on its generic ErrorCode', () => {
    expect(SCREEN_SIGNIN_ERROR_STATUS).toEqual({
      screen_unavailable: 'unavailable',
      screen_signin_missing: 'conflict',
      screen_begin_missing: 'conflict',
      screen_code_invalid: 'forbidden',
      screen_backoff: 'rate_limited',
      screen_share_invalid: 'validation_failed',
      screen_rate_limited: 'rate_limited',
    });
    for (const code of [...SCREEN_SIGNIN_ERROR_CODES, 'endpoint_enrolled'])
      expect(APP_ERROR_CODES, code).toHaveProperty(code);
    const details = { code: 'screen_backoff', retryAt: T };
    expect(ScreenBackoffDetails.parse(details)).toEqual(details);
    expect(appErrorCode(details)).toBe('screen_backoff');
    expect(ScreenBackoffDetails.safeParse({ code: 'claim_backoff', retryAt: T }).success).toBe(false);
  });

  it('names the way in: endpoint.enrolled’s via gains screen (CT-627)', () => {
    expect(ENDPOINT_ENROLLED_VIA).toContain('screen');
    expect(ENDPOINT_ENROLLED_VIA).toContain('passkey');
  });
});
