import {
  DirectIdentity,
  EnrollLinkCreateOutput,
  MailSettings,
  parseLocalLink,
  TailscaleStatus,
  tailscaleStatusValid,
} from '@whombat/protocol';
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_APPLIANCE,
  DEVICE_LINK,
  DIRECT_IDENTITY_CLAIMED,
  DIRECT_IDENTITY_UNCLAIMED,
  MAIL_SETTINGS,
  TAILSCALE_HEADSCALE,
} from './community.js';
import { DIRECT_ADDRESSES } from './direct.js';

describe('the community box fixtures (CT-1300…CT-1308)', () => {
  it('parse, and the links carry the box and its ways', () => {
    for (const d of [DIRECT_IDENTITY_UNCLAIMED, DIRECT_IDENTITY_CLAIMED])
      expect(DirectIdentity.parse(d)).toEqual(d);
    expect(EnrollLinkCreateOutput.parse(DEVICE_LINK)).toEqual(DEVICE_LINK);
    expect(MailSettings.parse(MAIL_SETTINGS)).toEqual(MAIL_SETTINGS);
    const device = parseLocalLink(DEVICE_LINK.link);
    expect(device?.kind).toBe('device');
    expect(device?.appliance).toBe(COMMUNITY_APPLIANCE);
    expect(device?.routes).toEqual(DIRECT_ADDRESSES.routes);
    for (const s of Object.values(TAILSCALE_HEADSCALE)) {
      expect(TailscaleStatus.parse(s)).toEqual(s);
      expect(tailscaleStatusValid(s), s.state).toBe(true);
    }
  });
});
