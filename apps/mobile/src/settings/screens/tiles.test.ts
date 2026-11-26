import {
  type CatalogRows,
  catalogGroupOf,
  catalogRows,
  catalogServers,
  type DeskCatalog,
  serverParts,
} from '@whombat/client/desk';
import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { screenGrid } from '@whombat/screen';
import { describe, expect, it } from 'vitest';
import {
  accountName,
  accountShows,
  fromCatalog,
  onAnotherServer,
  widgetPrivate,
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

const rowsOf = (sections: CatalogRows[]) => sections.flatMap((s) => s.rows);

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
  it('lists Whombat’s own, then each server, connection and account once (DK-163)', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const sections = catalogRows(catalog);
    expect(sections.map((s) => s.kind)).toEqual(['own', 'servers', 'thing', 'accounts', 'widgets']);
    const servers = sections[1];
    const ids = catalog.groups.filter((g) => g.key.startsWith('server:')).map((g) => g.key);
    expect(servers?.rows.map((r) => r.key)).toEqual(ids);
    expect(servers?.rows.every((r) => r.service && !r.item.opts.show)).toBe(true);
    // A server's overview starts 2 × 2; a connection's figures 2 × 1.
    expect(servers?.rows[0]?.size).toEqual({ w: 2, h: 2 });
    const plex = sections[2]?.rows.find((r) => r.key === 'connection:con_plex');
    expect(plex).toMatchObject({
      name: 'Plex',
      service: true,
      item: { type: 'figures' },
      size: { w: 2, h: 1 },
    });
    // A connection listed only partly is a row too, adding its figures.
    expect(sections[2]?.rows.find((r) => r.key === 'connection:con_calendar')?.item.type).toBe('figures');
  });

  it('finds single views with a search, a part’s name on every server', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const temp = catalogRows(catalog, 'temperature').find((s) => s.kind === 'servers');
    expect(temp?.rows.every((r) => !r.service && r.item.opts.show === 'temp')).toBe(true);
    expect(temp?.rows.map((r) => r.name)).toContain('pve-01 · Temperature');
    const pve = rowsOf(catalogRows(catalog, 'pve-01'));
    expect(pve.length).toBe(catalog.groups.find((g) => g.key === 'server:pve-01')?.items.length);
    expect(catalogRows(catalog, 'zzzz')).toEqual([]);
  });

  it('says a service is on the page when any of its views is', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const memory = { id: 'w_s', type: 'server' as const, ref: 'server:pve-01', opts: { show: 'memory' } };
    const onPage = [{ ...memory, x: 0, y: 0, w: 4, h: 2 }];
    const here = rowsOf(catalogRows(catalog, '', onPage)).filter((r) => r.here);
    expect(here.map((r) => r.key)).toEqual(['server:pve-01']);
    // Searching, only the part itself.
    const parts = rowsOf(catalogRows(catalog, 'pve-01', onPage)).filter((r) => r.here);
    expect(parts.map((r) => r.item.opts.show)).toEqual(['memory']);
  });

  it('adds a service’s main view and remembers its name and mark for the tile', async () => {
    const catalog = await api().widgets({ screen: 'box' });
    const rows = rowsOf(catalogRows(catalog));
    const plex = rows.find((r) => r.key === 'connection:con_plex');
    if (!plex) throw new Error('no Plex');
    const { widget, known } = fromCatalog(plex.item, plex.group);
    expect(widget).toMatchObject({ type: 'figures', ref: 'connection:con_plex' });
    expect(known).toMatchObject({ of: 'Plex', mark: 'plex' });
    const pve = rows.find((r) => r.key === 'server:pve-01');
    if (!pve) throw new Error('no pve-01');
    expect(fromCatalog(pve.item, pve.group).known.name).toBe('pve-01');
    // A server's part found by a search, by its server's name.
    const storage = rowsOf(catalogRows(catalog, 'pve-01 · storage'))[0];
    if (!storage) throw new Error('no storage');
    expect(fromCatalog(storage.item, storage.group)).toMatchObject({
      widget: { type: 'server', ref: 'server:pve-01', opts: { show: 'storage' } },
      known: { name: 'pve-01 · Storage' },
    });
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
  const accounts = (query = '') => catalogRows(ACCOUNTS, query).find((s) => s.kind === 'accounts');

  it('lists each account once under Your accounts, adding its first widget', () => {
    const sections = catalogRows(ACCOUNTS);
    expect(sections.map((s) => s.kind)).toEqual(['own', 'accounts', 'thing']);
    expect(accounts()?.label).toBe('Your accounts');
    expect(accounts()?.rows.map((r) => [r.key, r.mark, r.item.opts.panel])).toEqual([
      ['account:acc_g', 'google', 'today'],
      ['account:github', 'github', 'pulls'],
    ]);
  });

  it('finds an account’s widget by its name, named by its account', () => {
    expect(accounts('unread')?.rows.map((r) => [r.name, r.item.opts.panel])).toEqual([
      ['anna@example.com · Unread mail', 'unread'],
    ]);
    expect(accounts('google')).toBeUndefined();
    expect(accounts('anna')?.rows).toHaveLength(3);
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
    const immich = rowsOf(catalogRows(ACCOUNTS, 'immich'));
    expect(immich.map((r) => `${r.size.w} × ${r.size.h}`)).toEqual(['4 × 3', '4 × 2']);
    const google = accounts()?.rows[0];
    if (!google) throw new Error('no Google');
    const { widget, known } = fromCatalog(google.item, google.group);
    expect(widget).toEqual({ type: 'panel', ref: 'account:acc_g', opts: { panel: 'today' } });
    expect(known).toMatchObject({
      name: 'Today',
      of: 'Google · anna@example.com',
      mark: 'google',
      view: 'list',
    });
    const photo = immich[0];
    if (!photo) throw new Error('no Immich');
    expect(fromCatalog(photo.item, photo.group).known).toMatchObject({ of: 'Immich', view: 'photo' });
  });

  it('offers every widget of the same account for What it shows', () => {
    const w = { type: 'panel' as const, ref: 'account:acc_g' };
    expect(catalogGroupOf(ACCOUNTS, w)?.items.map((i) => i.opts.panel)).toEqual([
      'today',
      'next-meeting',
      'unread',
    ]);
    expect(catalogGroupOf(ACCOUNTS, { type: 'panel', ref: 'account:github' })?.items).toHaveLength(2);
    expect(catalogGroupOf(undefined, w)).toBeNull();
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
