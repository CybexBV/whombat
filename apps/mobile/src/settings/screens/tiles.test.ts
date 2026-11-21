import { catalogServers, type DeskCatalog, serverParts } from '@whombat/client/desk';
import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { screenGrid } from '@whombat/screen';
import { describe, expect, it } from 'vitest';
import {
  accountChoices,
  accountName,
  accountShows,
  type CatalogSectionView,
  catalogView,
  fromCatalog,
  onAnotherServer,
  widgetPrivate,
  withAccountItem,
  withServerPart,
} from './catalog';
import {
  didntFitLine,
  sizesLine,
  TILE_MIN,
  TILE_SLOP,
  tileFace,
  tileGeometry,
  tileLabel,
  tileRect,
  tileSpoken,
  tileWhere,
} from './tiles';

describe('the tiles', () => {
  it('fit the box’s 8 × 5 across a 360dp phone with the screen’s proportions, every tile 44dp with its slop', () => {
    // 360dp less the page's 8dp each side, the frame's 6dp padding and its border.
    const t = tileGeometry(screenGrid(1280, 800), 330);
    expect(t.scroll).toBe(false);
    expect(t.width).toBeLessThanOrEqual(330);
    expect(t.cell.w).toBeGreaterThanOrEqual(TILE_MIN);
    expect(t.cell.h).toBeGreaterThanOrEqual(TILE_MIN);
    expect(t.cell.w + 2 * TILE_SLOP).toBeGreaterThanOrEqual(44);
    expect(tileRect(t, { x: 1, y: 1, w: 2, h: 1 })).toEqual({
      left: t.cell.w + t.gap,
      top: t.cell.h + t.gap,
      width: 2 * t.cell.w + t.gap,
      height: t.cell.h,
    });
  });

  it('scroll sideways for a monitor’s 12 columns rather than drawing cells too small to touch', () => {
    const t = tileGeometry(screenGrid(1920, 1080), 330);
    expect(t.cols).toBe(12);
    expect(t.cell.w).toBe(TILE_MIN);
    expect(t.scroll).toBe(true);
    // A portrait tablet's cells are taller than wide, as on the tablet.
    const tall = tileGeometry(screenGrid(820, 1180), 330);
    expect(tall.scroll).toBe(false);
    expect(tall.height).toBeGreaterThan(tall.width);
  });

  it('show what a tile has room for', () => {
    expect(tileFace({ width: 44, height: 44 })).toBe('mark');
    expect(tileFace({ width: 90, height: 44 })).toBe('name');
    expect(tileFace({ width: 90, height: 90 })).toBe('full');
  });

  it('name Whombat’s own by their names and the rest by their view, what they added from, or what they name', () => {
    expect(tileLabel({ id: 'w_1', type: 'work' }, undefined, undefined, 'Neo')).toEqual({
      name: 'Neo’s work',
      of: null,
      mark: null,
    });
    const panel = { id: 'w_2', type: 'panel' as const, ref: 'connection:con_plex' };
    expect(tileLabel(panel, { title: 'Now playing', name: 'Plex', mark: 'plex' }, undefined, 'Neo')).toEqual({
      name: 'Now playing',
      of: 'Plex',
      mark: 'plex',
    });
    expect(tileLabel(panel, undefined, { name: 'Recently added', mark: 'plex', of: 'Plex' }, 'Neo')).toEqual({
      name: 'Recently added',
      of: 'Plex',
      mark: 'plex',
    });
    expect(
      tileLabel({ id: 'w_3', type: 'server', ref: 'server:pve-01' }, undefined, undefined, 'Neo').name,
    ).toBe('pve-01');
    // A server's part by its server, as Add a widget names it; its overview by the server alone.
    const part = { id: 'w_4', type: 'server' as const, ref: 'server:pve-01', opts: { show: 'storage' } };
    expect(tileLabel(part, { title: 'Storage', name: 'pve-01' }, undefined, 'Neo')).toMatchObject({
      name: 'pve-01 · Storage',
      of: null,
    });
    expect(tileLabel({ ...part, opts: {} }, { title: 'pve-01' }, undefined, 'Neo').name).toBe('pve-01');
  });

  it('say where a tile is, counting from one', () => {
    const spoken = tileSpoken({ name: 'Now playing', of: 'Plex', mark: 'plex' }, { x: 4, y: 0, w: 4, h: 2 });
    expect(spoken).toContain('Now playing, Plex');
    expect(spoken).toContain('4 by 2');
    expect(spoken).toContain('column 5');
    expect(spoken).toContain('row 1');
    expect(tileWhere({ x: 0, y: 2, w: 3, h: 1 })).toContain('column 1, row 3');
    expect(sizesLine({ min: [2, 1], max: [6, 3] })).toContain('2 × 1');
    expect(didntFitLine(0)).toBeNull();
    expect(didntFitLine(1)).toContain('It wait');
    expect(didntFitLine(2)).toContain('They wait');
  });
});

