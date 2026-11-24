/**
 * Keeping servers quiet and one cause, against the hosts service's stand-in rather than fixtures. It needs Postgres because the windows, the causes job, Home's reads and the commit pipeline
 * meet only there. A server kept quiet: Home's thing says until when, its open alerts are held with the window whether
 * or not the hub muted them (and whether or not it made the maintenance window), they leave the Inbox, and Undo on one
 * ends the window. End now ends Whombat's own window for its work beside the person's; the work's end and windows that
 * run out are told to Home. A “Website or address” check down while the internet is down stays down because of it, and
 * a fleet that can't be read leaves kept causes alone.
 */
import { api, thingId, topics } from '@whombat/core';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  catalogConnections,
  principals,
  quietWindows,
  thingCauses,
  wayOutOutages,
} from '../../db/schema/index';
import { checkConnectionHealth } from '../../home/health';
import { needsYou, things } from '../../home/overview';
import { toHostAlert } from '../../hosts/map';
import { alertLine } from '../../hosts/quiet-lines';
import { hostsFor } from '../../hosts/service';
import { hostsWatch } from '../../hosts/sources';
import { FakeHostsService, problem } from '../../hosts/testing/fake';
import { IDS } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import { sessionFor } from '../../test/tokens';
import { useVaultNetForTests } from '../../vault/net';
import { passCauses } from '../causes';
import { endThingQuiet } from './window-service';
import { keepQuietForWork, sweepQuietWindows, workEnded } from './window-work';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

let person = '';
let refuseMaintenance = false;
let fleetDown = false;

