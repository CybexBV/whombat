import { type ThingSummary, thingHref } from '@whombat/core';
import { HostServer } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  listPlaceOfScreen,
  PLACE_WORDS,
  PLACES,
  placeLabel,
  placeLine,
  placeLists,
  placeOfScreen,
  placeRoute,
  placesThings,
  sheetPlaces,
} from './places';
import { TABS } from './shell';

const thing = (kind: ThingSummary['kind'], id: string, extra: Partial<ThingSummary> = {}): ThingSummary => ({
  id: `${kind}:${id}`,
  kind,
  name: id,
  icon: kind === 'server' ? 'proxmox' : 'home',
  status: 'ok',
  facts: [],
  href: thingHref(kind, id),
  ...extra,
});

describe('Places (phone-shell-final.md)', () => {
  it('lists the places in the web sidebar’s order, Servers and Connections right after Overview', () => {
    expect(PLACES.map((p) => PLACE_WORDS[p])).toEqual([
      'Search',
      'Chat',
      'Inbox',
      'Overview',
      'Servers',
      'Connections',
      'Automations',
      'Files',
      'Vault',
      'Usage',
      'Settings',
    ]);
  });

  it('keeps the five tabs as the places that are tabs, in the bar’s order', () => {
    const tabs = PLACES.map((p) => placeRoute(p, 'Chat')).flatMap((r) => (r.kind === 'tab' ? [r.tab] : []));
    expect(tabs).toEqual([...TABS]);
  });

  it('pushes Search, Files, Vault and Usage (the Spend page) with “‹ …” naming where they were opened', () => {
    expect(placeRoute('search', 'Chat')).toEqual({ kind: 'page', name: 'Search', params: { back: 'Chat' } });
    expect(placeRoute('files', 'Overview')).toEqual({
      kind: 'page',
      name: 'Files',
      params: { back: 'Overview' },
    });
    expect(placeRoute('vault', 'Search')).toEqual({
      kind: 'page',
      name: 'Vault',
      params: { back: 'Search' },
    });
    expect(placeRoute('usage', 'Settings')).toEqual({
      kind: 'page',
      name: 'Spend',
      params: { back: 'Settings' },
    });
  });

  it('marks the place on screen, a tab or a page it opens', () => {
    expect(placeOfScreen('ChatRoom')).toBe('chat');
    expect(placeOfScreen('Spend')).toBe('usage');
    expect(placeOfScreen('ServersPlace')).toBe('servers');
    expect(placeOfScreen('ConnectionsPlace')).toBe('connections');
    expect(placeOfScreen('Thread')).toBeNull();
  });

  it('opens Servers and Connections on their list screens (not Settings → Connections)', () => {
    expect(placeRoute('servers', 'Chat')).toEqual({
      kind: 'page',
      name: 'ServersPlace',
      params: { back: 'Chat' },
    });
    expect(placeRoute('connections', 'Overview')).toEqual({
      kind: 'page',
      name: 'ConnectionsPlace',
      params: { back: 'Overview' },
    });
    expect(listPlaceOfScreen('ServersPlace')).toBe('servers');
    expect(listPlaceOfScreen('ConnectionsPlace')).toBe('connections');
    expect(listPlaceOfScreen('Connections')).toBeNull();
  });

  it('shows Servers and Connections in the sheet only when they hold something', () => {
    expect(sheetPlaces({ servers: false, connections: false })).not.toContain('servers');
    expect(sheetPlaces({ servers: false, connections: false })).not.toContain('connections');
    const all = sheetPlaces({ servers: true, connections: true });
    expect(all.slice(all.indexOf('overview'), all.indexOf('automations') + 1)).toEqual([
      'overview',
      'servers',
      'connections',
      'automations',
    ]);
    expect(sheetPlaces({ servers: true, connections: false })).toContain('servers');
  });

  it('names the assistant in the places’ lines', () => {
    expect(placeLine('chat', 'Neo')).toContain('Neo');
    expect(placeLine('usage', 'Neo')).toContain('Neo');
  });

  it('says a count once, in words, and that something isn’t working only when it is so', () => {
    expect(placeLabel('chat', 1)).toBe('Chat, 1 unread reply');
    expect(placeLabel('inbox', 3)).toBe('Inbox, 3 things need you');
    expect(placeLabel('inbox', 3, true)).toContain('isn’t working');
    expect(placeLabel('inbox', 0)).toBe('Inbox');
    expect(placeLabel('vault', 4)).toBe('Vault');
  });

  it('gives a shortcut to every server and connection with its logo, parts of a server left out', () => {
    const things = placesThings([
      thing('server', 'pve-02'),
      thing('connection', 'con_ha', { catalogId: 'homeassistant', name: 'Home Assistant' }),
      thing('connection', 'con_pve', { catalogId: 'proxmox', partOf: 'server:pve-02' }),
    ]);
    expect(things.servers.map((t) => t.name)).toEqual(['pve-02']);
    expect(things.servers[0]?.mark).not.toBeNull();
    expect(things.connections.map((t) => t.name)).toEqual(['Home Assistant']);
    expect(things.connections[0]?.mark).not.toBeNull();
    expect(placesThings(undefined)).toEqual({ servers: [], connections: [] });
  });

  it('opens an account on its page when the box gives one, else on the address it gives (an older box)', () => {
    const { connections } = placesThings([
      thing('connection', 'con_mara', { catalogId: 'google', icon: 'google', name: 'Google' }),
      thing('connection', 'github', { catalogId: 'github', icon: 'github', name: 'GitHub' }),
      thing('connection', 'feedback', { catalogId: 'feedback', icon: 'feedback', name: 'Website feedback' }),
      thing('connection', 'con_old', {
        catalogId: 'imap',
        icon: 'imap',
        name: 'Email',
        href: '/settings?tab=connections&connection=imap',
      }),
    ]);
    expect(connections.map((t) => [t.name, t.opens])).toEqual([
      ['Google', null],
      ['GitHub', null],
      ['Website feedback', null],
      ['Email', '/settings?tab=connections&connection=imap'],
    ]);
    // Each account draws its own mark; Website feedback's glyph, where no mark is drawn, is its bubble, not a plug.
    expect(connections.map((t) => t.mark)).toEqual(['google', 'github', 'feedback', 'imap']);
    expect(connections[2]?.glyph).toBe('message');
  });
});

