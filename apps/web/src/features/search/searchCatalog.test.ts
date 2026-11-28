/** What Search finds without asking the Whombat: things, settings and places (final-shell-web.md). */
import { APP_PLACES } from '@whombat/client';
import type { ThingSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { matchCatalog, placeHref, searchCatalog, searchSuggestions } from './searchCatalog';

const things: ThingSummary[] = [
  {
    id: 'server:pve-02',
    kind: 'server',
    name: 'pve-02',
    icon: 'proxmox',
    status: 'warn',
    reason: 'Running warm',
    facts: [],
    href: '/things/server%3Apve-02',
  },
  {
    id: 'connection:ha',
    kind: 'connection',
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    icon: 'homeassistant',
    status: 'ok',
    facts: [],
    href: '/things/connection%3Aha',
  },
];

const catalog = (managed = false) => searchCatalog({ things, agent: 'Neo', here: { managed } });
const keys = (query: string, managed = false) => matchCatalog(catalog(managed), query).map((e) => e.key);

describe('the Search catalogue', () => {
  it('finds a server by part of its name, with what it is and how it is, and its real logo', () => {
    const [pve] = matchCatalog(catalog(), 'pve');
    expect(pve).toMatchObject({
      key: 'thing:server:pve-02',
      group: 'things',
      title: 'pve-02',
      href: '/things/server%3Apve-02',
    });
    expect(pve?.line).toContain('Running warm');
    expect(pve?.icon.kind).toBe('mark');
  });

  it('needs every word of the query, in any case', () => {
    expect(keys('HOME assistant')).toEqual(['thing:connection:ha']);
    expect(keys('home garden')).toEqual([]);
    expect(keys('   ')).toEqual([]);
  });

  it('finds the settings’ pages, Advanced’s with their own line, and never Usage', () => {
    expect(keys('notifications')).toContain('setting:you:notifications');
    expect(keys('model')).toContain('setting:advanced:model');
    expect(catalog().some((e) => e.key === 'setting:advanced:spend')).toBe(false);
    // A box's own parts show only on a box.
    expect(keys('devices')).not.toContain('setting:you:devices');
    expect(keys('devices', true)).toContain('setting:you:devices');
  });

  it('finds News and weather by its parts, only where the Whombat answers them', () => {
    const withNews = searchCatalog({ things, agent: 'Neo', here: { managed: true }, news: true });
    for (const words of ['news', 'weather', 'place', 'youtube', 'opml'])
      expect(matchCatalog(withNews, words).map((e) => e.key)).toContain('setting:news');
    expect(withNews.find((e) => e.key === 'setting:news')).toMatchObject({
      title: 'News and weather',
      href: '/settings?tab=news',
    });
    expect(keys('weather', true)).not.toContain('setting:news');
  });

  it('lists the places but Search itself and Usage, in the sidebar’s order, each at its one address', () => {
    const places = catalog().filter((e) => e.group === 'places');
    const order = APP_PLACES.filter((p) => p !== 'search' && p !== 'usage').flatMap((p) =>
      p === 'inbox' ? [p, 'servers', 'connections'] : [p],
    );
    expect(places.map((e) => e.key)).toEqual(order.map((p) => `place:${p}`));
    expect(places.find((e) => e.key === 'place:connections')?.href).toBe('/connected');
    expect(placeHref('inbox')).toBe('/inbox');
    expect(keys('files')).toContain('place:files');
  });

  it('suggests a real thing, a setting and a place under an empty query', () => {
    expect(searchSuggestions(catalog(), 'Neo')).toEqual(['pve-02', 'Notifications', 'Files']);
    expect(
      searchSuggestions(searchCatalog({ things: [], agent: 'Neo', here: { managed: false } }), 'Neo'),
    ).toEqual(['Notifications', 'Files']);
  });
});
