import { describe, expect, it } from 'vitest';
import { AdmissionClaims } from '../admission.js';
import { OwnAddressHost, OwnAddressLabel } from '../own-address.js';
import { APP_ERROR_CODES } from './errors.js';
import { SESSION_OPERATIONS } from './operations.js';
import {
  OWN_ADDRESS_RENAME_ERROR_CODES,
  OwnAddressCheckInput,
  OwnAddressCheckOutput,
  OwnAddressSummary,
} from './own-address.js';
import { OWN_ADDRESS_NAMES_MINOR, SESSION_PROTOCOL } from './version.js';

const summary = {
  host: 'home.whombat.app',
  url: 'https://home.whombat.app/',
  state: 'starting',
  reachable: true,
  certificateEndsAt: null,
  watch: { lastCheckAt: null, missed: [], foreign: [] },
};

describe('own names in the session (minor 6)', () => {
  it('has the check, a read, and the rename, never resent', () => {
    expect(SESSION_PROTOCOL.minor).toBeGreaterThanOrEqual(OWN_ADDRESS_NAMES_MINOR);
    expect(SESSION_OPERATIONS.get('ownAddress.check')).toMatchObject({ mutating: false, retry: 'safe' });
    expect(SESSION_OPERATIONS.get('ownAddress.rename')).toMatchObject({ mutating: true, retry: 'never' });
    for (const code of [...OWN_ADDRESS_RENAME_ERROR_CODES, 'address_moved'])
      expect(APP_ERROR_CODES).toHaveProperty([code]);
  });

  it('reads chosen names, digits and hosts under whombat.app', () => {
    for (const label of ['home', 'home2', 'maple-otter-river'])
      expect(OwnAddressLabel.safeParse(label).success, label).toBe(true);
    for (const host of ['home.whombat.app', 'home.box.whombat.app', 'home.dev.whombat.app'])
      expect(OwnAddressHost.safeParse(host).success, host).toBe(true);
    expect(OwnAddressCheckInput.safeParse({ label: 'x' }).success).toBe(true);
    expect(
      OwnAddressCheckOutput.safeParse({ label: 'home', verdict: 'free', host: 'home.whombat.app' }).success,
    ).toBe(true);
  });

  it('carries the leaving address in the summary and the ticket', () => {
    const leaving = {
      host: 'maple-otter-river.box.whombat.app',
      url: 'https://maple-otter-river.box.whombat.app/',
      until: '2026-12-23T10:00:00.000Z',
    };
    expect(OwnAddressSummary.parse({ ...summary, leaving }).leaving).toEqual(leaving);
    expect(OwnAddressSummary.safeParse(summary).success).toBe(true);
    expect(AdmissionClaims.shape.plbl.safeParse('maple-otter-river').success).toBe(true);
  });
});
