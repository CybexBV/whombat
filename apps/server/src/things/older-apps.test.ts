/**
 * A thing's page and Home's things for an older app (docs/decisions/findmy-timeline.md, connection-dashboards.md): an
 * app below session minor 5 gets a Find My connection's page without the Timeline tab it can't draw; one below minor 7
 * gets Home's accounts opening on Settings and no Website feedback; one below minor 8 isn't offered 1Password
 * (onepassword-sync.md); a newer one, and anything outside a session, gets it all.
 */
import {
  FEEDBACK_THING_ID,
  FIND_MY_TIMELINE_TAB,
  GITHUB_THING_ID,
  type HomeOverview,
  type ThingPage,
  type ThingSummary,
  thingHref,
} from '@whombat/core';
import {
  ACCOUNT_PAGES_MINOR,
  FIND_MY_TIMELINE_MINOR,
  ONEPASSWORD_SYNC_MINOR,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { thingAnswerFor, thingPageFor } from './older-apps';

const page = {
  id: 'connection:con_findmy01',
  kind: 'connection',
  name: 'Find My',
  tabs: [
    { key: 'findmy', label: 'Find My', server: 'studio', panels: [] },
    { key: FIND_MY_TIMELINE_TAB, label: 'Timeline', server: 'studio', panels: [] },
    { key: 'overview', label: 'Summary', panels: [] },
  ],
} as unknown as ThingPage;

const keys = (p: unknown) => (p as ThingPage).tabs.map((t) => t.key);

describe('a thing’s page for an older app', () => {
  it('leaves the Timeline out below minor 5, keeps Find My and opens on the Summary', () => {
    expect(keys(thingAnswerFor('things.page', page, FIND_MY_TIMELINE_MINOR - 1))).toEqual([
      'overview',
      'findmy',
    ]);
  });

  it('is whole from minor 5 on, outside a session and for other ops', () => {
    expect(thingPageFor(page, FIND_MY_TIMELINE_MINOR)).toBe(page);
    expect(thingPageFor(page, undefined)).toBe(page);
    expect(thingAnswerFor('things.quiet', page, 0)).toBe(page);
  });
});

const thing = (id: string, catalogId: string, href = `/things/${encodeURIComponent(id)}`): ThingSummary => ({
  id,
  kind: 'connection',
  catalogId,
  name: catalogId,
  icon: catalogId,
  status: 'ok',
  facts: [],
  href,
});

const overview = {
  things: [
    thing('connection:con_google01', 'google'),
    thing('connection:con_mail01', 'imap'),
    thing(GITHUB_THING_ID, 'github'),
    thing(FEEDBACK_THING_ID, 'feedback'),
    thing('connection:con_plex01', 'plex'),
  ],
} as unknown as HomeOverview;

const hrefs = (o: unknown) =>
  Object.fromEntries((o as HomeOverview).things.map((t) => [t.catalogId ?? t.id, t.href]));

describe('Home’s accounts for an older app', () => {
  it('opens them on Settings below minor 7 and leaves Website feedback out', () => {
    expect(hrefs(thingAnswerFor('home.overview', overview, ACCOUNT_PAGES_MINOR - 1))).toEqual({
      google: '/settings?tab=connections&connection=google',
      imap: '/settings?tab=connections&connection=imap',
      github: '/settings?tab=connections&connection=github',
      plex: thingHref('connection', 'con_plex01'),
    });
  });

  it('opens their own pages from minor 7 on and outside a session', () => {
    expect(thingAnswerFor('home.overview', overview, ACCOUNT_PAGES_MINOR)).toBe(overview);
    expect(thingAnswerFor('home.overview', overview, undefined)).toBe(overview);
    expect(hrefs(overview).feedback).toBe(thingHref('connection', 'feedback'));
  });
});

describe('the catalog for an older app (onepassword-sync.md OPW-K17)', () => {
  const catalog = {
    mode: 'real',
    limit: 50,
    entries: [
      { catalogId: 'plex', available: true },
      { catalogId: 'onepassword', available: true },
    ],
  };

  it('leaves 1Password out below minor 8', () => {
    const older = thingAnswerFor(
      'connections.catalog',
      catalog,
      ONEPASSWORD_SYNC_MINOR - 1,
    ) as typeof catalog;
    expect(older.entries.map((e) => e.catalogId)).toEqual(['plex']);
  });

  it('offers it from minor 8 on and outside a session', () => {
    expect(thingAnswerFor('connections.catalog', catalog, ONEPASSWORD_SYNC_MINOR)).toBe(catalog);
    expect(thingAnswerFor('connections.catalog', catalog, undefined)).toBe(catalog);
  });
});
