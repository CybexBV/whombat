import { describe, expect, it } from 'vitest';
import {
  CATALOG_FOLDED_AT_FIRST,
  catalogFind,
  catalogItemKey,
  catalogName,
  catalogSections,
  catalogServers,
  sameWidget,
  sectionCount,
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

describe('Add a widget’s sections (DK-154, DK-155)', () => {
  it('puts every server under one Servers, in the runtime’s order', () => {
    const sections = catalogSections(catalog);
    expect(sections.map((s) => [s.key, s.kind])).toEqual([
      ['own', 'own'],
      ['servers', 'servers'],
      ['connection:con_plex', 'thing'],
      ['widgets', 'widgets'],
    ]);
    expect(sections[1]?.groups.map((g) => g.key)).toEqual(['server:pve-01', 'server:nas']);
    expect(sectionCount(sections[1] as never)).toBe(4);
    // Whombat's own and the servers start folded; the connections open.
    expect([...CATALOG_FOLDED_AT_FIRST].sort()).toEqual(['own', 'servers']);
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
