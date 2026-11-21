/**
 * The widgets' runtime over pages in memory (desk-display-server.md “Every connection's widgets”): what *Add a widget*
 * lists and in which order, a slow page, what is kept, one read per thing, and what a widget says when its thing is
 * down, gone, unread or without the panel.
 */
import type { DeskWidgetRef, ThingPage } from '@whombat/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/errors';
import { as, ctxAt, pageOf, widgetsOver } from './thing-testing';
import { GROUPS_READS_AT_ONCE, GROUPS_WAIT_MS, LAST_PAGE_KEEP_MS, PANELS_KEEP_MS, paceOf } from './things';

const plex = (more: Partial<ThingPage> = {}, live = true) =>
  pageOf(
    {
      kpis: [
        { key: 'watching', label: 'Watching now', value: live ? '1' : '0' },
        { key: 'movies', label: 'Movies', value: '1,284' },
      ],
      panels: [
        ...(live
          ? [
              {
                kind: 'gallery' as const,
                id: 'playing',
                place: 'main' as const,
                title: 'Now playing',
                shape: 'poster' as const,
                items: [{ id: 's1', title: 'Dune: Part Two', sub: '2024 · Anna · TV', progress: 0.5 }],
              },
            ]
          : []),
        {
          kind: 'list',
          id: 'log',
          place: 'main',
          title: 'Log',
          items: [{ id: 'l1', title: 'Started' }],
        },
      ],
      refreshS: live ? 5 : 60,
    },
    { catalogId: 'plex', name: 'Plex', ...more },
  );
const device = pageOf(
  { kpis: [{ key: 'temp', label: 'Temperature', value: '21.4', rest: '°C' }] },
  { id: 'device:con_boiler', catalogId: 'device', name: 'Boiler' },
);
const weather = pageOf(
  { kpis: [{ key: 'status', label: 'Status', value: 'Working' }] },
  { id: 'connection:con_weather', catalogId: 'custom_api', name: 'Aardvark weather' },
);
const sab = pageOf(
  { kpis: [{ key: 'speed', label: 'Speed', value: '42 MB/s' }] },
  { catalogId: 'sabnzbd', name: 'SABnzbd' },
);

const PLEX = 'connection:con_plex' as DeskWidgetRef;

/** The page without one of its panels. */
const without = (page: ThingPage, id: string): ThingPage => ({
  ...page,
  tabs: page.tabs.map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== id) })),
});

afterEach(() => vi.useRealTimers());

describe('how long a widget keeps what it drew', () => {
  it('keeps a slow kind’s pace, but follows its page while that asks again sooner', () => {
    expect(paceOf(300, 60)).toBe(300);
    expect(paceOf(300, undefined)).toBe(300);
    // A scrub that moves, or an older reading shown while a newer one is on its way.
    expect(paceOf(300, 30)).toBe(30);
    expect(paceOf(60, 5)).toBe(10);
    expect(paceOf(5, 60)).toBe(10);
  });
});

