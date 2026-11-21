/**
 * Kept sites against a real Postgres (docs/decisions/kept-sites.md): the agent keeps a website signed in for some hours,
 * its cookies sealed; the runner gets them back for a fresh browser until they expire; a use renews them; the agent
 * forgets, the person stops, and an outsiders' turn or an assessment gets nothing. Needs Postgres: the rows, the signed
 * events and Done recently go through the commit pipeline.
 */
import { KeptSite, KeptSiteRestore } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { liveDispatch, RUNNER, runnerCall } from '../agent-commands/testing';
import { events, keptSites } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let cookie = '';
const realClock = () => new Date();

const SECRET = 'sess-9Kq2Vx7Lm4Tz';
const cookieOf = (name: string, domain: string, value = SECRET) => ({
  name,
  value,
  domain,
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
});
const HETZNER = ['https://accounts.hetzner.com', 'https://konsoleh.hetzner.com'];

beforeAll(async () => {
  ({ cookie } = await sessionFor(t.services, IDS.mara));
});

afterEach(async () => {
  t.services.clock = realClock;
  await t.services.db.delete(keptSites);
});

const keep = (dispatchId: string, body: Record<string, unknown>, attempt = 1) =>
  runnerCall(
    t,
    'POST',
    '/dispatches/:dispatchId/kept-sites',
    { dispatchId },
    { runnerId: RUNNER, attempt, ...body },
  );
const forget = (dispatchId: string, origins: string[]) =>
  runnerCall(
    t,
    'POST',
    '/dispatches/:dispatchId/kept-sites/forget',
    { dispatchId },
    { runnerId: RUNNER, attempt: 1, origins },
  );
const agentList = (dispatchId: string) =>
  runnerCall(
    t,
    'POST',
    '/dispatches/:dispatchId/kept-sites/list',
    { dispatchId },
    { runnerId: RUNNER, attempt: 1 },
  );
const restore = () => runnerCall(t, 'POST', '/kept-sites/restore', {}, {});
const renew = (siteId: string, cookies: unknown[]) =>
  runnerCall(t, 'POST', '/kept-sites/:siteId/renew', { siteId }, { cookies });

const person = (method: 'GET' | 'DELETE' | 'POST', url: string) =>
  t.api.inject({ method, url: `/api/v1/burrows/burrow-hq${url}`, headers: { cookie } });

