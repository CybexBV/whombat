/** The burrow name's menu (whombat-switcher.md AP-3080…AP-3084): which Whombats it offers, in what order, and what each says. */
import { describe, expect, it } from 'vitest';
import type { ApplianceSummary } from './control';
import type { KnownAppliance } from './registry';
import { showsSwitcher, switcherRows } from './switcher';

const NOW = 1_790_000_000_000;
const PEER = `12D3KooW${'A'.repeat(44)}`;

const summary = (
  device: string,
  name: string | null,
  lastSeenAt: number | null,
  state: ApplianceSummary['state'] = 'claimed',
): ApplianceSummary => ({
  device,
  orgId: 'org_lumio',
  name,
  state,
  contentPeerId: PEER,
  lastSeenAt,
  revocationsPending: 0,
});

const known = (device: string, enrolled: boolean): KnownAppliance => ({
  device,
  orgId: 'org_lumio',
  name: null,
  peerId: PEER,
  pinSource: 'claim',
  enrolled,
  kitPending: false,
});

const LIST = [
  summary('dev_tracker', 'Support office', NOW / 1000 - 3 * 3600),
  summary('dev_lumio', 'Lumio', NOW / 1000 - 10),
  summary('dev_lab', 'Lab box', NOW / 1000 - 30),
  summary('dev_home', 'Pals thuis', NOW / 1000 - 60),
  summary('dev_old', 'Old box', NOW / 1000 - 60, 'retired'),
  summary('dev_new', null, null),
];
const KNOWN = new Map([
  ['dev_lumio', known('dev_lumio', true)],
  ['dev_home', known('dev_home', true)],
  ['dev_tracker', known('dev_tracker', true)],
  ['dev_lab', known('dev_lab', false)],
]);

describe('switcherRows', () => {
  const rows = switcherRows(LIST, { current: 'dev_lumio', known: (d) => KNOWN.get(d), now: NOW });

  it('puts the open Whombat first, the others by name, and leaves retired ones out', () => {
    expect(rows.map((r) => r.device)).toEqual(['dev_lumio', 'dev_new', 'dev_lab', 'dev_home', 'dev_tracker']);
    expect(rows[0]?.here).toBe(true);
  });

  it('says online, last seen, never seen, or that this device needs setting up', () => {
    const by = new Map(rows.map((r) => [r.device, r]));
    expect(by.get('dev_lumio')?.meta).toBe('This Whombat');
    expect(by.get('dev_home')).toMatchObject({ online: true, setUp: false, meta: 'Online' });
    expect(by.get('dev_tracker')).toMatchObject({ online: false, setUp: false });
    expect(by.get('dev_tracker')?.meta).toContain('3 hours ago');
    // Pinned but not let in, and not pinned at all: both set up first.
    expect(by.get('dev_lab')).toMatchObject({ online: true, setUp: true, meta: 'Set up this device' });
    expect(by.get('dev_new')).toMatchObject({ name: 'dev_new', setUp: true });
  });
});

describe('showsSwitcher', () => {
  it('only with another Whombat to go to', () => {
    const one = switcherRows([summary('dev_lumio', 'Lumio', null)], {
      current: 'dev_lumio',
      known: (d) => KNOWN.get(d),
    });
    expect(showsSwitcher(one)).toBe(false);
    const withRetired = switcherRows(
      [summary('dev_lumio', 'Lumio', null), summary('dev_old', 'Old', null, 'retired')],
      { current: 'dev_lumio', known: (d) => KNOWN.get(d) },
    );
    expect(showsSwitcher(withRetired)).toBe(false);
    expect(
      showsSwitcher(switcherRows(LIST, { current: 'dev_lumio', known: (d) => KNOWN.get(d), now: NOW })),
    ).toBe(true);
  });
});
