import { type ThingSummary, thingHref } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  PLACE_WORDS,
  PLACES,
  placeLabel,
  placeLine,
  placeOfScreen,
  placeRoute,
  placesThings,
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
  it('lists the nine places in the web sidebar’s order, Files · Vault · Usage together', () => {
    expect(PLACES.map((p) => PLACE_WORDS[p])).toEqual([
      'Search',
      'Chat',
      'Inbox',
      'Overview',
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
    expect(placeOfScreen('Thread')).toBeNull();
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
});