async function kept(origins: string[], hours?: number, cookies = [cookieOf('sid', 'accounts.hetzner.com')]) {
  const d = await liveDispatch(t, { person: IDS.mara });
  const res = await keep(d.id, { origins, cookies, ...(hours ? { hours } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { dispatch: d, site: KeptSite.parse(res.body.site) };
}

const later = (ms: number) => {
  const at = new Date(Date.now() + ms);
  t.services.clock = () => at;
};

async function eventsOf(type: string) {
  return t.services.db.select().from(events).where(eq(events.type, type));
}

describe('keeping a site', () => {
  it('seals the cookies, signs the event without them, and restore gives them back', async () => {
    const before = Date.now();
    const { site, dispatch } = await kept(HETZNER, undefined, [
      cookieOf('sid', '.hetzner.com'),
      cookieOf('other', 'tracker.example.com', 'not-this-site'),
    ]);
    expect(site).toMatchObject({
      site: 'accounts.hetzner.com',
      origins: HETZNER,
      hours: 4,
      agentId: IDS.dusty,
    });
    const left = Date.parse(site.expiresAt) - before;
    expect(left).toBeGreaterThan(4 * 3600_000 - 60_000);
    expect(left).toBeLessThanOrEqual(4 * 3600_000 + 60_000);

    const [row] = await t.services.db.select().from(keptSites).where(eq(keptSites.id, site.id));
    expect(JSON.stringify(row)).not.toContain(SECRET);
    const [signed] = (await eventsOf('browser.site_kept')).filter((e) => e.payload.siteId === site.id);
    expect(signed?.actorId).toBe(IDS.dusty);
    expect(signed?.text).toContain('accounts.hetzner.com');
    expect(signed?.payload).toMatchObject({
      siteId: site.id,
      origins: HETZNER,
      hours: 4,
      dispatchId: dispatch.id,
    });
    expect(JSON.stringify(signed)).not.toContain(SECRET);

    const res = await restore();
    expect(res.status).toBe(200);
    const sites = (res.body.sites as unknown[]).map((s) => KeptSiteRestore.parse(s));
    expect(sites.map((s) => s.site.id)).toEqual([site.id]);
    // Only the site's own cookies were kept.
    expect(sites[0]?.cookies.map((c) => [c.name, c.value, c.domain])).toEqual([
      ['sid', SECRET, '.hetzner.com'],
    ]);
  });

  it('is something the agent did in Done recently, whose Undo stops keeping it', async () => {
    const { site } = await kept(['https://github.com'], 2);
    const list = await person('GET', '/changes');
    expect(list.statusCode, list.body).toBe(200);
    const change = (list.json().changes as { id: string; title: string; undo: { state: string } }[]).find(
      (c) => c.title.includes('github.com'),
    );
    expect(change?.undo.state).toBe('available');
    const undo = await person('POST', `/changes/${change?.id}/undo`);
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await t.services.db.select().from(keptSites).where(eq(keptSites.id, site.id))).toEqual([]);
    expect((await eventsOf('browser.site_stopped')).some((e) => e.payload.siteId === site.id)).toBe(true);
  });

  it('replaces a kept site that shares an origin', async () => {
    const first = await kept(HETZNER);
    const second = await kept(['https://konsoleh.hetzner.com', 'https://robot.hetzner.com'], 8);
    const rows = await t.services.db.select().from(keptSites);
    expect(rows.map((r) => r.id)).toEqual([second.site.id]);
    expect(first.site.id).not.toBe(second.site.id);
    expect(second.site).toMatchObject({ site: 'konsoleh.hetzner.com', hours: 8 });
  });

  it('refuses an outsiders’ turn and an assessment, and a runner that lost the lease', async () => {
    const body = { origins: HETZNER, cookies: [cookieOf('sid', 'accounts.hetzner.com')] };
    const outsiders = await liveDispatch(t, { person: null });
    expect((await keep(outsiders.id, body)).status).toBe(403);
    expect((await agentList(outsiders.id)).status).toBe(403);
    expect((await forget(outsiders.id, HETZNER)).status).toBe(403);
    const assessment = await liveDispatch(t, { person: IDS.mara, trigger: 'feedback' });
    expect((await keep(assessment.id, body)).status).toBe(403);
    expect((await agentList(assessment.id)).status).toBe(403);
    const d = await liveDispatch(t, { person: IDS.mara });
    expect((await keep(d.id, body, 2)).status).toBe(409);
    expect((await forget(d.id, HETZNER)).status).toBe(200);
    expect(await t.services.db.select().from(keptSites)).toEqual([]);
  });
});

describe('restoring and renewing', () => {
  it('restores only sites that haven’t expired, and deletes the expired ones', async () => {
    const short = await kept(['https://github.com'], 1);
    const long = await kept(HETZNER, 6);
    later(2 * 3600_000);
    const res = await restore();
    expect(res.status).toBe(200);
    expect((res.body.sites as { site: { id: string } }[]).map((s) => s.site.id)).toEqual([long.site.id]);
    const ids = (await t.services.db.select().from(keptSites)).map((r) => r.id);
    expect(ids).toEqual([long.site.id]);
    expect(ids).not.toContain(short.site.id);
  });

  it('renews: the cookies as they are now, kept for its hours again from now', async () => {
    const { site } = await kept(HETZNER, 3);
    later(2 * 3600_000);
    const res = await renew(site.id, [cookieOf('sid', 'accounts.hetzner.com', 'renewed-Qw8Zp3')]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const renewed = KeptSite.parse(res.body.site);
    const now = t.services.clock().getTime();
    expect(Date.parse(renewed.expiresAt)).toBe(now + 3 * 3600_000);
    expect(Date.parse(renewed.lastUsedAt)).toBe(now);
    expect(renewed.keptAt).toBe(site.keptAt);
    const back = (await restore()).body.sites as KeptSiteRestore[];
    expect(back[0]?.cookies.map((c) => c.value)).toEqual(['renewed-Qw8Zp3']);
  });

  it('renewing a site that was forgotten, stopped or has expired is 404', async () => {
    const forgotten = await kept(['https://github.com']);
    expect((await forget(forgotten.dispatch.id, ['https://github.com'])).status).toBe(200);
    expect((await renew(forgotten.site.id, [])).status).toBe(404);

    const stopped = await kept(HETZNER);
    expect((await person('DELETE', `/kept-sites/${stopped.site.id}`)).statusCode).toBe(200);
    expect((await renew(stopped.site.id, [])).status).toBe(404);

    const expired = await kept(['https://bank.example.com'], 1);
    later(3600_000 + 1000);
    expect((await renew(expired.site.id, [])).status).toBe(404);
  });
});

describe('forgetting, listing and stopping', () => {
  it('forget deletes every site with any of the origins, and signs each', async () => {
    const a = await kept(HETZNER);
    const b = await kept(['https://github.com']);
    const c = await kept(['https://bank.example.com']);
    const res = await forget(a.dispatch.id, ['https://konsoleh.hetzner.com', 'https://github.com']);
    expect(res.status).toBe(200);
    const forgotten = (res.body.forgotten as KeptSite[]).map((s) => s.id).sort();
    expect(forgotten).toEqual([a.site.id, b.site.id].sort());
    expect((await t.services.db.select().from(keptSites)).map((r) => r.id)).toEqual([c.site.id]);
    const signed = (await eventsOf('browser.site_forgotten')).map((e) => e.payload.siteId);
    expect(signed).toEqual(expect.arrayContaining([a.site.id, b.site.id]));
  });

  it('lists soonest to expire first, without cookies, for the person and the agent', async () => {
    const a = await kept(HETZNER, 8);
    const b = await kept(['https://github.com'], 2);
    const gone = await kept(['https://bank.example.com'], 1);
    await t.services.db
      .update(keptSites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(keptSites.id, gone.site.id));
    const res = await person('GET', '/kept-sites');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect((res.json().sites as KeptSite[]).map((s) => s.id)).toEqual([b.site.id, a.site.id]);
    // The expired one is gone, not only hidden.
    expect((await t.services.db.select().from(keptSites)).map((r) => r.id).sort()).toEqual(
      [a.site.id, b.site.id].sort(),
    );
    const agent = await agentList(a.dispatch.id);
    expect(agent.status).toBe(200);
    expect(JSON.stringify(agent.body)).not.toContain(SECRET);
    expect((agent.body.sites as KeptSite[]).map((s) => s.id)).toEqual([b.site.id, a.site.id]);
  });

  it('the person stops one: deleted, signed as them, and a second stop is 404', async () => {
    const { site } = await kept(HETZNER);
    const res = await person('DELETE', `/kept-sites/${site.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(KeptSite.parse(res.json().site).id).toBe(site.id);
    expect(await t.services.db.select().from(keptSites)).toEqual([]);
    const [signed] = (await eventsOf('browser.site_stopped')).filter((e) => e.payload.siteId === site.id);
    expect(signed?.actorId).toBe(IDS.mara);
    expect(signed?.text).toContain('accounts.hetzner.com');
    expect((await person('DELETE', `/kept-sites/${site.id}`)).statusCode).toBe(404);
  });
});
