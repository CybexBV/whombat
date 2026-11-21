/**
 * `glance.found` (docs/decisions/desk-found.md DF-03, DF-06, DF-07; DF-S09): the first automatic scan's looking state,
 * the result after it, what isn't new left out, Not now, eight named and the rest counted, and only the time without it.
 */
import { describe, expect, it } from 'vitest';
import type { BurrowFound, Found } from '../connections/discover';
import { deskFound, FOUND_ITEMS_MAX, type FoundInputs } from './found';
import { EMPTY_GLANCE, type FullGlance, trimGlance } from './glance';

const found = (catalogId: string, host: string, port: number): Found => ({
  catalogId,
  host,
  port,
  url: `http://${host}:${port}`,
  version: null,
  certificate: null,
});

const HA = found('homeassistant', '10.100.0.5', 8123);
const PVE = found('proxmox', '10.100.0.240', 8006);
const PIHOLE = found('pihole', '10.100.0.3', 80);
const FINISHED = new Date('2026-10-20T09:00:00Z');

const inputs = (over: Partial<FoundInputs> = {}): FoundInputs => ({
  isNew: () => true,
  firstScanAt: null,
  putAway: false,
  ...over,
});

const looking = (done: number, total: number, list: Found[]): BurrowFound => ({
  running: { automatic: true, done, total, found: list },
  last: null,
});

describe('found on your network on the glance (DF-06, DF-07)', () => {
  it('shows the first automatic scan looking, before anything is found, with its progress', () => {
    expect(deskFound(looking(412, 1022, []), inputs())).toEqual({
      scanning: true,
      progress: { done: 412, total: 1022 },
      items: [],
      count: 0,
      finishedAt: null,
    });
    const some = deskFound(looking(600, 1022, [PIHOLE, HA]), inputs());
    expect(some?.items.map((i) => i.catalogId)).toEqual(['homeassistant', 'pihole']);
    expect(some?.items[0]).toMatchObject({ name: 'Home Assistant', address: '10.100.0.5' });
    expect(some?.items[0]?.tagline).toBeTruthy();
  });

  it('keeps the last result while a later scan runs, without the looking state', () => {
    const scans: BurrowFound = {
      running: { automatic: true, done: 5, total: 1022, found: [] },
      last: { finishedAt: FINISHED, found: [PVE, HA] },
    };
    expect(deskFound(scans, inputs({ firstScanAt: FINISHED }))).toEqual({
      scanning: true,
      progress: null,
      items: [
        expect.objectContaining({ catalogId: 'homeassistant' }),
        expect.objectContaining({ catalogId: 'proxmox' }),
      ],
      count: 2,
      finishedAt: FINISHED.toISOString(),
    });
  });

  it('after a restart, shows what the running scan found so far until it is done', () => {
    const scans: BurrowFound = {
      running: { automatic: true, done: 5, total: 1022, found: [HA] },
      last: null,
    };
    expect(deskFound(scans, inputs({ firstScanAt: FINISHED }))).toMatchObject({
      scanning: true,
      progress: null,
      count: 1,
      finishedAt: null,
    });
    expect(deskFound({ running: null, last: null }, inputs({ firstScanAt: FINISHED }))).toBeNull();
  });

  it('leaves out what is connected or hidden, and shows nothing when nothing new is left', () => {
    const done: BurrowFound = { running: null, last: { finishedAt: FINISHED, found: [HA, PVE] } };
    const notHa = inputs({ firstScanAt: FINISHED, isNew: (f) => f.catalogId !== 'homeassistant' });
    expect(deskFound(done, notHa)?.items.map((i) => i.catalogId)).toEqual(['proxmox']);
    expect(deskFound(done, inputs({ firstScanAt: FINISHED, isNew: () => false }))).toBeNull();
  });

  it('shows nothing after Not now, even while the first scan looks (DF-04)', () => {
    expect(deskFound(looking(1, 10, [HA]), inputs({ putAway: true }))).toBeNull();
  });

  it('names eight and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) => found('grafana', `10.100.0.${10 + i}`, 3000));
    const shown = deskFound({ running: null, last: { finishedAt: FINISHED, found: many } }, inputs());
    expect(shown?.items).toHaveLength(FOUND_ITEMS_MAX);
    expect(shown?.count).toBe(11);
    expect(shown?.items[0]?.address).toBe('10.100.0.10');
  });
});

const EMPTY: FullGlance = EMPTY_GLANCE;

describe('found in the trimmed glance (DF-06, DF-11)', () => {
  const panel = deskFound(looking(1, 10, [HA]), inputs());

  it('shows locked in a summary and unlocked, never in Only the time', () => {
    expect(trimGlance(EMPTY, { unlocked: false, view: 'summary' }, null, panel).found).toEqual(panel);
    expect(trimGlance(EMPTY, { unlocked: true, view: 'time' }, null, panel).found).toEqual(panel);
    expect(trimGlance(EMPTY, { unlocked: false, view: 'time' }, null, panel).found).toBeUndefined();
    expect(trimGlance(EMPTY, { unlocked: false, view: 'summary' }, null, null).found).toBeUndefined();
  });
});
