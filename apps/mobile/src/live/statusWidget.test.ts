import { describe, expect, it } from 'vitest';
import type { ClearStatusWidgetFilter, StatusWidgetPayload } from '../../modules/whombat-live';
import { COMMUNITY_ORG } from '../managed/community';
import {
  clearCloudStatusWidget,
  createStatusWidgetSync,
  shouldClearStatusWidget,
  statusWidgetPayload,
  statusWidgetSourceFor,
} from './statusWidget';

const TZ = 'Europe/Amsterdam';
const AT = '2026-11-21T13:05:00.000Z'; // 14:05 CET

const overview = {
  summary: { needsYou: 1, working: 0, problems: 0 },
  needsYou: [],
  things: [],
  generatedAt: AT,
};

describe('home-screen status widget bridge model', () => {
  it('prefers the appliance name, falling back to the burrow name and then Whombat', () => {
    expect(
      statusWidgetPayload({
        overview,
        applianceId: 'wb-1',
        applianceName: 'Home',
        burrowName: 'Main',
        timeZone: TZ,
        now: new Date(AT),
      }),
    ).toMatchObject({
      applianceId: 'wb-1',
      boxName: 'Home',
      status: '1 thing needs you',
      tone: 'warn',
      asOf: 'as of 14:05',
      asOfEarlier: 'as of 21 Nov',
      asOfDay: '2026-11-21',
    });

    expect(
      statusWidgetPayload({
        overview: { ...overview, summary: { needsYou: 0, working: 0, problems: 0 } },
        applianceId: 'wb-1',
        applianceName: '  ',
        burrowName: 'Studio',
        timeZone: TZ,
        now: new Date(AT),
      }),
    ).toMatchObject({ boxName: 'Studio', status: 'All good', tone: 'ok' });

    expect(
      statusWidgetPayload({
        overview: { ...overview, summary: { needsYou: 0, working: 0, problems: 0 } },
        applianceId: 'wb-1',
        applianceName: null,
        burrowName: null,
        timeZone: TZ,
        now: new Date(AT),
      }).boxName,
    ).toBe('Whombat');
  });

  it('deduplicates unchanged writes and writes again after clear or failure', async () => {
    const saved: StatusWidgetPayload[] = [];
    const cleared: (string | ClearStatusWidgetFilter | undefined)[] = [];
    let failNext = false;
    const sync = createStatusWidgetSync({
      async setStatusWidget(payload) {
        if (failNext) {
          failNext = false;
          throw new Error('storage busy');
        }
        saved.push(payload);
      },
      async clearStatusWidget(filter) {
        cleared.push(filter);
      },
    });
    const first = statusWidgetPayload({
      overview,
      applianceId: 'wb-1',
      applianceName: 'Home',
      burrowName: null,
      timeZone: TZ,
      now: new Date(AT),
    });

    expect(await sync.push(first)).toBe(true);
    expect(await sync.push(first)).toBe(false);
    expect(saved).toHaveLength(1);

    await sync.clear('wb-1');
    expect(cleared).toEqual(['wb-1']);
    expect(await sync.push(first)).toBe(true);
    expect(saved).toHaveLength(2);

    const updated = { ...first, status: 'All good', tone: 'ok' as const };
    failNext = true;
    expect(await sync.push(updated)).toBe(false);
    expect(await sync.push(updated)).toBe(true);
    expect(saved).toHaveLength(3);
  });

  it('clears a cloud widget on cloud sign-out/expiry even when community boxes are known, without wiping a community widget', async () => {
    expect(statusWidgetSourceFor('org_123')).toBe('cloud');
    expect(statusWidgetSourceFor(COMMUNITY_ORG)).toBe('community');

    const cloudSnap = statusWidgetPayload({
      overview,
      applianceId: 'wb-cloud',
      applianceName: 'Cloud Box',
      burrowName: null,
      source: statusWidgetSourceFor('org_123'),
      timeZone: TZ,
      now: new Date(AT),
    });
    const communitySnap = statusWidgetPayload({
      overview,
      applianceId: 'wb-comm',
      applianceName: 'Home Box',
      burrowName: null,
      source: statusWidgetSourceFor(COMMUNITY_ORG),
      timeZone: TZ,
      now: new Date(AT),
    });
    const legacySnap: StatusWidgetPayload = { ...cloudSnap };
    delete legacySnap.source;

    expect(cloudSnap.source).toBe('cloud');
    expect(communitySnap.source).toBe('community');

    // Simulate the native widget store holding a snapshot while community boxes exist on the phone.
    let stored: StatusWidgetPayload | null = cloudSnap;
    const nativeStore = {
      async clearStatusWidget(filter?: string | ClearStatusWidgetFilter) {
        if (shouldClearStatusWidget(stored, filter)) stored = null;
      },
    };

    // Cloud sign-out / expiry clears a cloud snapshot regardless of known community boxes.
    await clearCloudStatusWidget(nativeStore);
    expect(stored).toBeNull();

    // A pre-upgrade snapshot without `source` is also cleared on cloud sign-out/expiry.
    stored = legacySnap;
    await clearCloudStatusWidget(nativeStore);
    expect(stored).toBeNull();

    // A widget currently showing a community box is kept on cloud sign-out/expiry.
    stored = communitySnap;
    await clearCloudStatusWidget(nativeStore);
    expect(stored).toEqual(communitySnap);

    // Removing that specific community box still clears it by applianceId.
    await nativeStore.clearStatusWidget('wb-comm');
    expect(stored).toBeNull();
  });
});
