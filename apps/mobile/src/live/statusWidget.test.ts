import { describe, expect, it } from 'vitest';
import type { StatusWidgetPayload } from '../../modules/whombat-live';
import { createStatusWidgetSync, statusWidgetPayload } from './statusWidget';

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
    const cleared: (string | undefined)[] = [];
    let failNext = false;
    const sync = createStatusWidgetSync({
      async setStatusWidget(payload) {
        if (failNext) {
          failNext = false;
          throw new Error('storage busy');
        }
        saved.push(payload);
      },
      async clearStatusWidget(applianceId) {
        cleared.push(applianceId);
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
});
