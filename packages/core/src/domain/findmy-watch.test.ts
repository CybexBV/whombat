/** A one-time Find My watch's rule and words (docs/decisions/findmy-watch.md). Made-up names and places only. */
import { describe, expect, it } from 'vitest';
import {
  FIND_MY_WATCH_AWAY_M,
  type FindMyWatchView,
  findMyDistanceM,
  findMyWatchArrived,
  findMyWatchCardLines,
  findMyWatchEndText,
  findMyWatchLeft,
  findMyWatchStartText,
} from './findmy-watch';

const spot = (lat: number, lon = 4.9, accuracyM = 100) => ({ lat, lon, accuracyM });
// About 111 m of latitude per 0.001 degree.
const near = spot(52.3701);
const far = spot(52.376);

describe('findMyDistanceM', () => {
  it('measures metres between two spots', () => {
    expect(findMyDistanceM(spot(52.37), spot(52.371))).toBeCloseTo(111, 0);
  });
});

describe('findMyWatchLeft', () => {
  const origin = { place: 'Amsterdam', address: 'Keizersgracht 12, Amsterdam', spot: spot(52.37) };

  it('needs another street and more than the distance a spot can be off', () => {
    expect(
      findMyWatchLeft(origin, { place: 'Amsterdam', address: 'Keizersgracht 12, Amsterdam', location: far }),
    ).toBe(false);
    expect(
      findMyWatchLeft(origin, { place: 'Amsterdam', address: 'Spui 1, Amsterdam', location: near }),
    ).toBe(false);
    expect(findMyWatchLeft(origin, { place: 'Amsterdam', address: 'Spui 1, Amsterdam', location: far })).toBe(
      true,
    );
  });

  it('takes a poor spot’s accuracy as the distance it must be beyond', () => {
    const fuzzy = { ...far, accuracyM: 2000 };
    expect(findMyDistanceM(origin.spot, far)).toBeGreaterThan(FIND_MY_WATCH_AWAY_M);
    expect(
      findMyWatchLeft(origin, { place: 'Amsterdam', address: 'Spui 1, Amsterdam', location: fuzzy }),
    ).toBe(false);
  });

  it('without spots compares streets, then place words', () => {
    const noSpot = { ...origin, spot: null };
    expect(
      findMyWatchLeft(noSpot, {
        place: 'Amsterdam',
        address: 'keizersgracht 12,  amsterdam',
        location: null,
      }),
    ).toBe(false);
    expect(
      findMyWatchLeft(noSpot, { place: 'Amsterdam', address: 'Spui 1, Amsterdam', location: null }),
    ).toBe(true);
    const wordsOnly = { place: 'Home', address: null, spot: null };
    expect(findMyWatchLeft(wordsOnly, { place: 'Home', address: null, location: null })).toBe(false);
    expect(findMyWatchLeft(wordsOnly, { place: 'Lelystad', address: null, location: null })).toBe(true);
  });

  it('never fires on a read with no location', () => {
    expect(findMyWatchLeft(origin, { place: null, address: null, location: null })).toBe(false);
  });
});

describe('findMyWatchArrived', () => {
  it('matches Find My’s place words without case or spaces', () => {
    expect(findMyWatchArrived('Home', { place: ' home ' })).toBe(true);
    expect(findMyWatchArrived('Home', { place: 'Work' })).toBe(false);
    expect(findMyWatchArrived('Home', { place: null })).toBe(false);
  });
});

describe('the words', () => {
  const watch: FindMyWatchView = {
    id: 'fmw_1',
    name: 'Noor Visser',
    change: 'leaves',
    place: 'Keizersgracht 12, Amsterdam',
    status: 'watching',
    startedAt: '2026-11-23T13:05:00.000Z',
    endsAt: '2026-11-24T13:05:00.000Z',
    endedAt: null,
    to: null,
  };
  const now = '2026-11-23T13:05:00.000Z';

  it('names who and where, and until when with Cancel while it watches', () => {
    expect(findMyWatchStartText(watch)).toContain('Noor Visser');
    const lines = findMyWatchCardLines(watch, 'Europe/Amsterdam', now);
    expect(lines.canCancel).toBe(true);
    expect(lines.title).toContain('Keizersgracht 12');
    expect(lines.detail).toContain('tomorrow');
    expect(lines.detail).toContain('14:05');
  });

  it('says where they went once it happened, and nothing when cancelled', () => {
    const happened = { ...watch, status: 'happened' as const, to: 'Amstelveen', endedAt: now };
    expect(findMyWatchEndText(happened)).toContain('Amstelveen');
    expect(findMyWatchCardLines(happened, 'Europe/Amsterdam', now)).toMatchObject({
      canCancel: false,
      detail: null,
    });
    expect(findMyWatchEndText({ ...watch, status: 'cancelled' })).toBeNull();
    expect(findMyWatchEndText({ ...watch, change: 'arrives', place: 'Home', status: 'happened' })).toContain(
      'at Home',
    );
    expect(findMyWatchEndText({ ...watch, status: 'expired' })).toContain('24 hours');
  });
});