describe('Add a widget on the phone', () => {
  const api = () =>
    fakeDeskApi(createFakeDesk({ screens: true, now: () => Date.parse('2026-10-27T14:34:00Z') }), {
      personId: 'p_me',
      name: 'Mara',
    });
  const none = new Set<string>();
  const rowsOf = (sections: CatalogSectionView[]) => sections.flatMap((s) => s.groups.flatMap((g) => g.rows));

  it('folds Whombat’s own, the servers and each server at first, the rest open (DK-155)', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const sections = catalogView(catalog, { query: '', onPage: [], flipped: none });
    // The connections, then the person's own accounts (DK-159), then Home's widgets.
    expect(sections.map((s) => s.kind)).toEqual([
      'own',
      'servers',
      ...sections.slice(2, -2).map(() => 'thing'),
      'accounts',
      'widgets',
    ]);
    const folded = Object.fromEntries(sections.map((s) => [s.key, s.folded]));
    expect(folded).toMatchObject({
      own: true,
      servers: true,
      'connection:con_plex': false,
      accounts: false,
      widgets: false,
    });
    const servers = sections[1];
    // One fold per server, each folded, with its overview and its parts.
    expect(servers?.groups.every((g) => g.server && g.folded)).toBe(true);
    expect(servers?.groups.map((g) => g.key)).toContain('server:pve-01');
    expect(servers?.count).toBeGreaterThan(servers?.groups.length ?? 0);
    // Turning Servers and pve-01 opens them; the other servers stay folded.
    const opened = catalogView(catalog, {
      query: '',
      onPage: [],
      flipped: new Set(['servers', 'server:pve-01']),
    });
    const s = opened.find((x) => x.key === 'servers');
    expect(s?.folded).toBe(false);
    expect(s?.groups.find((g) => g.key === 'server:pve-01')?.folded).toBe(false);
    expect(s?.groups.find((g) => g.key === 'server:nas')?.folded).toBe(true);
    // A thing turned folds.
    expect(
      catalogView(catalog, { query: '', onPage: [], flipped: new Set(['connection:con_plex']) }).find(
        (x) => x.key === 'connection:con_plex',
      )?.folded,
    ).toBe(true);
  });

  it('sizes a server’s part by what it draws, and keys each part apart', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const pve = catalogView(catalog, { query: '', onPage: [], flipped: none })
      .find((s) => s.key === 'servers')
      ?.groups.find((g) => g.key === 'server:pve-01');
    const size = (show: string) => pve?.rows.find((r) => (r.item.opts.show ?? '') === show)?.size;
    expect(size('')).toBe('2 × 2');
    expect(size('cpu')).toBe('4 × 2');
    expect(size('storage')).toBe('3 × 2');
    expect(size('temp')).toBe('2 × 1');
    expect(new Set(pve?.rows.map((r) => r.key)).size).toBe(pve?.rows.length);
  });

  it('offers the rest of a thing that listed part of it, and shows what was read then', async () => {
    const desk = api();
    const catalog = await desk.widgets({ screen: 'box' });
    const thing = 'connection:con_calendar';
    const before = catalogView(catalog, { query: '', onPage: [], flipped: none }).find(
      (s) => s.key === thing,
    );
    expect(before?.groups[0]?.more).toBe(true);
    const whole = (await desk.widgets({ screen: 'box', thing })).groups.find((g) => g.thing === thing);
    const after = catalogView(catalog, {
      query: '',
      onPage: [],
      flipped: none,
      read: { [thing]: whole },
    }).find((s) => s.key === thing);
    expect(after?.groups[0]?.more).toBe(false);
    expect(after?.count).toBeGreaterThan(before?.count ?? 0);
    // The rest never shows on a thing that listed all of it.
    expect(
      catalogView(catalog, { query: '', onPage: [], flipped: none })
        .find((s) => s.key === 'connection:con_plex')
        ?.groups.some((g) => g.more),
    ).toBe(false);
  });

  it('opens whatever a search matches: a server’s name lists all of it, a part’s name finds it on every server', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const pve = catalogView(catalog, { query: 'pve-01', onPage: [], flipped: none });
    expect(pve.map((s) => [s.key, s.folded])).toEqual([['servers', false]]);
    const group = pve[0]?.groups[0];
    expect(group).toMatchObject({ key: 'server:pve-01', folded: false });
    expect(group?.rows.length).toBe(catalog.groups.find((g) => g.key === 'server:pve-01')?.items.length);
    const temp = catalogView(catalog, { query: 'temperature', onPage: [], flipped: none });
    const hot = temp.find((s) => s.key === 'servers');
    expect(hot?.folded).toBe(false);
    expect(hot?.groups.every((g) => g.rows.length === 1 && g.rows[0]?.item.opts.show === 'temp')).toBe(true);
    const plex = catalogView(catalog, {
      query: 'plex',
      onPage: [],
      flipped: new Set(['connection:con_plex']),
    });
    expect(plex.find((s) => s.key === 'connection:con_plex')?.folded).toBe(false);
    // Whombat's own, folded at first, opens for a match too.
    const clock = catalogView(catalog, {
      query: 'time',
      onPage: [{ id: 'w_c', type: 'clock', opts: {}, x: 0, y: 0, w: 3, h: 2 }],
      flipped: none,
    });
    expect(clock.find((s) => s.kind === 'own')?.folded).toBe(false);
    const row = rowsOf(clock).find((r) => r.item.type === 'clock');
    expect(row?.here).toBe(true);
    expect(row?.size).toBe('3 × 2');
    expect(catalogView(catalog, { query: 'zzzz', onPage: [], flipped: none })).toEqual([]);
  });

  it('marks a server’s part on the page by its part, not its overview', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const onPage = [
      {
        id: 'w_s',
        type: 'server' as const,
        ref: 'server:pve-01',
        opts: { show: 'memory' },
        x: 0,
        y: 0,
        w: 4,
        h: 2,
      },
    ];
    const rows = rowsOf(catalogView(catalog, { query: 'pve-01', onPage, flipped: none }));
    expect(rows.filter((r) => r.here).map((r) => r.item.opts.show)).toEqual(['memory']);
  });

  it('adds what an item names and remembers its name and mark for the tile', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const sections = catalogView(catalog, { query: 'plex', onPage: [], flipped: none });
    const group = sections.flatMap((s) => s.groups).find((g) => g.thing);
    const row = group?.rows.find((r) => r.item.type === 'panel');
    if (!group || !row) throw new Error('no Plex');
    const { widget, known } = fromCatalog(row.item, group);
    expect(widget.type).toBe('panel');
    expect(widget.ref).toBe('connection:con_plex');
    expect(widget.opts.panel).toBeTruthy();
    expect(known.of).toBe('Plex');
    expect(known.mark).toBe('plex');
    // A server's part by its server's name.
    const pve = catalogView(catalog, { query: 'pve-01', onPage: [], flipped: none })[0]?.groups[0];
    const storage = pve?.rows.find((r) => r.item.opts.show === 'storage');
    if (!pve || !storage) throw new Error('no pve-01');
    const added = fromCatalog(storage.item, pve);
    expect(added.widget).toMatchObject({ type: 'server', ref: 'server:pve-01', opts: { show: 'storage' } });
    expect(added.known.name).toBe('pve-01 · Storage');
    const overview = pve.rows.find((r) => !r.item.opts.show);
    expect(overview && fromCatalog(overview.item, pve).known.name).toBe('pve-01');
  });

  it('lists each server once for a server widget’s Server, and its parts for Shows', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const servers = catalogServers(catalog);
    expect(servers.map((s) => s.ref)).toContain('server:pve-01');
    expect(new Set(servers.map((s) => s.ref)).size).toBe(servers.length);
    expect(servers.find((s) => s.ref === 'server:pve-01')?.name).toBe('pve-01');
    const parts = serverParts(catalog, 'server:pve-01').map((p) => p.show);
    expect(parts[0]).toBe('');
    expect(parts).toContain('guests');
    expect(serverParts(catalog, 'server:nas').map((p) => p.show)).not.toContain('guests');
  });

  it('keeps a server widget’s part and range when it can, else shows the overview', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    expect(withServerPart({ range: '7d' }, 'cpu')).toEqual({ range: '7d', show: 'cpu' });
    expect(withServerPart({ range: '7d', show: 'cpu' }, '')).toEqual({ range: '7d' });
    const guests = { range: '1h', show: 'guests' };
    expect(onAnotherServer(guests, serverParts(catalog, 'server:pve-02'))).toEqual(guests);
    expect(onAnotherServer(guests, serverParts(catalog, 'server:nas'))).toEqual({ range: '1h' });
    expect(onAnotherServer({ show: 'memory' }, [])).toEqual({});
  });

  it('offers On a locked screen where the item says it’s private, else for what’s playing and cameras', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const plex = { type: 'panel' as const, ref: 'connection:con_plex', opts: { panel: 'now-playing' } };
    const said = catalog.groups
      .flatMap((g) => g.items)
      .find((i) => i.ref === plex.ref && i.opts.panel === plex.opts.panel);
    expect(widgetPrivate(plex, catalog.groups, 'posters')).toBe(said?.private ?? true);
    expect(widgetPrivate({ ...plex, opts: { panel: 'nothing-like-it' } }, [], 'camera')).toBe(true);
    expect(widgetPrivate({ ...plex, opts: { panel: 'nothing-like-it' } }, [], 'figures')).toBe(false);
    expect(
      widgetPrivate(
        { type: 'panel', ref: 'connection:x', opts: { panel: 'p' } },
        [
          {
            items: [
              {
                type: 'panel',
                ref: 'connection:x',
                opts: { panel: 'p' },
                name: 'P',
                line: '',
                private: true,
              },
            ],
          },
        ],
        'figures',
      ),
    ).toBe(true);
    expect(widgetPrivate({ type: 'clock', opts: {} }, catalog.groups, undefined)).toBe(false);
    // A server's alerts are private, its overview and figures aren't.
    const server = { type: 'server' as const, ref: 'server:pve-01' };
    expect(widgetPrivate({ ...server, opts: { show: 'alerts' } }, catalog.groups, 'list')).toBe(true);
    expect(widgetPrivate({ ...server, opts: {} }, catalog.groups, 'server')).toBe(false);
    expect(widgetPrivate({ ...server, opts: { show: 'storage' } }, catalog.groups, 'list')).toBe(false);
  });
});