describe('Add a widget', () => {
  it('lists the designed kinds first, then the rest, each by name', async () => {
    const { widgets } = widgetsOver(
      new Map<string, ThingPage>([
        [weather.id, weather],
        [device.id, device],
        [sab.id, sab],
        [PLEX, plex()],
      ]),
    );
    const groups = await widgets.groups(ctxAt());
    expect(groups.map((g) => g.label)).toEqual(['Plex', 'SABnzbd', 'Aardvark weather', 'Boiler']);
    expect(groups[3]?.mark).toBeUndefined();
    expect(groups[0]?.items[0]).toMatchObject({ type: 'figures', ref: PLEX, name: 'Figures' });
  });

  it('gives a slow page’s figures alone and partial, and the rest once its read is done', async () => {
    vi.useFakeTimers();
    let answer: (p: ThingPage) => void = () => undefined;
    const slow = new Promise<ThingPage>((resolve) => {
      answer = resolve;
    });
    const { widgets } = widgetsOver(new Map([[PLEX, plex()]]), { page: () => slow });
    const first = widgets.groups(ctxAt());
    await vi.advanceTimersByTimeAsync(GROUPS_WAIT_MS);
    const [partial] = await first;
    expect(partial).toMatchObject({ thing: PLEX, partial: true });
    expect(partial?.items.map((i) => i.type)).toEqual(['figures']);
    answer(plex());
    await vi.advanceTimersByTimeAsync(0);
    const [full] = await widgets.groups(ctxAt());
    expect(full?.partial).toBeUndefined();
    expect(full?.items.map((i) => i.opts.panel)).toContain('playing');
  });

  it('reads at most a few pages at once; those still waiting are partial too', async () => {
    vi.useFakeTimers();
    const pages = new Map(Array.from({ length: 8 }, (_, i) => [`connection:con_${i}`, 'pending' as const]));
    const { widgets, reads } = widgetsOver(pages);
    const asked = widgets.groups(ctxAt());
    await vi.advanceTimersByTimeAsync(GROUPS_WAIT_MS);
    const groups = await asked;
    expect(reads).toHaveLength(GROUPS_READS_AT_ONCE);
    expect(groups).toHaveLength(8);
    expect(groups.every((g) => g.partial)).toBe(true);
  });

  it('keeps what a page offers for 10 minutes', async () => {
    const { widgets, reads, clock } = widgetsOver(new Map([[PLEX, plex()]]));
    await widgets.groups(ctxAt());
    await widgets.groups(ctxAt());
    expect(reads).toHaveLength(1);
    clock.add(PANELS_KEEP_MS + 1);
    await widgets.groups(ctxAt());
    expect(reads).toHaveLength(2);
  });

  it('reads one thing now when asked for it alone, and nothing for a thing the viewer doesn’t see', async () => {
    const { widgets, reads, clock } = widgetsOver(new Map([[PLEX, plex()]]));
    await widgets.groups(ctxAt());
    clock.add(6_000);
    const [one] = await widgets.groups(ctxAt(), PLEX);
    expect(one?.thing).toBe(PLEX);
    expect(reads).toHaveLength(2);
    expect(await widgets.groups(ctxAt(), 'connection:con_other' as DeskWidgetRef)).toEqual([]);
    expect(await widgets.groups(ctxAt(), 'server:pve-01' as DeskWidgetRef)).toEqual([]);
  });

  it('leaves out a thing whose page is gone', async () => {
    const { widgets } = widgetsOver(
      new Map<string, ThingPage | Error>([
        [PLEX, plex()],
        ['connection:con_gone', new ApiError('not_found', 'Thing not found.')],
      ]),
    );
    expect((await widgets.groups(ctxAt())).map((g) => g.thing)).toEqual([PLEX]);
  });
});