const NOW = Date.parse('2026-11-27T10:00:00.000Z');

const fleetServer = (patch: Partial<HostServer> = {}): HostServer =>
  HostServer.parse({
    id: 'pve-02',
    name: 'pve-02',
    group: '',
    status: 'ok',
    platform: 'proxmox',
    os: 'Proxmox VE 9.2.11',
    cpu: { model: 'AMD Ryzen AI MAX+ PRO 395', cores: 16, threads: 32 },
    uptimeS: 23 * 86_400,
    cpuPct: 10.4,
    memory: { usedPct: 64.4, usedGb: 76, totalGb: 118 },
    storage: { usedPct: 44, usedTb: 0.9, capacityTb: 2 },
    temperature: { maxC: 60, limitC: 85 },
    guests: [{ platform: 'pve', running: 19, total: 22 }],
    agent: { version: '1.0.0', connected: true },
    lastSeen: new Date(NOW - 60_000).toISOString(),
    cpu24h: [5, 7, 9],
    remoteControl: { console: false, power: false },
    ...patch,
  });

describe('the Servers and Connections lists (servers-connections-places.md)', () => {
  const things = [
    thing('server', 'pve-02', { status: 'warn', reason: 'one disk is nearly full' }),
    thing('server', 'pve-01'),
    thing('connection', 'con_ha', { catalogId: 'homeassistant', name: 'Home Assistant', status: 'bad' }),
    thing('connection', 'feedback', { catalogId: 'feedback', icon: 'feedback', name: 'Website feedback' }),
    thing('connection', 'con_old', {
      catalogId: 'imap',
      icon: 'imap',
      name: 'Email',
      href: '/settings?tab=connections&connection=imap',
    }),
  ];
  const fleet = [
    fleetServer({ id: 'pve-01', name: 'pve-01' }),
    fleetServer({ id: 'pve-02', name: 'pve-02', status: 'warn' }),
  ];

  it('lists the fleet’s servers worst first and the connections, each opening its page', () => {
    const lists = placeLists({ things, fleet, hosts: true, tiles: null, now: NOW, timeZone: 'UTC' });
    expect(lists.servers.map((r) => r.id)).toEqual(['server:pve-02', 'server:pve-01']);
    expect(lists.servers[0]?.line).toBe('One disk is nearly full');
    expect(lists.servers[1]?.figure).toMatch(/^10/);
    expect(lists.connections.map((r) => r.id)).toEqual([
      'connection:con_ha',
      'connection:feedback',
      'connection:con_old',
    ]);
    expect(lists.connections.map((r) => r.opens)).toEqual([
      null,
      null,
      '/settings?tab=connections&connection=imap',
    ]);
    // Website feedback draws its bubble where it has no logo.
    expect(lists.connections[1]?.phoneGlyph).toBe('message');
  });

  it('marks each place with the worst of what it holds', () => {
    const lists = placeLists({ things, fleet, hosts: true, tiles: null, now: NOW, timeZone: 'UTC' });
    expect(lists.tone).toEqual({ servers: 'warn', connections: 'bad' });
    const fine = placeLists({
      things: [thing('server', 'pve-01')],
      fleet: null,
      hosts: false,
      tiles: null,
      now: NOW,
      timeZone: 'UTC',
    });
    expect(fine.tone).toEqual({ servers: null, connections: null });
  });

  it('shows Servers with a server or the hosts service, Connections with something connected', () => {
    const none = placeLists({
      things: [],
      fleet: null,
      hosts: false,
      tiles: null,
      now: NOW,
      timeZone: 'UTC',
    });
    expect(none.shown).toEqual({ servers: false, connections: false });
    const hosts = placeLists({ things: [], fleet: [], hosts: true, tiles: null, now: NOW, timeZone: 'UTC' });
    expect(hosts.shown).toEqual({ servers: true, connections: false });
    const one = placeLists({
      things: [thing('connection', 'con_ha', { catalogId: 'homeassistant', name: 'Home Assistant' })],
      fleet: null,
      hosts: false,
      tiles: null,
      now: NOW,
      timeZone: 'UTC',
    });
    expect(one.shown).toEqual({ servers: false, connections: true });
  });
});
