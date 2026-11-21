import type { DispatchContext } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { trackerTools, trackerTurnLines, unservedTrackerTools } from './tracker';

const burrow = { id: 'brw_1', slug: 'acme', name: 'Acme', timeZone: 'Europe/Amsterdam' };
const granted = {
  connection: 'Acme Desk dev',
  product: 'Acme Desk',
  number: 15,
  access: {
    state: 'granted' as const,
    scopes: ['devices:read', 'audit:read'],
    expiresAt: '2026-10-10T09:30:00.000Z',
    reason: null,
  },
};
const refused = {
  connection: 'Acme Desk dev',
  product: 'Acme Desk',
  number: 15,
  access: {
    state: 'unavailable' as const,
    scopes: [],
    expiresAt: null,
    reason: 'The Acme Desk token may not grant access.',
  },
};

type Ctx = Pick<DispatchContext, 'tracker' | 'burrow'>;

describe('a tracker run’s tools and lines (Whombat report-trackers.md TA-09, TA-10)', () => {
  it('offers the report in a tracker run’s turns and the organization only when granted', () => {
    expect(trackerTools({})).toEqual([]);
    expect(unservedTrackerTools({})).toEqual(['tracker_item', 'tracker_read']);
    expect(trackerTools({ tracker: { ...granted, access: null } })).toEqual(['tracker_item']);
    expect(trackerTools({ tracker: refused })).toEqual(['tracker_item']);
    expect(trackerTools({ tracker: granted })).toEqual(['tracker_item', 'tracker_read']);
    expect(unservedTrackerTools({ tracker: granted })).toEqual([]);
  });

  it('says nothing outside a tracker run, names the report, and says granted or why not', () => {
    expect(trackerTurnLines({ burrow } as Ctx)).toEqual([]);
    const none = trackerTurnLines({ burrow, tracker: { ...granted, access: null } });
    expect(none).toHaveLength(1);
    expect(none[0]).toContain('Acme Desk dev #15');
    expect(none[0]).toContain('tracker_item');
    const open = trackerTurnLines({ burrow, tracker: granted }).join('\n');
    expect(open).toContain('devices:read, audit:read');
    expect(open).toContain('tracker_read');
    const closed = trackerTurnLines({ burrow, tracker: refused }).join('\n');
    expect(closed).toContain('The Acme Desk token may not grant access.');
    expect(closed).not.toContain('tracker_read');
  });
});