describe('resolving', () => {
  it('reads each thing once for all its widgets, and once more for another range', async () => {
    const { widgets, reads } = widgetsOver(new Map([[PLEX, plex()]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_a', type: 'figures', ref: PLEX, opts: {} },
      { id: 'w_b', type: 'panel', ref: PLEX, opts: { panel: 'playing' } },
      { id: 'w_c', type: 'panel', ref: PLEX, opts: { panel: 'log' } },
      { id: 'w_d', type: 'panel', ref: PLEX, opts: { panel: 'log', range: '7d' } },
    ]);
    expect([...got.keys()].sort()).toEqual(['w_a', 'w_b', 'w_c', 'w_d']);
    expect(reads.sort()).toEqual([`${PLEX}|24h`, `${PLEX}|7d`]);
  });

  it('answers only figures and panels of connections and devices', async () => {
    const { widgets, reads } = widgetsOver(new Map([[PLEX, plex()]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_clock', type: 'clock', opts: {} },
      { id: 'w_srv', type: 'server', ref: 'server:pve-01' as DeskWidgetRef, opts: {} },
      { id: 'w_bad', type: 'figures', ref: 'widget:x' as DeskWidgetRef, opts: {} },
    ]);
    expect(got.size).toBe(0);
    expect(reads).toEqual([]);
  });

  it('paces figures every minute and a panel at its page’s pace, never under 10 seconds', async () => {
    const { widgets } = widgetsOver(new Map([[PLEX, plex()]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_a', type: 'figures', ref: PLEX, opts: {} },
      { id: 'w_b', type: 'panel', ref: PLEX, opts: { panel: 'playing' } },
    ]);
    expect(got.get('w_a')?.refreshS).toBe(60);
    expect(got.get('w_b')?.refreshS).toBe(10);
  });

  it('says a thing that is down isn’t answering, and that what it runs on is down too', async () => {
    const down = plex({
      status: 'offline',
      runsOn: {
        serverId: 'pve-02',
        guestId: 'lxc/131',
        name: 'pve-02 · CT 131',
        href: '/servers/pve-02',
        how: 'address',
      },
    });
    const spec = [{ id: 'w_b', type: 'panel' as const, ref: PLEX, opts: { panel: 'playing' } }];
    const both = await widgetsOver(new Map([[PLEX, down]]), { down: { 'pve-02': true } }).widgets.resolve(
      ctxAt(),
      spec,
    );
    const view = as(both.get('w_b'), 'text');
    expect(view).toMatchObject({ tone: 'bad', problem: { text: 'Plex isn’t answering' } });
    expect(view.problem?.detail).toContain('pve-02');
    const alone = await widgetsOver(new Map([[PLEX, down]]), { down: { 'pve-02': false } }).widgets.resolve(
      ctxAt(),
      spec,
    );
    expect(as(alone.get('w_b'), 'text').problem?.detail).toBeUndefined();
  });

  it('says a widget’s thing is gone', async () => {
    const { widgets } = widgetsOver(new Map([[PLEX, new ApiError('not_found', 'Thing not found.')]]));
    const got = await widgets.resolve(ctxAt(), [{ id: 'w_a', type: 'figures', ref: PLEX, opts: {} }]);
    expect(as(got.get('w_a'), 'text').problem?.text).toContain('isn’t connected');
  });

  it('shows the last page for 10 minutes when a read fails, then says it couldn’t read it', async () => {
    const pages = new Map<string, ThingPage | Error>([[PLEX, plex()]]);
    const { widgets, clock } = widgetsOver(pages);
    const spec = [{ id: 'w_b', type: 'panel' as const, ref: PLEX, opts: { panel: 'log' } }];
    await widgets.resolve(ctxAt(), spec);
    pages.set(PLEX, new Error('timeout'));
    clock.add(6_000);
    expect((await widgets.resolve(ctxAt(), spec)).get('w_b')?.view.kind).toBe('list');
    clock.add(LAST_PAGE_KEEP_MS);
    const late = as((await widgets.resolve(ctxAt(), spec)).get('w_b'), 'text');
    expect(late.problem?.text).toContain('Plex');
  });

  it('keeps a panel the page left out as empty once it was seen, and says one never seen is gone', async () => {
    const pages = new Map<string, ThingPage>([[PLEX, plex()]]);
    const { widgets, clock } = widgetsOver(pages);
    await widgets.resolve(ctxAt(), [{ id: 'w_b', type: 'panel', ref: PLEX, opts: { panel: 'log' } }]);
    pages.set(PLEX, without(plex({}, false), 'log'));
    clock.add(6_000);
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_b', type: 'panel', ref: PLEX, opts: { panel: 'log' } },
      { id: 'w_c', type: 'panel', ref: PLEX, opts: { panel: 'nowhere' } },
    ]);
    const log = as(got.get('w_b'), 'list');
    expect(log.rows).toEqual([]);
    expect(log.problem).toBeUndefined();
    expect(as(got.get('w_c'), 'text').problem?.text).toContain('Plex');
  });

  it('keeps a panel its kind always offers, never seen, as empty', async () => {
    const { widgets } = widgetsOver(new Map([[PLEX, plex({}, false)]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_b', type: 'panel', ref: PLEX, opts: { panel: 'playing' } },
    ]);
    const playing = as(got.get('w_b'), 'posters');
    expect(playing.items).toEqual([]);
    expect(playing.problem).toBeUndefined();
  });

  it('says why a panel is missing when the page couldn’t be read', async () => {
    const page = plex({ problem: 'Whombat couldn’t reach Plex just now.' }, false);
    const { widgets } = widgetsOver(new Map([[PLEX, page]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_c', type: 'panel', ref: PLEX, opts: { panel: 'other' } },
    ]);
    expect(as(got.get('w_c'), 'text').problem?.text).toBe('Whombat couldn’t reach Plex just now.');
  });

  it('keeps a business’s figures off a locked screen', async () => {
    const mollie = pageOf(
      { kpis: [{ key: 'paid', label: 'Paid today', value: '€ 1,240' }] },
      { catalogId: 'mollie', name: 'Mollie' },
    );
    const { widgets } = widgetsOver(new Map([[mollie.id, mollie]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_a', type: 'figures', ref: mollie.id as DeskWidgetRef, opts: {} },
    ]);
    expect(got.get('w_a')?.private).toBe(true);
  });

  it('shows why a kind couldn’t read in its figures, not the generic “Working”', async () => {
    const page = pageOf(
      {
        kpis: [
          { key: 'status', label: 'Status', value: 'Working' },
          { key: 'response', label: 'Response time', value: '120 ms' },
        ],
      },
      { catalogId: 'tailscale', name: 'Tailscale', problem: 'Tailscale refused Whombat’s key.' },
    );
    const { widgets } = widgetsOver(new Map([[page.id, page]]));
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_a', type: 'figures', ref: page.id as DeskWidgetRef, opts: {} },
    ]);
    expect(as(got.get('w_a'), 'text').problem?.text).toBe('Tailscale refused Whombat’s key.');
    // A kind's own figures stay, even with a problem beside them.
    const own = pageOf(
      { kpis: [{ key: 'speed', label: 'Speed', value: '42 MB/s' }] },
      { catalogId: 'sabnzbd', name: 'SABnzbd', problem: 'Its history couldn’t be read.' },
    );
    const { widgets: w2 } = widgetsOver(new Map([[own.id, own]]));
    const got2 = await w2.resolve(ctxAt(), [
      { id: 'w_b', type: 'figures', ref: own.id as DeskWidgetRef, opts: {} },
    ]);
    expect(as(got2.get('w_b'), 'figures').items[0]?.value).toBe('42 MB/s');
  });

  it('keeps money, people and their devices off a locked screen, and owners’ addresses off the rows', async () => {
    const privateOf = async (page: ThingPage, spec: { type: 'figures' | 'panel'; panel?: string }) => {
      const { widgets } = widgetsOver(new Map([[page.id, page]]));
      const got = await widgets.resolve(ctxAt(), [
        {
          id: 'w_x',
          type: spec.type,
          ref: page.id as DeskWidgetRef,
          opts: spec.panel ? { panel: spec.panel } : {},
        },
      ]);
      return got.get('w_x');
    };
    const table = (id: string) => ({
      kind: 'table' as const,
      id,
      title: id,
      columns: [{ key: 'name', label: 'Name' }],
      rows: [{ id: 'r', cells: { name: { text: 'Anna' } } }],
    });
    // Hetzner's page in slots: What the servers cost a month is a line of In this project.
    const hetzner = pageOf(
      {
        panels: [
          {
            kind: 'list',
            id: 'project',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In this project',
            items: [
              { id: 'servers', title: 'Servers', figure: { value: '3' } },
              { id: 'cost', title: 'Cost a month', figure: { value: '€ 24.10' } },
            ],
          },
        ],
      },
      { catalogId: 'hetzner', name: 'Hetzner' },
    );
    expect((await privateOf(hetzner, { type: 'figures' }))?.private).toBe(true);
    // Fusebox's page in slots: each limit is a figure of its own, what it is worth this month a line of its counts.
    const fusebox = pageOf(
      {
        panels: [
          {
            kind: 'gallery',
            id: 'limits',
            place: 'chart',
            span: 2,
            look: 'rows',
            shape: 'square',
            title: 'Limits now',
            items: [
              {
                id: 'claude-week',
                title: 'Claude · week',
                progress: 0.62,
                note: '62 % used',
                noteEnd: 'out about Wed 15:00',
                badge: { text: 'Runs out early', tone: 'warn' },
              },
              { id: 'codex-week', title: 'ChatGPT · week', progress: 0.22, noteEnd: 'resets Thu 09:00' },
            ],
          },
          {
            kind: 'list',
            id: 'gateway',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Through Fusebox',
            items: [
              { id: 'subscriptions', title: 'Subscriptions', figure: { value: '4' } },
              { id: 'worth', title: 'Worth this month', figure: { value: '$ 412' } },
            ],
          },
          table('people'),
          table('subscriptions'),
          table('who-claude'),
        ],
      },
      { catalogId: 'fusebox', name: 'Fusebox' },
    );
    const figures = await privateOf(fusebox, { type: 'figures' });
    expect(figures?.private).toBe(true);
    expect(figures?.view.kind === 'figures' && figures.view.items.slice(0, 2)).toMatchObject([
      { label: 'Claude · week', value: '62 %', tone: 'warn' },
      { label: 'ChatGPT · week', value: '22 %' },
    ]);
    expect((await privateOf(fusebox, { type: 'panel', panel: 'limits' }))?.private).toBe(false);
    for (const panel of ['people', 'subscriptions', 'who-claude'])
      expect((await privateOf(fusebox, { type: 'panel', panel }))?.private, panel).toBe(true);
    for (const [catalogId, panel] of [
      ['opnsense', 'wireguard'],
      ['tailscale', 'people'],
      ['gitlab', 'reviews'],
      ['forgejo', 'reviews'],
    ] as const) {
      const page = pageOf({ panels: [table(panel)] }, { catalogId, name: catalogId });
      expect((await privateOf(page, { type: 'panel', panel }))?.private, catalogId).toBe(true);
    }
    const tailscale = pageOf(
      {
        panels: [
          {
            kind: 'table',
            id: 'devices',
            title: 'Devices',
            columns: [
              { key: 'device', label: 'Device' },
              { key: 'owner', label: 'Owner' },
              { key: 'os', label: 'OS' },
              { key: 'seen', label: 'Seen' },
            ],
            rows: [
              {
                id: 'd',
                cells: {
                  device: { text: 'laptop' },
                  owner: { text: 'anna@example.com' },
                  os: { text: 'macOS' },
                  seen: { text: 'Now', dot: 'ok' },
                },
              },
            ],
          },
        ],
      },
      { catalogId: 'tailscale', name: 'Tailscale' },
    );
    const devices = await privateOf(tailscale, { type: 'panel', panel: 'devices' });
    expect(devices?.private).toBe(false);
    expect(JSON.stringify(devices?.view)).not.toContain('anna@example.com');
    expect(as(devices, 'list').rows[0]).toMatchObject({ title: 'laptop', detail: 'macOS', meta: 'Now' });
  });

  it('never gives a view the screen can’t take: it says it couldn’t show it, and logs why', async () => {
    const warn = vi.fn();
    const odd = plex({ readAt: 'yesterday' });
    const { widgets } = widgetsOver(new Map([[PLEX, odd]]), { warn });
    const got = await widgets.resolve(ctxAt(), [{ id: 'w_a', type: 'figures', ref: PLEX, opts: {} }]);
    expect(as(got.get('w_a'), 'text').problem).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ widget: 'w_a' }));
  });
});
