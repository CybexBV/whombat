import { describe, expect, it } from 'vitest';
import {
  catalogFind,
  catalogGroupOf,
  catalogItemKey,
  catalogName,
  catalogRows,
  catalogSections,
  catalogServers,
  catalogViewName,
  sameWidget,
  serverParts,
} from './catalog';
import type { DeskCatalog, DeskCatalogItem } from './contract';
import { setWidgetSpec } from './editor';

const server = (id: string, show?: string): DeskCatalogItem => ({
  type: 'server',
  ref: `server:${id}`,
  opts: show ? { show } : {},
  name: show ? show.charAt(0).toUpperCase() + show.slice(1) : 'Overview',
  line: 'a line',
  view: show ? 'chart' : 'server',
});

const catalog: DeskCatalog = {
  groups: [
    {
      key: 'own',
      label: 'Whombat and Dusty',
      items: [{ type: 'clock', opts: {}, name: 'Clock', line: 'The time' }],
    },
    {
      key: 'server:pve-01',
      label: 'pve-01',
      mark: 'proxmox',
      items: [server('pve-01'), server('pve-01', 'memory')],
    },
    { key: 'server:nas', label: 'nas', items: [server('nas'), server('nas', 'storage')] },
    {
      key: 'connection:con_plex',
      label: 'Plex',
      mark: 'plex',
      thing: 'connection:con_plex',
      items: [
        { type: 'figures', ref: 'connection:con_plex', opts: {}, name: 'Figures', line: 'Its figures' },
      ],
    },
    { key: 'widgets', label: 'Made by Dusty', items: [] },
  ],
};

describe('Add a widget’s sections (DK-154)', () => {
  it('puts every server under one Servers, in the runtime’s order', () => {
    const sections = catalogSections(catalog);
    expect(sections.map((s) => [s.key, s.kind])).toEqual([
      ['own', 'own'],
      ['servers', 'servers'],
      ['connection:con_plex', 'thing'],
      ['widgets', 'widgets'],
    ]);
    expect(sections[1]?.groups.map((g) => g.key)).toEqual(['server:pve-01', 'server:nas']);
  });

  it('puts every account under one Your accounts', () => {
    const withAccounts: DeskCatalog = {
      groups: [
        ...catalog.groups,
        { key: 'account:con_g', label: 'Google · anna@example.com', items: [] },
        { key: 'account:github', label: 'GitHub', items: [] },
      ],
    };
    const today = {
      type: 'panel' as const,
      ref: 'account:con_g',
      opts: { panel: 'today' },
      name: 'Today',
      line: '',
    };
    expect(catalogName({ key: 'account:con_g', label: 'Google · anna@example.com' }, today)).toBe(
      'Google · Today',
    );
    const accounts = catalogSections(withAccounts).find((x) => x.kind === 'accounts');
    expect(accounts?.label).toBe('Your accounts');
    expect(accounts?.groups.map((g) => g.key)).toEqual(['account:con_g', 'account:github']);
  });

  it('takes an older runtime’s single Servers group as the servers', () => {
    const old: DeskCatalog = {
      groups: [{ key: 'servers', label: 'Servers', items: [{ ...server('pve-01'), name: 'pve-01' }] }],
    };
    expect(catalogSections(old).map((s) => s.kind)).toEqual(['servers']);
    expect(catalogServers(old).map((i) => i.name)).toEqual(['pve-01']);
  });

  it('tells a server’s parts apart, and names them by their server', () => {
    expect(sameWidget(server('pve-01'), { ...server('pve-01'), opts: { range: '7d' } })).toBe(true);
    expect(sameWidget(server('pve-01'), server('pve-01', 'memory'))).toBe(false);
    expect(catalogItemKey(server('pve-01', 'memory'))).not.toBe(catalogItemKey(server('pve-01')));
    const found = catalogFind(catalog, {
      type: 'server',
      ref: 'server:pve-01',
      opts: { show: 'memory', range: '1h' },
    });
    expect(found && catalogName(found.group, found.item)).toBe('pve-01 · Memory');
    const overview = catalogFind(catalog, { type: 'server', ref: 'server:nas', opts: {} });
    expect(overview && catalogName(overview.group, overview.item)).toBe('nas');
    expect(catalogServers(catalog).map((i) => [i.ref, i.name])).toEqual([
      ['server:pve-01', 'pve-01'],
      ['server:nas', 'nas'],
    ]);
    expect(serverParts(catalog, 'server:nas').map((p) => p.show)).toEqual(['', 'storage']);
  });

  it('shrinks a widget whose new part is smaller', () => {
    const layout = {
      pages: [
        {
          id: 'p_1',
          name: 'Overview',
          layouts: {
            '8x5': [
              { id: 'w_1', type: 'server' as const, ref: 'server:pve-01', opts: {}, x: 0, y: 0, w: 6, h: 3 },
            ],
          },
          last: '8x5',
        },
      ],
      turn: 'touch' as const,
      size: 'normal' as const,
    };
    const next = setWidgetSpec(layout, 'w_1', { opts: { show: 'temp' } });
    expect(next.pages[0]?.layouts['8x5']?.[0]).toMatchObject({ opts: { show: 'temp' }, w: 4, h: 2 });
  });
});