/** The runtime's account groups, a photo and a board (DK-159…DK-162), until the demo world has them. */
const ACCOUNTS: DeskCatalog = {
  groups: [
    { key: 'own', label: 'Whombat and Mara', items: [{ type: 'clock', opts: {}, name: 'Clock', line: '' }] },
    {
      key: 'account:acc_g',
      label: 'anna@example.com',
      mark: 'google',
      thing: 'account:acc_g',
      items: [
        {
          type: 'panel',
          ref: 'account:acc_g',
          opts: { panel: 'today' },
          name: 'Today',
          line: '',
          view: 'list',
          private: true,
        },
        {
          type: 'panel',
          ref: 'account:acc_g',
          opts: { panel: 'next-meeting' },
          name: 'Next meeting',
          line: '',
          view: 'figures',
          private: true,
        },
        {
          type: 'panel',
          ref: 'account:acc_g',
          opts: { panel: 'unread' },
          name: 'Unread mail',
          line: '',
          view: 'list',
          private: true,
        },
      ],
    },
    {
      key: 'connection:con_immich',
      label: 'Immich',
      mark: 'immich',
      thing: 'connection:con_immich',
      items: [
        {
          type: 'panel',
          ref: 'connection:con_immich',
          opts: { panel: 'on-this-day' },
          name: 'On this day',
          line: '',
          view: 'photo',
        },
        {
          type: 'panel',
          ref: 'connection:con_immich',
          opts: { panel: 'albums' },
          name: 'Albums',
          line: '',
          view: 'board',
        },
      ],
    },
    {
      key: 'account:github',
      label: 'GitHub',
      mark: 'github',
      thing: 'account:github',
      items: [
        {
          type: 'panel',
          ref: 'account:github',
          opts: { panel: 'pulls' },
          name: 'Pull requests',
          line: '',
          view: 'list',
        },
        {
          type: 'panel',
          ref: 'account:github',
          opts: { panel: 'review' },
          name: 'Waiting for review',
          line: '',
          view: 'list',
        },
      ],
    },
  ],
};

