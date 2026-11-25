/**
 * Account pages on a real database: Postgres is the point. A Google account's page is only its own person's (another
 * account's person gets not_found), what Whombat watches on it reads the connector row, GitHub's page comes from the
 * mirror's tables, Website feedback's from the burrow's report rows (by the reporter's name, never their email), and
 * Home's account things open their pages.
 */
import {
  FEEDBACK_THING_ID,
  GITHUB_THING_ID,
  googleScopesFor,
  newId,
  ThingPage,
  thingHref,
  thingId,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionViewer } from '../../connections/store';
import { storeGoogleConnection } from '../../connectors/store';
import { accounts, feedbackReports, principals, prReviewers } from '../../db/schema/index';
import { syncOwnedRepos } from '../../github/owned-repos';
import { pollMailGlances } from '../../home/mail-glance';
import { homeOverview } from '../../home/overview';
import { ApiError } from '../../lib/errors';
import type { PrincipalRow } from '../../read/principals';
import { IDS } from '../../seed/test-world';
import { createIntegration, filed, submission } from '../../test/feedback';
import { useTestServer } from '../../test/harness';
import { FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN } from '../../test/personal';
import { thingPage, thingVisible } from '../page';
import { readAccountUptime, rollUpPoints } from '../points';
import { thingWatch } from '../quiet/service';

const t = useTestServer({ seed: true });
const TZ = 'Europe/Amsterdam';
let mara: ConnectionViewer;
let someone: ConnectionViewer;
let google = '';

const ids = (p: { tabs: { panels: { id: string }[] }[] }) => p.tabs[0]?.panels.map((x) => x.id) ?? [];

beforeAll(async () => {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const person = row as PrincipalRow;
  mara = { accountId: person.accountId as string, burrowId: t.burrowId, principal: person };
  const other = newId('account');
  await t.services.db.insert(accounts).values({ id: other, email: 'someone@example.com', name: 'Someone' });
  someone = {
    accountId: other,
    burrowId: t.burrowId,
    principal: { ...person, id: 'prn_someone', accountId: other },
  };
  const conn = await storeGoogleConnection(t.services, {
    accountId: mara.accountId,
    requested: ['mail', 'calendar', 'files'],
    tokens: {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: new Date(t.services.clock().getTime() + 3_600_000),
      scopes: googleScopesFor(['mail', 'calendar', 'files']),
    },
    user: { sub: 'sub-mara', email: 'mara@example.com', name: 'Mara' },
  });
  google = thingId('connection', conn.id);
  // Mara is asked to review the seeded pull request, whose checks fail.
  await t.services.db
    .insert(prReviewers)
    .values({ prId: 'pr_482', principalId: IDS.mara, state: 'pending', position: 5 });
});

describe('a Google account’s page', () => {
  it('is its own person’s, read with their token, and not_found for anyone else', async () => {
    const page = await thingPage(t.services, mara, google, TZ);
    expect(ThingPage.safeParse(page).error).toBeUndefined();
    expect(page).toMatchObject({ id: google, catalogId: 'google', name: 'Google', settings: true });
    expect(page.connectionId).toBe(google.slice('connection:'.length));
    expect(page.address).toBe('mara@example.com');
    expect(ids(page)).toEqual(expect.arrayContaining(['today', 'account', 'unread-mail', 'files']));
    expect(page.problem).toBeUndefined();
    expect(page.uptime).toMatchObject({ upPct: 100 });
    await expect(thingPage(t.services, someone, google, TZ)).rejects.toBeInstanceOf(ApiError);
    expect(await thingVisible(t.services, mara, google)).toBe(true);
    expect(await thingVisible(t.services, someone, google)).toBe(false);
  });

  it('keeps one uptime sample for the shared reads per slot and rolls up the actual coverage', async () => {
    const { services } = t;
    const originalClock = services.clock;
    const now = originalClock();
    const hour = Math.floor(now.getTime() / 3600_000) * 3600_000 - 60 * 3600_000;
    const failure = vi.spyOn(services.google.workspace, 'inboxUnread');
    try {
      services.clock = () => new Date(hour);
      failure.mockRejectedValueOnce(new Error('No answer'));
      expect(await pollMailGlances(services)).toBe(0);
      services.clock = () => new Date(hour + 5 * 60_000);
      await thingPage(services, mara, google, TZ);
      // The health pass and page both read mail in this slot, and a failed part cannot erase a working one.
      failure.mockRejectedValueOnce(new Error('No answer'));
      await pollMailGlances(services);
      await rollUpPoints(services, now);
      await rollUpPoints(services, now);
      const points = await readAccountUptime(
        services.db,
        { connectionId: google.slice('connection:'.length) },
        new Date(hour),
      );
      expect(points.filter((p) => p.at.getTime() < hour + 3600_000)).toEqual([
        { at: new Date(hour), value: 0.5, samples: 2 },
      ]);
    } finally {
      failure.mockRestore();
      services.clock = originalClock;
    }
  });

  it('watches its sign-in from the start and Drive almost full once turned on', async () => {
    const watch = await thingWatch(t.services, mara, google, TZ);
    const on = Object.fromEntries(watch.checks.map((c) => [c.check, c.on]));
    expect(on).toMatchObject({ 'conn.signin': true, 'files.space': false });
  });
});

