/**
 * A thing's page and Home's things for an older app (docs/decisions/findmy-timeline.md, connection-dashboards.md): an
 * app below session minor 5 gets a Find My connection's page without the Timeline tab it can't draw; one below minor 7
 * gets Home's accounts opening on Settings and no Website feedback; one below minor 8 isn't offered 1Password and opens
 * a 1Password connection on its Summary (onepassword-sync.md); a newer one, and anything outside a session, gets it all.
 */
import {
  FEEDBACK_THING_ID,
  FIND_MY_TIMELINE_TAB,
  GITHUB_THING_ID,
  type HomeOverview,
  ONEPASSWORD_TAB,
  type ThingPage,
  type ThingSummary,
  thingHref,
} from '@whombat/core';
import {
  ACCOUNT_PAGES_MINOR,
  FIND_MY_TIMELINE_MINOR,
  LOOKS_AHEAD_INBOX_MINOR,
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

describe('a 1Password connection’s page for an older app (onepassword-sync.md)', () => {
  const onePassword = {
    id: 'connection:con_1password01',
    kind: 'connection',
    catalogId: 'onepassword',
    name: '1Password',
    tabs: [
      { key: ONEPASSWORD_TAB, label: '1Password', panels: [] },
      { key: 'overview', label: 'Summary', panels: [] },
    ],
  } as unknown as ThingPage;

  it('opens on the Summary below minor 8, without the tab it would show empty', () => {
    expect(keys(thingAnswerFor('things.page', onePassword, ONEPASSWORD_SYNC_MINOR - 1))).toEqual([
      'overview',
    ]);
  });

  it('opens on its 1Password tab from minor 8 on and outside a session', () => {
    expect(thingAnswerFor('things.page', onePassword, ONEPASSWORD_SYNC_MINOR)).toBe(onePassword);
    expect(thingAnswerFor('things.page', onePassword, undefined)).toBe(onePassword);
  });

  it('leaves Find My whole between minor 5 and 8', () => {
    expect(thingAnswerFor('things.page', page, ONEPASSWORD_SYNC_MINOR - 1)).toBe(page);
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

describe('the catalog for an older app (onepassword-sync.md)', () => {
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

  it('offers Website or address only to sessions that can draw its conditional fields', () => {
    const withUptime = {
      ...catalog,
      entries: [...catalog.entries, { catalogId: 'uptime', available: true }],
    };
    expect(thingAnswerFor('connections.catalog', withUptime, 7)).toMatchObject({
      entries: [{ catalogId: 'plex' }],
    });
    expect(thingAnswerFor('connections.catalog', withUptime, 8)).toMatchObject({
      entries: [{ catalogId: 'plex' }, { catalogId: 'onepassword' }],
    });
    expect(thingAnswerFor('connections.catalog', withUptime, 9)).toBe(withUptime);
    expect(thingAnswerFor('connections.catalog', withUptime, undefined)).toBe(withUptime);
  });
});

describe('Looks ahead Inbox findings for an older app (looks-ahead.md)', () => {
  const aheadItem = {
    id: 'ahead:ahc_1',
    ref: { kind: 'ahead', id: 'ahc_1' },
    kind: 'ahead',
    severity: 'info',
    title: 'The Script starts at 20:45',
    body: 'Starts at 20:45 instead of 20:00.',
    at: '2026-12-13T15:00:00.000Z',
    actions: [],
    group: 'you',
    ahead: {
      checkId: 'ahc_1',
      source: 'calendar',
      kind: 'time',
      sources: [{ label: 'venue.example.com', url: 'https://venue.example.com/show' }],
      action: 'Update event to 20:45',
    },
  };
  const withAhead = {
    ...overview,
    needsYou: [aheadItem],
    needsYouList: [aheadItem],
  } as unknown as HomeOverview;

  it('adapts kind: ahead to a plain backup row without ahead metadata below minor 17', () => {
    const older = thingAnswerFor('home.overview', withAhead, LOOKS_AHEAD_INBOX_MINOR - 1) as HomeOverview;
    expect(older.needsYouList?.[0]).toMatchObject({
      id: 'ahead:ahc_1',
      kind: 'backup',
      title: 'The Script starts at 20:45',
      body: 'Starts at 20:45 instead of 20:00.',
    });
    expect(older.needsYouList?.[0]).not.toHaveProperty('ahead');
    expect(older.needsYou[0]?.kind).toBe('backup');
  });

  it('keeps kind: ahead and its metadata intact from minor 17 on and outside a session', () => {
    expect(thingAnswerFor('home.overview', withAhead, LOOKS_AHEAD_INBOX_MINOR)).toBe(withAhead);
    expect(thingAnswerFor('home.overview', withAhead, undefined)).toBe(withAhead);
  });
});