beforeAll(async () => {
  await fake.start();
  person = (await sessionFor(t.services, IDS.mara)).cookie;
  // A public address for the website check, so it talks to the internet.
  useVaultNetForTests(t.services, {
    resolve: async () => [{ address: '203.0.113.30', family: 4 as const }],
    dialAddress: () => '127.0.0.1',
    deadlineMs: 5000,
  });
  fake.on('POST', '/api/v1/maintenance', () =>
    refuseMaintenance ? problem(500, 'internal', 'maintenance refused') : null,
  );
  fake.on('GET', '/api/v1/fleet', () => (fleetDown ? problem(500, 'internal', 'fleet failed') : null));
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(async () => {
  refuseMaintenance = false;
  fleetDown = false;
  fake.maintenance.splice(0);
  for (const a of fake.alerts) Object.assign(a, { muted: false, attention: true, acknowledged: null });
  await t.services.db.delete(quietWindows);
  await t.services.db.delete(thingCauses);
  await t.services.db.delete(wayOutOutages);
  hostsFor(t.services).forget();
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie: person, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const thingPath = (id: string, suffix = '') => `/things/${encodeURIComponent(id)}${suffix}`;

async function viewer() {
  const [principal] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const burrow = await t.services.db.query.burrows.findFirst();
  if (!principal || !burrow) throw new Error('viewer');
  return { principal, burrow };
}

async function keepQuiet(serverId: string, minutes = 60) {
  const res = await call('POST', thingPath(thingId('server', serverId), '/keep-quiet'), { minutes });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  hostsFor(t.services).forget();
  return api.things.keepQuiet.response.parse(res.body).keptQuiet;
}

async function serverPage(serverId: string) {
  hostsFor(t.services).forget();
  const res = await call('GET', `/hosts/servers/${serverId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return api.hosts.getServer.response.parse(res.body);
}

const ctx = () => ({
  services: t.services,
  db: t.services.db,
  personId: IDS.mara,
  burrowId: t.burrowId,
  now: t.services.clock(),
});

const marbleBeat = () => fake.alerts.find((a) => a.id === 'al_01');

/** The parts of every `home.changed` the person gets from now on. */
function homeChanged() {
  const parts: string[][] = [];
  const stop = t.services.bus.onFrame((f) => {
    if (f.topic === topics.me(IDS.mara) && f.event.type === 'home.changed') parts.push([...f.event.parts]);
  });
  return { parts, stop };
}

describe('a server kept quiet, with the real hosts service', () => {
  it('says until when on Home, holds its alerts with the window and leaves them out of the Inbox', async () => {
    const before = await needsYou(t.services, await viewer());
    expect(before.map((i) => i.id)).toContain('hosts.alert:al_01');

    const kept = await keepQuiet('marble');
    expect(fake.maintenance).toHaveLength(1);
    // This hub doesn't mute the alert: it still asks for attention there.
    expect(marbleBeat()?.attention).toBe(true);

    const marble = (await things(t.services, await viewer())).find((x) => x.id === 'server:marble');
    expect(marble?.quietUntil).toBe(kept?.until);
    expect((await needsYou(t.services, await viewer())).map((i) => i.id)).not.toContain('hosts.alert:al_01');
    const watched = (await hostsWatch(ctx())).find((i) => i.id === 'hosts.alert:al_01');
    expect(watched).toMatchObject({ state: 'snoozed', snoozedUntil: kept?.until });

    const fleet = await hostsFor(t.services).fleet();
    const held = fleet.alerts.find((a) => a.id === 'al_01');
    expect(held?.quiet).toMatchObject({ state: 'snoozed', held: 'window', until: kept?.until });
    expect(held?.attention).toBe(false);
    // Other servers' alerts stay as they are.
    expect(fleet.alerts.find((a) => a.id === 'al_03')?.quiet).toBeUndefined();

    // Once the hub mutes it too, it is still the window that holds it, not “while it’s in maintenance”.
    Object.assign(marbleBeat() ?? {}, { muted: true, attention: false });
    const page = await serverPage('marble');
    expect(page.keptQuiet?.id).toBe(kept?.id);
    expect(page.alerts?.find((a) => a.id === 'al_01')?.quiet).toMatchObject({ held: 'window' });
  });

  it('holds a server quiet when the hub refused the maintenance window', async () => {
    refuseMaintenance = true;
    const kept = await keepQuiet('marble');
    expect(kept).not.toBeNull();
    expect(fake.maintenance).toHaveLength(0);
    expect((await needsYou(t.services, await viewer())).map((i) => i.id)).not.toContain('hosts.alert:al_01');
    const page = await serverPage('marble');
    expect(page.alerts?.find((a) => a.id === 'al_01')?.quiet).toMatchObject({ held: 'window' });
  });

  it('Undo on a held alert (an app without End now) ends the window', async () => {
    await keepQuiet('marble');
    const line = alertLine(toHostAlert(marbleBeat() ?? {}));
    const undo = await call('POST', thingPath('server:marble', '/quiet'), {
      notice: { check: line.check, ...(line.subject ? { subject: line.subject.id } : {}) },
      how: 'undo',
    });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect((await serverPage('marble')).keptQuiet).toBeUndefined();
    expect(fake.maintenance).toHaveLength(0);
    expect((await needsYou(t.services, await viewer())).map((i) => i.id)).toContain('hosts.alert:al_01');
  });

  it('refuses a server the hosts service doesn’t know, and a time closer than the shortest', async () => {
    const unknown = await call('POST', thingPath('server:no-such-server', '/keep-quiet'), { minutes: 60 });
    expect(unknown.status).toBe(404);
    const soon = new Date(t.services.clock().getTime() + 2 * 60_000).toISOString();
    const tooSoon = await call('POST', thingPath('server:basalt', '/keep-quiet'), { until: soon });
    expect(tooSoon.status).toBe(400);
  });
});

describe('End now and Whombat’s own work', () => {
  it('ends every window holding the server, Whombat’s beside the person’s', async () => {
    await keepQuiet('basalt', 30);
    await keepQuietForWork(t.services, {
      burrowId: t.burrowId,
      serverId: 'basalt',
      work: 'update:basalt/task-1',
      expectedMs: 60 * 60_000,
    });
    expect(fake.maintenance).toHaveLength(2);
    const ended = await call('POST', thingPath('server:basalt', '/keep-quiet/end'), {});
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(api.things.endQuiet.response.parse(ended.body).keptQuiet).toBeNull();
    expect(await t.services.db.select().from(quietWindows).where(isNull(quietWindows.endedAt))).toEqual([]);
    expect((await serverPage('basalt')).keptQuiet).toBeUndefined();
    expect(fake.maintenance).toHaveLength(0);
  });

  it('Undo ends the person’s window only, and answers with the one still holding', async () => {
    const kept = await keepQuiet('basalt', 30);
    await keepQuietForWork(t.services, {
      burrowId: t.burrowId,
      serverId: 'basalt',
      work: 'update:basalt/task-2',
      expectedMs: 60 * 60_000,
    });
    const { principal, burrow } = await viewer();
    const answer = await endThingQuiet(
      t.services,
      { accountId: principal.accountId ?? '', burrowId: burrow.id, principal },
      'server:basalt',
      'UTC',
      { windowId: kept?.id as string },
    );
    expect(answer.keptQuiet).toMatchObject({ whombat: true });
  });

  it('tells Home when the work ends and when a window runs out', async () => {
    await keepQuietForWork(t.services, {
      burrowId: t.burrowId,
      serverId: 'basalt',
      work: 'update:basalt/task-3',
      expectedMs: 60 * 60_000,
    });
    const heard = homeChanged();
    try {
      const at = t.services.clock();
      await workEnded(t.services, 'update:basalt/task-3', at);
      expect(heard.parts.at(-1)).toContain('things');
      const [w] = await t.services.db
        .select()
        .from(quietWindows)
        .where(eq(quietWindows.work, 'update:basalt/task-3'));
      expect(w?.endsAt.getTime()).toBe(at.getTime() + 15 * 60_000);

      // Over: its maintenance window goes back to the hub, and Home hears of it.
      let told = heard.parts.length;
      await sweepQuietWindows(t.services, new Date(at.getTime() + 20 * 60_000));
      expect(heard.parts.length).toBeGreaterThan(told);
      expect(fake.maintenance).toHaveLength(0);

      // A connection's window (no maintenance) that runs out by itself is told once, at the first sweep after its end.
      const base = new Date(at.getTime() + 24 * 3600_000);
      await t.services.db.insert(quietWindows).values({
        id: 'qw_runs_out',
        ownerId: t.burrowId,
        thingId: thingId('connection', 'con_runs_out'),
        guestId: null,
        startsAt: new Date(base.getTime() - 3600_000),
        endsAt: new Date(base.getTime() + 5 * 60_000),
        note: null,
        byId: IDS.mara,
        work: null,
        maintenanceId: null,
        endedAt: null,
        endedById: null,
        createdAt: new Date(base.getTime() - 3600_000),
      });
      await sweepQuietWindows(t.services, base);
      told = heard.parts.length;
      await sweepQuietWindows(t.services, new Date(base.getTime() + 6 * 60_000));
      expect(heard.parts.length).toBe(told + 1);
      await sweepQuietWindows(t.services, new Date(base.getTime() + 7 * 60_000));
      expect(heard.parts.length).toBe(told + 1);
    } finally {
      heard.stop();
    }
  });
});

describe('one cause with the real hosts service', () => {
  it('a website check down while the internet is down stays down because of it', async () => {
    const added = await call('POST', '/connections', {
      catalogId: 'uptime',
      signIn: 'none',
      label: 'Shop',
      fields: { kind: 'http', address: 'https://shop.example.com/', runner: 'hub', every: '5' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const { connection } = api.connections.create.response.parse(added.body);
    const load = async () => {
      const [row] = await t.services.db
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.id, connection.id));
      if (!row) throw new Error('Connection is missing');
      return row;
    };
    const hubCheckId = (await load()).hubCheckId;
    const check = fake.checks.find((c) => c.id === hubCheckId);
    if (!check) throw new Error('Check is missing');
    const at = t.services.clock();
    Object.assign(check, {
      status: 'down',
      since: at.toISOString(),
      last: { at: at.toISOString(), ok: false },
    });
    await t.services.db
      .insert(wayOutOutages)
      .values({ id: 'wo_servers_test', step: 'internet', startedAt: new Date(at.getTime() - 5 * 60_000) });

    expect((await checkConnectionHealth(t.services, await load(), at))?.outcome).toBe('offline');
    await passCauses(t.services, at);
    const cause = async () =>
      (
        await t.services.db
          .select()
          .from(thingCauses)
          .where(eq(thingCauses.thingId, thingId('connection', connection.id)))
      )[0];
    expect(await cause()).toMatchObject({ causeThing: 'box:network', kind: 'down' });

    // Its line is quiet with the cause now; the next passes keep the cause instead of ending it.
    const later = new Date(at.getTime() + 60_000);
    const held = await checkConnectionHealth(t.services, await load(), later);
    expect(held?.outcome).toBe('offline');
    await passCauses(t.services, later);
    expect(await cause()).toMatchObject({ causeThing: 'box:network' });
    const outage = (await needsYou(t.services, await viewer())).find((i) => i.ref.kind === 'way_out');
    expect(outage?.body).toContain('Shop');
  });

  it('leaves kept causes alone while the fleet can’t be read', async () => {
    const thing = thingId('connection', 'con_on_marble');
    const checkedAt = new Date(t.services.clock().getTime() - 60_000);
    await t.services.db.insert(thingCauses).values({
      ownerId: t.burrowId,
      thingId: thing,
      causeThing: 'server:marble',
      causeName: 'marble',
      kind: 'down',
      words: 'while marble is down',
      since: checkedAt,
      checkedAt,
    });
    fleetDown = true;
    hostsFor(t.services).forget();
    await passCauses(t.services);
    const [kept] = await t.services.db.select().from(thingCauses).where(eq(thingCauses.thingId, thing));
    // Untouched: it ages out by itself when nobody confirms it.
    expect(kept).toMatchObject({ causeThing: 'server:marble', checkedAt });
  });
});