describe('GitHub’s page', () => {
  it('comes from the mirror: the review asked of the viewer, the counts', async () => {
    const page = await thingPage(t.services, mara, GITHUB_THING_ID, TZ);
    expect(ThingPage.safeParse(page).error).toBeUndefined();
    expect(page).toMatchObject({ id: GITHUB_THING_ID, catalogId: 'github', settings: true });
    const panels = page.tabs[0]?.panels ?? [];
    const waiting = panels.find((p) => p.id === 'waiting');
    expect(waiting?.kind === 'list' && waiting.items.map((i) => i.title)).toEqual([
      '#482 Invoice PDF export',
    ]);
    expect(waiting?.kind === 'list' && waiting.items[0]?.detail).toContain('asks your review');
    const counts = panels.find((p) => p.id === 'github');
    expect(counts?.kind === 'list' && counts.items.map((i) => [i.id, i.figure?.value])).toEqual(
      expect.arrayContaining([
        ['repos', '1'],
        ['failing', '1'],
      ]),
    );
    await syncOwnedRepos(t.services, t.burrowId, IDS.mara);
    expect((await thingPage(t.services, mara, GITHUB_THING_ID, TZ)).uptime).toMatchObject({ upPct: 100 });
  });
});

describe('Website feedback’s page and Home', () => {
  it('comes from the report rows, by the reporter’s name only', async () => {
    await expect(thingPage(t.services, mara, FEEDBACK_THING_ID, TZ)).rejects.toBeInstanceOf(ApiError);
    const site = (await createIntegration(t)).siteId;
    await filed(t, site, submission({ description: 'The export button does nothing' }));
    await filed(t, site, submission({ description: 'Totals are rounded wrong' }));
    const [first] = await t.services.db.select().from(feedbackReports).limit(1);
    if (!first) throw new Error('no report');
    await t.services.db
      .update(feedbackReports)
      .set({ status: 'resolved' })
      .where(eq(feedbackReports.id, first.id));
    const page = await thingPage(t.services, mara, FEEDBACK_THING_ID, TZ);
    expect(page.uptime).toBeUndefined();
    expect(ThingPage.safeParse(page).error).toBeUndefined();
    expect(page).toMatchObject({ id: FEEDBACK_THING_ID, catalogId: 'feedback', name: 'Website feedback' });
    const fresh = page.tabs[0]?.panels.find((p) => p.id === 'new');
    expect(fresh?.kind === 'list' && fresh.items).toHaveLength(1);
    expect(fresh?.kind === 'list' && fresh.items[0]?.detail).toBe('Lumio website · Ada Visitor');
    expect(JSON.stringify(page)).not.toContain('ada@example.com');
    expect(page.verdict).toBe('1 new report waits for a look.');
  });

  it('lists every account on Home, each opening its own page', async () => {
    const burrow = await t.services.db.query.burrows.findFirst();
    if (!burrow) throw new Error('burrow');
    const home = await homeOverview(t.services, { principal: mara.principal, burrow });
    const href = (id: string) => home.things.find((x) => x.id === id)?.href;
    expect(href(google)).toBe(thingHref('connection', google.slice('connection:'.length)));
    expect(href(GITHUB_THING_ID)).toBe(thingHref('connection', 'github'));
    expect(href(FEEDBACK_THING_ID)).toBe(thingHref('connection', 'feedback'));
    expect(home.things.find((x) => x.id === FEEDBACK_THING_ID)?.line).toBe('1 new report · 1 site');
  });
});
