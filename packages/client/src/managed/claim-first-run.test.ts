/** The first run (AP-75): an organization without Whombats looks nearby first; what `claims.nearby` found. */
import { describe, expect, it } from 'vitest';
import { looksNearbyFirst, nearbyClaimStep } from './claim';
import type { ApplianceSummary, NearbyAppliance } from './control';

const box = (device: string): NearbyAppliance => ({
  device,
  model: 'wb-mini-1',
  registeredAt: 1,
  lastSeenAt: 2,
});
const mine: ApplianceSummary = {
  device: 'dev_1',
  orgId: 'org_1',
  name: 'Acme',
  state: 'claimed',
  contentPeerId: 'peer',
  lastSeenAt: null,
  revocationsPending: 0,
};

describe('nearbyClaimStep', () => {
  it('shows nothing, the one box, or several to pick from', () => {
    expect(nearbyClaimStep([])).toEqual({ kind: 'none' });
    expect(nearbyClaimStep([box('a')])).toEqual({ kind: 'found', box: box('a') });
    expect(nearbyClaimStep([box('a'), box('b')])).toEqual({ kind: 'pick', boxes: [box('a'), box('b')] });
  });
});

describe('looksNearbyFirst', () => {
  it('looks for an organization without Whombats', () => {
    expect(looksNearbyFirst([])).toBe(true);
  });

  it('does not look while the list loads, or once there is a Whombat', () => {
    expect(looksNearbyFirst(null)).toBe(false);
    expect(looksNearbyFirst([mine])).toBe(false);
  });
});