describe('the person’s accounts, photos and boards on the phone', () => {
  const none = new Set<string>();
  const accounts = (flipped: ReadonlySet<string> = none, query = '') =>
    catalogView(ACCOUNTS, { query, onPage: [], flipped }).find((s) => s.kind === 'accounts');

  it('puts every account under one Your accounts, each its own fold, open at first', () => {
    const sections = catalogView(ACCOUNTS, { query: '', onPage: [], flipped: none });
    expect(sections.map((s) => s.kind)).toEqual(['own', 'accounts', 'thing']);
    const mine = accounts();
    expect(mine).toMatchObject({ key: 'accounts', label: 'Your accounts', folded: false, count: 5 });
    expect(mine?.groups.map((g) => [g.key, g.account, g.server, g.folded, g.mark])).toEqual([
      ['account:acc_g', true, false, false, 'google'],
      ['account:github', true, false, false, 'github'],
    ]);
    // Turned, an account folds and the other stays open; turned, the section folds.
    const folded = accounts(new Set(['account:acc_g']));
    expect(folded?.groups.map((g) => g.folded)).toEqual([true, false]);
    expect(accounts(new Set(['accounts']))?.folded).toBe(true);
    // Immich's group isn't an account's.
    expect(sections.find((s) => s.key === 'connection:con_immich')?.groups[0]?.account).toBe(false);
  });

  it('finds an account by who holds it and a widget by its name', () => {
    expect(accounts(none, 'google')?.groups.map((g) => g.rows.length)).toEqual([3]);
    const unread = accounts(none, 'unread');
    expect(unread?.groups.flatMap((g) => g.rows.map((r) => r.item.opts.panel))).toEqual(['unread']);
    expect(accounts(new Set(['account:acc_g']), 'unread')?.groups[0]?.folded).toBe(false);
  });

  it('names an account by who holds it and its address', () => {
    expect(accountName({ label: 'anna@example.com', mark: 'google' })).toBe('Google · anna@example.com');
    expect(accountName({ label: 'Google · anna@example.com', mark: 'google' })).toBe(
      'Google · anna@example.com',
    );
    expect(accountName({ label: 'GitHub', mark: 'github' })).toBe('GitHub');
    expect(accountName({ label: 'me@home.nl', mark: 'mail' })).toBe('Email · me@home.nl');
    expect(accountName({ label: 'anna@example.com' })).toBe('anna@example.com');
  });

  it('knows what an account’s widget shows, for its icon', () => {
    const of = (ref: string, panel: string) => accountShows({ ref, opts: { panel } });
    expect(of('account:acc_g', 'today')).toBe('calendar');
    expect(of('account:acc_g', 'next-meeting')).toBe('calendar');
    expect(of('account:acc_g', 'unread')).toBe('mail');
    expect(of('account:github', 'review')).toBe('pulls');
    expect(of('account:acc_g', 'something-new')).toBeNull();
    expect(of('connection:con_plex', 'today')).toBeNull();
  });

  it('sizes a photo and a board by what they draw, and adds an account’s widget named by its account', () => {
    const immich = catalogView(ACCOUNTS, { query: '', onPage: [], flipped: none }).find(
      (s) => s.key === 'connection:con_immich',
    );
    expect(immich?.groups[0]?.rows.map((r) => r.size)).toEqual(['4 × 3', '4 × 2']);
    const google = accounts()?.groups[0];
    const today = google?.rows[0];
    if (!google || !today) throw new Error('no Google');
    const { widget, known } = fromCatalog(today.item, google);
    expect(widget).toEqual({ type: 'panel', ref: 'account:acc_g', opts: { panel: 'today' } });
    expect(known).toMatchObject({
      name: 'Today',
      of: 'Google · anna@example.com',
      mark: 'google',
      view: 'list',
    });
    const photo = immich?.groups[0]?.rows[0];
    if (!photo || !immich?.groups[0]) throw new Error('no Immich');
    expect(fromCatalog(photo.item, immich.groups[0]).known).toMatchObject({ of: 'Immich', view: 'photo' });
  });

  it('offers the other widgets of the same account, keeping On a locked screen where the new one is private', () => {
    const w = { type: 'panel' as const, ref: 'account:acc_g' };
    expect(accountChoices(ACCOUNTS, w).map((i) => i.opts.panel)).toEqual(['today', 'next-meeting', 'unread']);
    expect(accountChoices(ACCOUNTS, { type: 'panel', ref: 'account:github' })).toHaveLength(2);
    expect(accountChoices(ACCOUNTS, { type: 'panel', ref: 'connection:con_immich' })).toEqual([]);
    expect(accountChoices(undefined, w)).toEqual([]);
    expect(
      withAccountItem({ panel: 'today', lock: 'show' }, { opts: { panel: 'unread' }, private: true }),
    ).toEqual({
      panel: 'unread',
      lock: 'show',
    });
    expect(withAccountItem({ panel: 'pulls', lock: 'show' }, { opts: { panel: 'review' } })).toEqual({
      panel: 'review',
    });
  });

  it('offers On a locked screen for calendar, mail and photos, not for pull requests or a board', () => {
    const g = ACCOUNTS.groups;
    expect(widgetPrivate({ type: 'panel', ref: 'account:acc_g', opts: { panel: 'unread' } }, g, 'list')).toBe(
      true,
    );
    expect(widgetPrivate({ type: 'panel', ref: 'account:github', opts: { panel: 'pulls' } }, g, 'list')).toBe(
      false,
    );
    // Before the catalogue is read: an account's widget is private, the Whombat's GitHub isn't.
    expect(widgetPrivate({ type: 'panel', ref: 'account:acc_x', opts: { panel: 'today' } }, [], 'list')).toBe(
      true,
    );
    expect(
      widgetPrivate({ type: 'panel', ref: 'account:github', opts: { panel: 'pulls' } }, [], 'list'),
    ).toBe(false);
    const immich = { type: 'panel' as const, ref: 'connection:con_immich' };
    expect(widgetPrivate({ ...immich, opts: { panel: 'x' } }, [], 'photo')).toBe(true);
    expect(widgetPrivate({ ...immich, opts: { panel: 'x' } }, [], 'board')).toBe(false);
  });

  it('remembers what a tile draws, so a photo and a board say so', () => {
    const w = { id: 'w_p', type: 'panel' as const, ref: 'connection:con_immich' };
    expect(
      tileLabel(w, { title: 'On this day', name: 'Immich', mark: 'immich', kind: 'photo' }, undefined, 'Neo'),
    ).toEqual({
      name: 'On this day',
      of: 'Immich',
      mark: 'immich',
      view: 'photo',
    });
    expect(tileLabel(w, undefined, { name: 'Albums', of: 'Immich', view: 'board' }, 'Neo').view).toBe(
      'board',
    );
  });
});
