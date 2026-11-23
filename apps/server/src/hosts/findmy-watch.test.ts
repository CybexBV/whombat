/** A one-time watch's pace and rule as the server applies them (docs/decisions/findmy-watch.md). Made-up names. */
import { describe, expect, it } from 'vitest';
import { FindMyBackground } from './findmy-background';
import { leavesPlace, paceWithWatch, watchHappened } from './findmy-watch';

describe('paceWithWatch', () => {
  it('reads every 5 minutes while a watch runs, saying whom it watches', () => {
    expect(paceWithWatch(null, 'Noor Visser')).toEqual({
      everyMinutes: 5,
      automation: null,
      watching: 'Noor Visser',
    });
    expect(paceWithWatch({ everyMinutes: 15, automation: 'Tell me', timeline: true }, 'Noor Visser')).toEqual(
      {
        everyMinutes: 5,
        automation: null,
        watching: 'Noor Visser',
      },
    );
    // A sooner own setting stays, with the watch named.
    expect(paceWithWatch({ everyMinutes: 1, automation: null }, 'Noor Visser')).toEqual({
      everyMinutes: 1,
      automation: null,
      watching: 'Noor Visser',
    });
    expect(paceWithWatch({ everyMinutes: 15, automation: null }, undefined)).toEqual({
      everyMinutes: 15,
      automation: null,
    });
  });

  it('tells the page why the Mac reads this often', async () => {
    const bg = new FindMyBackground({
      now: () => 0,
      plans: async () => [
        {
          connectionId: 'con_1',
          serverId: 'studio',
          label: 'Studio',
          pace: { everyMinutes: 5, automation: null, watching: 'Noor Visser' },
        },
      ],
      read: async () => null,
    });
    await bg.tick();
    await bg.settled();
    expect(bg.about('studio')).toEqual({ everyMinutes: 5, automation: null, watching: 'Noor Visser' });
  });
});

describe('watchHappened', () => {
  const row = {
    change: 'leaves' as const,
    place: 'Keizersgracht 12, Amsterdam',
    fromPlace: 'Amsterdam',
    fromAddress: 'Keizersgracht 12, Amsterdam',
    lat: null,
    lon: null,
    accuracyM: null,
  };

  it('reads a leave from the street, and an arrival from Find My’s words', () => {
    expect(
      watchHappened(row, { place: 'Amsterdam', address: 'Keizersgracht 12, Amsterdam', location: null }),
    ).toBe(false);
    expect(watchHappened(row, { place: 'Amsterdam', address: 'Spui 1, Amsterdam', location: null })).toBe(
      true,
    );
    const arrive = { ...row, change: 'arrives' as const, place: 'Home' };
    expect(watchHappened(arrive, { place: 'Home', address: null, location: null })).toBe(true);
  });

  it('names a leave by the street, else Find My’s words', () => {
    expect(leavesPlace({ place: 'Home', address: ' Kerkstraat 4,  Rietveen ' })).toBe(
      'Kerkstraat 4, Rietveen',
    );
    expect(leavesPlace({ place: 'Home', address: null })).toBe('Home');
    expect(leavesPlace({ place: null, address: null })).toBeNull();
  });
});
