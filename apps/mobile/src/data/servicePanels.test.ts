import { thingButtonView, thingProgressPct } from '@whombat/client';
import type {
  ThingControl,
  ThingGalleryItem,
  ThingPage,
  ThingPageButton,
  ThingPagePanel,
} from '@whombat/core';
import { createServicePages, SERVICE_THINGS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { tableRows } from './dashboard';
import {
  buttonHint,
  controlTile,
  galleryItems,
  galleryLayout,
  LINE_PICTURE_WIDTH,
  POSTER_WIDTH,
  pressNote,
  rowsOf,
  SERVICE_COPY,
} from './servicePanels';
import { listRows, noticeRows, readOnShow, shownPanels, thingPageInterval } from './thingPage';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const TZ = 'Europe/Amsterdam';

const button = (b: Partial<ThingPageButton> = {}): ThingPageButton => ({
  action: 'approve',
  label: 'Approve',
  allowed: true,
  ...b,
});

const panelsOf = (page: ThingPage | null) => page?.tabs[0]?.panels ?? [];
const find = <K extends ThingPagePanel['kind']>(page: ThingPage | null, kind: K, id?: string) =>
  panelsOf(page).find(
    (p): p is Extract<ThingPagePanel, { kind: K }> => p.kind === kind && (!id || p.id === id),
  );

describe('galleries (AP-4636)', () => {
  it('lay posters in a row that scrolls, snapshots two by two, thumbnails three by three', () => {
    expect(galleryLayout('poster')).toEqual({ kind: 'row', width: POSTER_WIDTH });
    expect(galleryLayout('wide')).toEqual({ kind: 'grid', columns: 2 });
    expect(galleryLayout('square')).toEqual({ kind: 'grid', columns: 3 });
    expect(rowsOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('give each item its words, progress, link and buttons; an app page wins over the service’s', () => {
    const items: ThingGalleryItem[] = [
      {
        id: 'a',
        title: 'Dune: Part Two',
        sub: '2024 · Asked by Anna',
        badge: { text: 'Converting', tone: 'warn' },
        progress: 0.634,
        note: '63 % · 12 min left',
        href: '/things/connection%3Acon_sabnzbd',
        url: 'https://example.com/dune',
        actions: [button(), button({ action: 'decline', label: 'Decline' })],
      },
      { id: 'b', title: '’71', at: new Date(NOW - 3_600_000).toISOString(), url: 'https://example.com/71' },
      { id: 'c', title: 'Garage', muted: true },
    ];
    const [a, b, c] = galleryItems({ items }, NOW, TZ);
    expect(a?.link).toEqual({ kind: 'href', href: '/things/connection%3Acon_sabnzbd' });
    expect(a?.linkHint).toBe(SERVICE_COPY.opensPage);
    expect(a?.pct).toBe(thingProgressPct(0.634));
    expect(a?.actions.map((x) => x.action)).toEqual(['approve', 'decline']);
    expect(a?.spoken).toContain('Dune: Part Two');
    expect(a?.spoken).toContain('Converting');
    // Without `sub`, when it was added; the letter of an empty box skips punctuation.
    expect(b?.sub).toMatch(/^\d{2}:\d{2}$/);
    expect(b?.initial).toBe('7');
    expect(b?.link).toEqual({ kind: 'url', url: 'https://example.com/71' });
    expect(b?.linkHint).toBe(SERVICE_COPY.opensBrowser);
    expect([c?.muted, c?.link, c?.image, c?.pct]).toEqual([true, null, null, null]);
  });

  it('size a list line’s small picture by its shape', () => {
    expect(LINE_PICTURE_WIDTH).toEqual({ poster: 30, square: 38, wide: 64 });
  });
});

describe('controls (AP-4640)', () => {
  const light: ThingControl = {
    id: 'light.hall',
    label: 'Hall light',
    icon: 'light',
    on: false,
    state: 'Off',
    toggle: button({ action: 'toggle', target: 'light.hall', label: 'Turn on' }),
  };

  it('light a switch as the person set it, a value tile by the page’s `on`', () => {
    expect(controlTile(light, true)).toMatchObject({ look: 'switch', lit: true, spoken: 'Hall light, Off' });
    expect(controlTile(light, false).lit).toBe(false);
    const thermostat: ThingControl = {
      id: 'climate.living_room',
      label: 'Thermostat',
      on: true,
      stepper: { value: 21, min: 7, max: 30, step: 0.5, button: button({ action: 'set_temperature' }) },
    };
    expect(controlTile(thermostat, false)).toMatchObject({ look: 'stepper', lit: true, state: null });
  });

  it('tone only warn and bad state words', () => {
    expect(
      controlTile({ id: 'l', label: 'Front door', state: 'Unlocked', tone: 'warn' }, false).stateTone,
    ).toBe('warn');
    expect(
      controlTile({ id: 'l', label: 'Front door', state: 'Locked', tone: 'ok' }, false).stateTone,
    ).toBeNull();
  });
});

describe('buttons (AP-4631)', () => {
  it('hint why they can’t be pressed, or the question they ask first', () => {
    const refused = thingButtonView(button({ allowed: false, reason: 'Look only: changes are off.' }));
    expect(buttonHint(refused)).toBe('Look only: changes are off.');
    const asks = thingButtonView(
      button({ confirm: { title: 'Decline it?', body: 'Anna is told.', button: 'Decline' } }),
    );
    expect(buttonHint(asks)).toBe('Decline it?');
    expect(buttonHint(thingButtonView(button()))).toBeUndefined();
  });

  it('toast the server’s words, plain ones for a failure without any', () => {
    expect(pressNote('Approved Dune', 'done')).toBe('Approved Dune');
    expect(pressNote('  ', 'failed')).toBe(SERVICE_COPY.failed);
    expect(pressNote('', 'done')).toBeNull();
  });
});

describe('a service’s rows (AP-4644, AP-4645)', () => {
  const services = createServicePages({ now: () => NOW });

  it('draw a cell’s button instead of its words, and open a row’s outside page', () => {
    const failed = find(services.page(SERVICE_THINGS.sabnzbd), 'table', 'failed');
    if (!failed) throw new Error('no table');
    const rows = tableRows(failed);
    const retry = rows.find((r) => r.actions.some((a) => a.action === 'retry'));
    expect(retry?.actions.map((a) => [a.action, a.target])).toEqual([['retry', retry?.id]]);
    // The button's words are not also in the row's line.
    expect(retry?.line.map((p) => p.text)).not.toContain('Retry');
    const custom: Extract<ThingPagePanel, { kind: 'table' }> = {
      kind: 'table',
      id: 't',
      title: 'Sites',
      columns: [{ key: 'name', label: 'Site' }],
      rows: [
        { id: 'a', cells: { name: { text: 'whombat.com', url: 'https://whombat.com/' } } },
        { id: 'b', cells: { name: { text: 'app', href: '/things/x', url: 'https://app.whombat.com/' } } },
      ],
    };
    expect(tableRows(custom).map((r) => [r.href, r.url])).toEqual([
      [null, 'https://whombat.com/'],
      ['/things/x', null],
    ]);
  });

  it('give a list line its picture, buttons and outside page, a notice its button', () => {
    const issues = find(services.page(SERVICE_THINGS.seerr), 'list', 'issues');
    if (!issues) throw new Error('no list');
    const [line] = listRows(issues, NOW, TZ);
    expect(line?.image?.shape).toBe('poster');
    expect(line?.url).toMatch(/^http/);
    expect(line?.actions.map((a) => a.action)).toEqual(['resolve_issue']);
    const look = find(services.page(SERVICE_THINGS.sabnzbd), 'notices');
    if (!look) throw new Error('no notices');
    expect(noticeRows(look, []).some((n) => n.button?.action === 'clear_warnings')).toBe(true);
  });

  it('show galleries and controls with items or words for none, else leave them out', () => {
    const gallery = (items: number, empty?: string): ThingPagePanel => ({
      kind: 'gallery',
      id: `g${items}${empty ?? ''}`,
      title: 'Recently added',
      shape: 'poster',
      items: Array.from({ length: items }, (_, i) => ({ id: String(i), title: `Film ${i}` })),
      ...(empty ? { empty } : {}),
    });
    const controls = (empty?: string): ThingPagePanel => ({
      kind: 'controls',
      id: `c${empty ?? ''}`,
      title: 'Controls',
      groups: [{ id: 'g', title: 'Hall', items: [] }],
      ...(empty ? { empty } : {}),
    });
    expect(
      shownPanels([
        gallery(2),
        gallery(0),
        gallery(0, 'Nothing new.'),
        controls(),
        controls('None yet.'),
      ]).map((p) => p.id),
    ).toEqual(['g2', 'g0Nothing new.', 'cNone yet.']);
  });
});

describe('live while shown (AP-4646)', () => {
  it('reads every `refreshS` while focused, a minute without one, never while away', () => {
    expect(thingPageInterval(true, { refreshS: 5 })).toBe(5_000);
    expect(thingPageInterval(true, {})).toBe(60_000);
    expect(thingPageInterval(true, null)).toBe(60_000);
    expect(thingPageInterval(false, { refreshS: 5 })).toBe(false);
  });

  it('reads a live page at once when shown again with an old copy', () => {
    expect(readOnShow({ refreshS: 10 }, NOW - 11_000, NOW)).toBe(true);
    expect(readOnShow({ refreshS: 10 }, NOW - 3_000, NOW)).toBe(false);
    // Not live: the minute's interval takes care of it.
    expect(readOnShow({}, NOW - 120_000, NOW)).toBe(false);
    expect(readOnShow(null, 0, NOW)).toBe(false);
  });
});
