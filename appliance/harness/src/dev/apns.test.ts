import { describe, expect, it } from 'vitest';
import { apnsControlEnv } from './services.ts';

describe("control's APNs settings on the dev stack (IN-518)", () => {
  it('sends nothing without a key', () => {
    expect(apnsControlEnv({})).toEqual({});
  });

  it("uses Apple's production host and the app's bundle id by default", () => {
    expect(
      apnsControlEnv({
        WB_MGD_APNS_KEY_FILE: '/k.p8',
        WB_MGD_APNS_KEY_ID: 'KEY1',
        WB_MGD_APNS_TEAM_ID: 'TEAM1',
      }),
    ).toMatchObject({
      APNS_KEY_FILE: '/k.p8',
      APNS_KEY_ID: 'KEY1',
      APNS_TEAM_ID: 'TEAM1',
      APNS_TOPIC: 'com.whombat.mobile',
      APNS_HOST: 'https://api.push.apple.com',
    });
  });

  it('refuses half the settings', () => {
    expect(() => apnsControlEnv({ WB_MGD_APNS_KEY_FILE: '/k.p8' })).toThrow(/WB_MGD_APNS_KEY_ID/);
  });
});