const plex = catalog.groups[3] as DeskCatalog['groups'][number];
const withPanels: DeskCatalog = {
  groups: [
    ...catalog.groups.slice(0, 3),
    {
      ...plex,
      items: [
        ...plex.items,
        {
          type: 'panel',
          ref: 'connection:con_plex',
          opts: { panel: 'now-playing' },
          name: 'Now playing',
          line: 'Who’s watching what',
          view: 'posters',
        },
      ],
    },
    {
      key: 'connection:con_cal',
      label: 'Family calendar',
      thing: 'connection:con_cal',
      partial: true,
      items: [{ type: 'figures', ref: 'connection:con_cal', opts: {}, name: 'Figures', line: 'Its figures' }],
    },
    {
      key: 'account:con_g',
      label: 'Google · anna@example.com',
      mark: 'google',
      thing: 'account:con_g',
      items: [
        {
          type: 'panel',
          ref: 'account:con_g',
          opts: { panel: 'today' },
          name: 'Today',
          line: 'Meetings today',
        },
        { type: 'panel', ref: 'account:con_g', opts: { panel: 'unread' }, name: 'Unread mail', line: 'Mail' },
      ],
    },
    {
      key: 'widgets',
      label: 'Made by Dusty',
      items: [{ type: 'widget', ref: 'widget:w1', opts: {}, name: 'Solar today', line: 'Made from a chat' }],
    },
  ],
};

describe('Add a widget lists each service once (DK-163)', () => {
  it('lists every server, connection and account once, Whombat’s own and Home’s widgets each', () => {
    const sections = catalogRows(withPanels);
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.name)])).toEqual([
      ['own', ['Clock']],
      ['servers', ['pve-01', 'nas']],
      ['things', ['Plex', 'Family calendar']],
      ['accounts', ['Google · anna@example.com']],
      ['widgets', ['Solar today']],
    ]);
    expect(sections.find((s) => s.key === 'things')?.label).toBe('Connections');
    // Adding a service adds its main view (its first), at that view's size, with its line.
    const pve = sections[1]?.rows[0];
    expect(pve).toMatchObject({ service: true, item: { opts: {} }, mark: 'proxmox', size: { w: 2, h: 2 } });
    const plexRow = sections[2]?.rows[0];
    expect(plexRow).toMatchObject({ service: true, line: 'Its figures', item: { type: 'figures' } });
    // A partly listed connection is a row of its own too.
    expect(sections[2]?.rows[1]).toMatchObject({ service: true, key: 'connection:con_cal' });
    const google = sections[3]?.rows[0];
    expect(google).toMatchObject({ mark: 'google', item: { opts: { panel: 'today' } } });
    expect(sections[0]?.rows[0]).toMatchObject({ service: false, item: { type: 'clock' } });
  });

  it('says a service is on this page when any of its views is', () => {
    const memory = { type: 'server' as const, ref: 'server:pve-01', opts: { show: 'memory' } };
    const nowPlaying = { type: 'panel' as const, ref: 'connection:con_plex', opts: { panel: 'now-playing' } };
    const rows = catalogRows(withPanels, '', [memory, nowPlaying, { type: 'clock', opts: {} }]).flatMap(
      (s) => s.rows,
    );
    expect(rows.filter((r) => r.here).map((r) => r.key)).toEqual([
      'clock|||',
      'server:pve-01',
      'connection:con_plex',
    ]);
  });

  it('finds single views with a search, named out of their group', () => {
    const found = (q: string) =>
      catalogRows(withPanels, q).flatMap((s) => s.rows.map((r) => [s.key, r.name, r.service]));
    expect(found('memory')).toEqual([['servers', 'pve-01 · Memory', false]]);
    expect(found('NOW PLAYING')).toEqual([['things', 'Plex · Now playing', false]]);
    // A service's name finds all of its views; a section's, all of its.
    expect(found('plex').map((r) => r[1])).toEqual(['Plex · Figures', 'Plex · Now playing']);
    expect(found('unread')).toEqual([['accounts', 'Google · Unread mail', false]]);
    expect(found('time')).toEqual([['own', 'Clock', false]]);
    expect(found('zzz')).toEqual([]);
    expect(
      catalogViewName(
        { key: 'connection:x', label: 'Fusebox', thing: 'connection:x' },
        {
          type: 'panel',
          opts: { panel: 'limits' },
          name: 'Limits now',
          line: '',
        },
      ),
    ).toBe('Fusebox · Limits now');
  });

  it('lists an older runtime’s single Servers group by its servers', () => {
    const old: DeskCatalog = {
      groups: [{ key: 'servers', label: 'Servers', items: [{ ...server('pve-01'), name: 'pve-01' }] }],
    };
    expect(catalogRows(old)[0]?.rows.map((r) => [r.name, r.service])).toEqual([['pve-01', false]]);
  });

  it('finds the group a widget chooses its view in', () => {
    expect(catalogGroupOf(withPanels, { type: 'server', ref: 'server:nas' })?.key).toBe('server:nas');
    expect(catalogGroupOf(withPanels, { type: 'panel', ref: 'connection:con_plex' })?.items).toHaveLength(2);
    expect(catalogGroupOf(withPanels, { type: 'figures', ref: 'account:con_g' })?.label).toContain('Google');
    expect(catalogGroupOf(withPanels, { type: 'clock' })).toBeNull();
    expect(catalogGroupOf(withPanels, { type: 'widget', ref: 'widget:w1' })).toBeNull();
  });
});
