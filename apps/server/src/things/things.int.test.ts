/**
 * Connection pages end to end (connection-pages.md CP-01…CP-16; connection-pages-server.md CP-S01…; dashboards.md
 * DS-03, DS-04, DS-10, DS-11), on a real database with a fake Home Assistant (its WebSocket and REST, behind a
 * home-network name) and the fake hosts service: `things.page` over a range, what it runs on found by a Proxmox guest's
 * configured address, the health pass's technical tile and points, `things.action` (Restart; refused on Look only),
 * `connections.setRunsOn`, a generic page with its machine, a Proxmox
 * connection that is part of a server, widgets kept on a page, and the points' hourly roll-up.
 */
import { api, type ThingPage, thingId, thingPanelPlace, WidgetsResponse } from '@whombat/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Stub, startStub } from '../connections/provision/testing-home';
import { syncTools } from '../connections/sync';
import {
  catalogConnections,
  changes,
  connectionPoints,
  events,
  noticeStates,
  principals,
  vaultNetworks,
  watchOns,
  widgets,
} from '../db/schema/index';
import { checkConnectionHealth, pollConnectionHealth } from '../home/health';
import { homeOverview } from '../home/overview';
import { pinWidget } from '../home/widgets';
import { hostsFor } from '../hosts/service';
import { hostsNeedsYou, hostsWatch } from '../hosts/sources';
import { FakeHostsService } from '../hosts/testing/fake';
import { IDS } from '../seed/test-world';
import { insertConnection, setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { kindOf } from './kinds/index';
import { forgetKindReads } from './kinds/read';
import { backupNotice } from './machine';
import {
  DB_MB_KEY,
  LOG_ERR_KEY,
  LOG_ERR_TOP_KEY,
  RTT_KEY,
  rollUpPoints,
  UP_COUNT_KEY,
  UP_KEY,
} from './points';
import { readMachine } from './runs-on';
import { fakeHaState, fakeHomeAssistant } from './testing/fake-ha';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: {
    WHOMBAT_HOSTS_SOCKET: fake.socket,
    WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile,
  },
});

const state = fakeHaState();
let ha: Stub;
let haId = '';
let grafanaId = '';
let proxmoxId = '';
let mara = '';
let agent = '';
const restarts: string[] = [];

beforeAll(async () => {
  await fake.start();
  const guest = fake.guest('shale', 'pve:200');
  if (!guest) throw new Error('Missing fixture guest.');
  guest.last_backup = { result: 'ok', at: new Date(t.services.clock().getTime() - 3_600_000).toISOString() };
  // CT 200 on shale is “HomeAssistant”: the hosts service lists it without addresses, its configuration has one.
  fake.configOf('shale', 'pve:200').values.net0 =
    'name=eth0,bridge=vmbr0,firewall=1,ip=192.168.92.10/24,type=veth';
  ha = await startStub(
    (req) => {
      if (req.headers.authorization !== `Bearer ${state.token}`) return { status: 401 };
      if (req.method === 'GET' && req.path === '/api/') return { json: { message: 'API running.' } };
      if (req.method === 'POST' && req.path === '/api/services/homeassistant/restart') {
        restarts.push(req.body);
        return { json: [] };
      }
      return { status: 404 };
    },
    { websocket: fakeHomeAssistant(state) },
  );
  const port = Number(new URL(ha.url).port);
  useVaultNetForTests(t.services, {
    resolve: async () => [{ address: '192.168.92.10', family: 4 }],
    dialAddress: () => '127.0.0.1',
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_things_test',
    cidr: '192.168.92.0/24',
    ports: [port],
    note: 'Home stub',
    addedAt: t.services.clock(),
  });
  haId = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: t.burrowId,
    label: 'Home Assistant',
    fields: { url: `http://ha.home-test.test:${port}` },
    secret: state.token,
  });
  // Repairs start off (watch-defaults.md): this person turned them on, so the waiting repair is the worst line.
  await t.services.db.insert(watchOns).values({
    ownerId: t.burrowId,
    thingId: thingId('connection', haId),
    checkId: 'homeassistant.repair',
    byId: IDS.mara,
    at: t.services.clock(),
  });
  grafanaId = await insertConnection(t.services, {
    // A connection without a kind of its own (Grafana has one since SD-46): a Grafana connected as an API.
    catalogId: 'custom_api',
    burrowId: t.burrowId,
    label: 'Grafana',
    fields: { url: `http://grafana.home-test.test:${port}` },
    secret: 'glsa_test',
  });
  // basalt answers on 10.20.0.11: this Proxmox connection is how Whombat reaches it.
  proxmoxId = await insertConnection(t.services, {
    catalogId: 'proxmox',
    burrowId: t.burrowId,
    label: 'Proxmox VE',
    fields: { url: 'https://10.20.0.11:8006', tokenId: 'root@pam!whombat' },
    secret: 'x',
  });
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  agent = made.agentId;
  await setConnectionKeys(t.services, agent, { read: 'can', write: 'can' });
  await syncTools(t.services, haId);
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

afterAll(async () => {
  await ha?.close();
  await fake.stop();
});

async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await t.api.inject({
    method: method as 'GET',
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { message: string } },
  };
}

const pagePath = (id: string) => `/things/${encodeURIComponent(id)}`;

async function page(cookie: string, id: string, range?: string): Promise<ThingPage> {
  const res = await call(cookie, 'GET', `${pagePath(id)}${range ? `?range=${range}` : ''}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return api.things.page.response.parse(res.body);
}

describe('Home Assistant’s page', () => {
  it('shows how it runs, what it runs on and Restart for the person', async () => {
    const p = await page(mara, thingId('connection', haId));
    expect(p).toMatchObject({
      kind: 'connection',
      connectionId: haId,
      catalogId: 'homeassistant',
      name: 'Home Assistant',
      status: 'warn',
      // The worst active line's words (quiet-notices.md QN-S13); an integration not loading counts from its second pass.
      badge: 'A repair is waiting',
      settings: true,
      open: { label: 'Open Home Assistant' },
      runsOn: { serverId: 'shale', guestId: 'pve:200', how: 'address' },
    });
    // The machine by its own name and its server, never Proxmox's number.
    expect(p.runsOn?.name).toMatch(/\(shale\)$/);
    expect(p.runsOn?.name).not.toContain('CT 200');
    expect(p.runsOn?.href).toBe('/things/server%3Ashale?guest=pve%3A200');
    expect(p.facts[0]?.map((x) => x.text).join('')).toBe('Home Assistant 2026.10.2 · Container');
    expect(p.facts.map((f) => f.map((x) => x.text).join(''))).toContain(
      'Whombat may do things · locks and alarms ask first',
    );
    expect(p.actions).toEqual([expect.objectContaining({ id: 'restart', allowed: true })]);
    expect(p.tabs.map((x) => x.key)).toEqual(['overview', 'integrations', 'logs', 'backups']);
    expect(p.tabs[0]?.label).toBe('Summary');
    // Nothing on Home Assistant's Summary in slots follows a range, so it offers no picker.
    expect(p).toMatchObject({ range: '24h', ranges: ['24h'], refreshS: 60 });
    const overview = p.tabs[0]?.panels ?? [];
    // In slots: Worth a look as the strip, what it has, then its own panels; the machine as a card after the rows.
    expect(overview.map((x) => [x.kind, x.id, x.place])).toEqual([
      ['notices', 'notices', 'top'],
      ['list', 'inventory', 'chart'],
      ['bars', 'machine', 'chart'],
      ['list', 'not-loading', 'main'],
      ['list', 'backups', 'main'],
      ['access', 'access', 'main'],
      ['widgets', 'widgets', 'bottom'],
    ]);
    const machine = overview.find((x) => x.id === 'machine');
    expect(machine?.kind === 'bars' && machine.items.map((i) => i.label)).toEqual([
      'Processor',
      'Memory',
      expect.stringContaining('Backed up'),
      'Home Assistant',
      'Database',
    ]);
    const notices = overview[0] as Extract<ThingPage['tabs'][0]['panels'][0], { kind: 'notices' }>;
    // One line per integration (quiet-notices.md QN-03), with its check and item.
    expect(notices.items[0]).toMatchObject({
      icon: 'plug',
      check: 'homeassistant.integration',
      subject: { name: 'Heat pump' },
      nature: 'problem',
    });
    expect(p.problem).toBeUndefined();
    // Nothing about the house was asked.
    expect(state.seen).not.toContain('get_states');
  });

  it('a thing nobody may see, or a server, is not found', async () => {
    expect((await call(mara, 'GET', pagePath('connection:con_nothere0000'))).status).toBe(404);
    expect((await call(mara, 'GET', pagePath('server:shale'))).status).toBe(404);
  });

  it('the health pass keeps a response-time point and makes the tile technical (CP-15, CP-16)', async () => {
    forgetKindReads(t.services);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, haId));
    if (!row) throw new Error('no row');
    const glance = await checkConnectionHealth(t.services, row);
    expect(glance).toMatchObject({
      status: 'warn',
      line: 'Home Assistant 2026.10.2',
      facts: [
        { label: 'Integrations', value: '169 of 171', note: '2 not loading' },
        { label: 'Log errors', note: 'since restart' },
        { label: 'Updates', value: '2', note: 'waiting' },
      ],
    });
    const points = await t.services.db
      .select()
      .from(connectionPoints)
      .where(and(eq(connectionPoints.connectionId, haId), eq(connectionPoints.key, RTT_KEY)));
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBeGreaterThanOrEqual(0);
    // Its log's errors since the restart, the noisiest source's and the database (DS-11), the source's name kept.
    const kept = await t.services.db
      .select()
      .from(connectionPoints)
      .where(eq(connectionPoints.connectionId, haId))
      .orderBy(asc(connectionPoints.key));
    expect(
      Object.fromEntries(kept.filter((k) => k.key !== RTT_KEY).map((k) => [k.key, k.value])),
    ).toMatchObject({
      [LOG_ERR_KEY]: 38,
      [LOG_ERR_TOP_KEY]: 30,
      [DB_MB_KEY]: 2800.13,
    });
    expect(glance?.logTop).toBe('knx');
  });
});

describe('Restart (CP-12)', () => {
  it('the person restarts it, recorded in Done recently without Undo', async () => {
    const res = await call(mara, 'POST', `${pagePath(thingId('connection', haId))}/actions`, {
      action: 'restart',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.message).toBe('Restarting Home Assistant. It’s back in about a minute.');
    expect(restarts).toHaveLength(1);
    const [change] = await t.services.db.select().from(changes).orderBy(desc(changes.createdAt)).limit(1);
    expect(change).toMatchObject({
      title: 'Restarted Home Assistant',
      kind: 'thing.restart',
      subjectKind: 'connection',
      subjectId: haId,
      undoKind: null,
    });
    const listed = await call(
      mara,
      'GET',
      `/changes?thing=${encodeURIComponent(thingId('connection', haId))}`,
    );
    expect((listed.body.changes as { title: string }[])[0]?.title).toBe('Restarted Home Assistant');
  });

  it('Look only refuses it in plain words', async () => {
    const path = `${pagePath(thingId('connection', haId))}/actions`;
    await t.services.db
      .update(catalogConnections)
      .set({ access: 'read' })
      .where(eq(catalogConnections.id, haId));
    try {
      const res = await call(mara, 'POST', path, { action: 'restart' });
      expect(res.status).toBe(403);
      expect(res.body.error?.message).toBe(
        'Home Assistant is set to Look only, so Whombat changes nothing there. Set it to Manage in Settings first.',
      );
      const p = await page(mara, thingId('connection', haId));
      expect(p.actions[0]).toMatchObject({ allowed: false });
      expect(
        p.facts
          .at(-1)
          ?.map((x) => x.text)
          .join(''),
      ).toBe('Whombat may look only');
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ access: 'manage' })
        .where(eq(catalogConnections.id, haId));
    }
    expect(restarts).toHaveLength(1);
    expect((await call(mara, 'POST', path, { action: 'shutdown' })).status).toBe(400);
  });
});

describe('what it runs on (CP-08)', () => {
  const path = () => `/connections/${haId}/runs-on`;

  it('the person chooses, says nothing Whombat watches, and goes back to automatic', async () => {
    const chosen = await call(mara, 'POST', path(), { mode: 'chosen', serverId: 'basalt', guestId: null });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.runsOn).toMatchObject({
      serverId: 'basalt',
      guestId: null,
      name: 'basalt',
      how: 'chosen',
    });
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'connection.changed'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event?.text).toBe('Said Home Assistant runs on basalt');
    expect((await page(mara, thingId('connection', haId))).runsOn?.how).toBe('chosen');

    const none = await call(mara, 'POST', path(), { mode: 'none' });
    expect(none.body.runsOn).toBeNull();
    expect((await page(mara, thingId('connection', haId))).runsOn).toBeNull();

    const unknown = await call(mara, 'POST', path(), {
      mode: 'chosen',
      serverId: 'shale',
      guestId: 'pve:999',
    });
    expect(unknown.status).toBe(400);

    const auto = await call(mara, 'POST', path(), { mode: 'auto' });
    expect(auto.body.runsOn).toMatchObject({ guestId: 'pve:200', how: 'address' });
  });

  it('keeps a known machine when the lookup times out and clears it after a completed unmapped lookup', async () => {
    const load = async () => {
      const [row] = await t.services.db
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.id, haId));
      if (!row) throw new Error('Missing Home Assistant fixture.');
      return row;
    };
    const before = await checkConnectionHealth(t.services, await load());
    expect(before?.machine).toMatchObject({ serverId: 'shale', guestId: 'pve:200' });
    const row = await load();
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let finishLookup!: (mapped: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      finishLookup = resolve;
    });
    const serves = vi.spyOn(hostsFor(t.services), 'serves').mockImplementationOnce(() => {
      lookupStarted();
      return pending;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const checked = checkConnectionHealth(t.services, row);
      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await checked)?.machine).toEqual(before?.machine);
      expect((await load()).glance).toMatchObject({ machine: before?.machine });
    } finally {
      finishLookup(false);
      vi.useRealTimers();
      serves.mockRestore();
    }
    expect(
      (
        await checkConnectionHealth(
          t.services,
          await load().then((r) => ({
            ...r,
            runsOn: { mode: 'none' as const },
          })),
        )
      )?.machine,
    ).toBeUndefined();
  });

  it('waits for a successful backup inventory read before raising an overdue warning', async () => {
    const guest = fake.guest('shale', 'pve:200');
    if (!guest) throw new Error('Missing fixture guest.');
    const now = t.services.clock();
    const before = { backup_job: guest.backup_job, last_backup: guest.last_backup };
    Object.assign(guest, { backup_job: true, last_backup: { at: now.toISOString(), result: 'error' } });
    const hosts = hostsFor(t.services);
    hosts.forget('guests:shale');
    let status = 503;
    let active = true;
    fake.on('GET', '/api/v1/servers/shale/guests/pve:200/backups', () =>
      active ? { status, body: { items: [] } } : null,
    );
    const machine = (name: string) =>
      readMachine(t.services, { serverId: 'shale', guestId: 'pve:200', runsOn: { name } }, null);
    try {
      const unread = await machine('Backup inventory unavailable');
      expect(unread).toMatchObject({ backupJob: true, lastBackup: { result: 'error' } });
      expect(unread?.lastSuccessfulBackupAt).toBeUndefined();
      expect(backupNotice(unread, now)).toBeNull();
      status = 200;
      const empty = await machine('Backup inventory empty');
      expect(empty?.lastSuccessfulBackupAt).toBeNull();
      expect(backupNotice(empty, now)?.check).toBe('machine.backup_old');
    } finally {
      active = false;
      Object.assign(guest, before);
      hosts.forget('guests:shale');
    }
  });
});

describe('every connection gets a page (CP-06, CP-10)', () => {
  it('a generic one in slots gets its machine as a card, no figures or charts', async () => {
    // Grafana's read fails here: its page is the page of a connection without a kind.
    const p = await page(mara, thingId('connection', grafanaId));
    expect(p.name).toBe('Grafana');
    expect(p.status).toBe('unknown');
    // Grafana answers on CT 200's address too: Whombat knows its machine.
    expect(p.runsOn).toMatchObject({ guestId: 'pve:200' });
    expect(p.tabs.map((x) => x.key)).toEqual(['overview']);
    const panels = p.tabs[0]?.panels ?? [];
    expect(panels.filter((x) => x.kind === 'kpis' || x.kind === 'chart')).toEqual([]);
    const card = panels.find((x) => x.id === 'machine');
    expect(card?.kind === 'bars' && card.items.map((i) => i.label)).toEqual([
      'Processor',
      'Memory',
      expect.stringContaining('Backed up'),
    ]);
    expect(card).toMatchObject({ title: 'The machine', link: { kind: 'href' } });
    // Nothing on it follows the range: no range picker.
    expect(p.ranges).toEqual([p.range]);
    const notices = p.tabs[0]?.panels.find((x) => x.kind === 'notices');
    // Worth a look is a strip on top only while it has a line.
    expect(notices).toBeUndefined();
    // Every panel says where it sits; a 0.88 client still has a width.
    for (const x of p.tabs[0]?.panels ?? []) {
      expect(x.place).toBeDefined();
      expect(x.width).toBeDefined();
      expect(thingPanelPlace(x, true)).toBe(x.place);
    }
  });

  it('a Proxmox connection to a watched server is part of it, on its page and on Home', async () => {
    const p = await page(mara, thingId('connection', proxmoxId));
    expect(p.partOf).toBe('server:basalt');
    // Its Summary is basalt from what Whombat knows of it: what is on it, and basalt as the machine, linked.
    const panels = p.tabs[0]?.panels ?? [];
    expect(panels.find((x) => x.id === 'inventory')).toMatchObject({ kind: 'list', title: 'On basalt' });
    expect(panels.find((x) => x.id === 'machine')).toMatchObject({
      link: { kind: 'href', href: '/things/server%3Abasalt' },
    });
    expect(panels.find((x) => x.id === 'part-of')).toBeUndefined();
    const [principal] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const burrow = await t.services.db.query.burrows.findFirst();
    if (!principal || !burrow) throw new Error('viewer');
    const home = await homeOverview(t.services, { principal, burrow });
    expect(home.things.find((x) => x.id === thingId('connection', proxmoxId))?.partOf).toBe('server:basalt');
    expect(home.things.find((x) => x.id === thingId('connection', haId))?.partOf).toBeUndefined();
  });
});

describe('widgets on a page (CP-14)', () => {
  // The agent pins in a turn for Mara (one-agent.md OA-10): on her pages.
  const forMara = { onBehalfOf: { principalId: IDS.mara } };

  it('the agent keeps one on Home Assistant’s page for Mara; Home shows only its own', async () => {
    const thing = thingId('connection', haId);
    const res = await t.commit(
      agent,
      pinWidget,
      {
        title: 'Database size',
        source: {
          kind: 'connection_tool',
          connectionId: haId,
          tool: 'request',
          args: { method: 'GET', path: '/api/' },
          values: [{ key: 'size', label: 'Size', path: '/size' }],
        },
        thingId: thing,
      },
      forMara,
    );
    expect(res.status).toBe('ok');
    const onPage = WidgetsResponse.parse(
      (await call(mara, 'GET', `/widgets?thing=${encodeURIComponent(thing)}`)).body,
    );
    expect(onPage.widgets.map((w) => [w.title, w.thingId])).toEqual([['Database size', thing]]);
    const home = WidgetsResponse.parse((await call(mara, 'GET', '/widgets')).body);
    expect(home.widgets.find((w) => w.title === 'Database size')).toBeUndefined();
    const id = onPage.widgets[0]?.id as string;
    const removed = WidgetsResponse.parse((await call(mara, 'DELETE', `/widgets/${id}`)).body);
    expect(removed.widgets).toEqual([]);
    expect(await t.services.db.select().from(widgets).where(eq(widgets.id, id))).toEqual([]);
  });

  it('refuses a page the person can’t see', async () => {
    const res = await t
      .commit(
        agent,
        pinWidget,
        {
          title: 'Nope',
          source: {
            kind: 'connection_tool',
            connectionId: haId,
            tool: 'request',
            args: { method: 'GET', path: '/api/' },
            values: [{ key: 'x', label: 'X', path: '/x' }],
          },
          thingId: 'connection:con_nothere0000',
        },
        forMara,
      )
      .catch((err: Error) => ({ status: 'error', message: err.message }));
    expect(res).toMatchObject({ status: 'error', message: 'Thing not found.' });
  });
});

describe('the range and the points (DS-03, DS-11)', () => {
  // “Answers in” is the typical answer time of the burrow's day (Europe/Amsterdam), so the page is read at moments
  // around midnight there and in UTC as well as now: the newest check is at that moment, so today always has one.
  it.each([
    ['now', null],
    ['just after midnight in Amsterdam', '2026-11-05T23:00:30Z'],
    ['the last minute of the first hour in Amsterdam', '2026-11-05T23:59:30Z'],
    ['just after midnight in UTC', '2026-11-06T00:00:30Z'],
    ['just before midnight in Amsterdam', '2026-11-05T22:59:30Z'],
    ['just after midnight in Amsterdam in summer time', '2026-07-01T22:00:30Z'],
  ])(
    'the page without a kind says how it answers from the points; a range it doesn’t offer is 24 hours (%s)',
    async (_, at) => {
      const now = at ? new Date(at) : t.services.clock();
      const original = t.services.clock;
      t.services.clock = () => new Date(now);
      const hour = 3600_000;
      try {
        // A response time every two hours for a week, the newest one now, a failed check now and then.
        await t.services.db.delete(connectionPoints).where(eq(connectionPoints.connectionId, grafanaId));
        await t.services.db.insert(connectionPoints).values(
          Array.from({ length: 84 }, (_, i) => ({
            connectionId: grafanaId,
            key: RTT_KEY,
            at: new Date(now.getTime() - i * 2 * hour),
            value: i % 10 === 5 ? null : 100 + (i % 7) * 10,
          })),
        );
        const week = await page(mara, thingId('connection', grafanaId), '7d');
        expect(week.range).toBe('7d');
        const panels = week.tabs[0]?.panels ?? [];
        // The response time stays in Settings' checks; the Summary says how it answers.
        expect(panels.find((x) => x.id === 'response')).toBeUndefined();
        const answers = panels.find((x) => x.id === 'answers');
        expect(answers?.kind === 'list' && answers.items.map((i) => i.id)).toEqual([
          'answers',
          'answer-time',
          'last-used',
        ]);
        // Eight live checks unanswered, each standing for 7.5 minutes across a gap.
        expect(answers?.kind === 'list' && answers.items[0]?.figure?.note).toMatch(/\b1 h$/);
        const trend = panels.find((x) => x.id === 'week');
        expect(trend?.kind === 'chart' && trend.labels).toHaveLength(7);
        expect(trend?.kind === 'chart' && trend.figure?.value).toMatch(/^1\d\d ms$/);
        expect((await page(mara, thingId('connection', grafanaId), '90d')).range).toBe('24h');
        expect(
          (await call(mara, 'GET', `${pagePath(thingId('connection', grafanaId))}?range=forever`)).status,
        ).toBe(400);
      } finally {
        t.services.clock = original;
        await t.services.db.delete(connectionPoints).where(eq(connectionPoints.connectionId, grafanaId));
      }
    },
  );

  it('the hourly job rolls points older than 48 hours into hours and removes those past 30 days', async () => {
    const now = t.services.clock();
    const hourStart = Math.floor(now.getTime() / 3600_000) * 3600_000;
    const at = (hoursAgo: number, min: number) => new Date(hourStart - hoursAgo * 3600_000 + min * 60_000);
    await t.services.db.insert(connectionPoints).values([
      // 60 hours ago: three points and a gap in one hour.
      { connectionId: grafanaId, key: 'r_test', at: at(60, 5), value: 10 },
      { connectionId: grafanaId, key: 'r_test', at: at(60, 25), value: 20 },
      { connectionId: grafanaId, key: 'r_test', at: at(60, 45), value: null },
      // 70 hours ago: only gaps.
      { connectionId: grafanaId, key: 'r_test', at: at(70, 10), value: null },
      // An hour rolled up before stays.
      { connectionId: grafanaId, key: 'r_test', at: at(80, 0), value: 7 },
      // 31 days ago: gone.
      { connectionId: grafanaId, key: 'r_test', at: at(31 * 24, 10), value: 1 },
      // A day ago: kept as it is.
      { connectionId: grafanaId, key: 'r_test', at: at(24, 5), value: 3 },
      { connectionId: grafanaId, key: 'r_test', at: at(24, 10), value: 4 },
      // A single down reading on the hour and a partly covered hour.
      { connectionId: grafanaId, key: UP_KEY, at: at(61, 0), value: 0 },
      { connectionId: grafanaId, key: UP_KEY, at: at(60, 5), value: 0 },
      { connectionId: grafanaId, key: UP_KEY, at: at(60, 15), value: 1 },
      { connectionId: grafanaId, key: UP_KEY, at: at(60, 45), value: null },
    ]);
    await rollUpPoints(t.services, now);
    await rollUpPoints(t.services, now);
    const rows = await t.services.db
      .select()
      .from(connectionPoints)
      .where(and(eq(connectionPoints.connectionId, grafanaId), eq(connectionPoints.key, 'r_test')))
      .orderBy(asc(connectionPoints.at));
    expect(rows.map((r) => [r.at.toISOString(), r.value])).toEqual([
      [at(80, 0).toISOString(), 7],
      [at(70, 0).toISOString(), null],
      [at(60, 0).toISOString(), 15],
      [at(24, 5).toISOString(), 3],
      [at(24, 10).toISOString(), 4],
    ]);
    const points = await t.services.db
      .select()
      .from(connectionPoints)
      .where(and(eq(connectionPoints.connectionId, grafanaId), eq(connectionPoints.key, UP_COUNT_KEY)))
      .orderBy(asc(connectionPoints.at));
    expect(points.map((p) => [p.at, p.value])).toEqual([
      [at(61, 0), 1],
      [at(60, 0), 2],
    ]);
    const read = await page(mara, thingId('connection', grafanaId));
    expect(read.uptime?.upPct).toBe(33.3);
    const answers = read.tabs[0]?.panels.find((p) => p.id === 'answers');
    expect(answers?.kind === 'list' && answers.items[0]?.figure?.note).toContain('10 min');
  });
});

describe('Website or address connections', () => {
  async function addWebsite(label: string) {
    const added = await call(mara, 'POST', '/connections', {
      catalogId: 'uptime',
      signIn: 'none',
      label,
      fields: { kind: 'http', address: 'https://example.com/health', every: '1', runner: 'hub' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const { connection } = api.connections.create.response.parse(added.body);
    const load = async () => {
      const [row] = await t.services.db
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.id, connection.id));
      if (!row) throw new Error('Missing connection.');
      return row;
    };
    const check = fake.checks.find((c) => c.owner === `whombat:connection:${connection.id}`);
    if (!check) throw new Error('Missing hub check.');
    return { id: connection.id, check, path: `/api/v1/checks/${check.id}`, load };
  }

  it('edits, repairs and removes its check, reads its result and leaves hub alerts to standalone checks', async () => {
    const fields = { kind: 'http', address: 'https://example.com/ready', keyword: 'Welcome', every: '15' };
    const input = { catalogId: 'uptime', signIn: 'none', fields };
    const needsRunner = await call(mara, 'POST', '/connections', input);
    expect(needsRunner.body).toMatchObject({
      error: {
        details: {
          code: 'field_choice_needed',
          field: 'runner',
          options: expect.arrayContaining([
            { value: 'hub', label: 'This Whombat' },
            expect.objectContaining({ value: 'shale' }),
          ]),
        },
      },
    });
    const added = await call(mara, 'POST', '/connections', {
      ...input,
      fields: { ...fields, runner: 'shale' },
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
    const first = await load();
    const hubCheck = fake.checks.find((check) => check.id === first.hubCheckId);
    if (!hubCheck) throw new Error('Check is missing');
    expect(fake.calls('POST', '/api/v1/checks').at(-1)?.body).toMatchObject({
      owner: `whombat:connection:${connection.id}`,
      target: fields.address,
      runner: 'shale',
      interval_s: 900,
      options: { keyword: 'Welcome' },
    });

    // Older hubs only serve the check through the list.
    fake.on('GET', '/api/v1/checks/*', () => ({ status: 404 }));
    const at = t.services.clock();
    Object.assign(hubCheck, {
      status: 'up',
      since: at.toISOString(),
      last: { at: at.toISOString(), ok: true, latency_ms: 82 },
    });
    await checkConnectionHealth(t.services, first, at);
    const saved = await t.services.db
      .select()
      .from(connectionPoints)
      .where(eq(connectionPoints.connectionId, connection.id));
    expect(saved).toContainEqual(expect.objectContaining({ key: RTT_KEY, value: 82 }));
    const p = await page(mara, thingId('connection', connection.id));
    expect(JSON.stringify(p)).toContain('Answering');
    expect(JSON.stringify(p)).toContain('82 ms');
    expect(JSON.stringify(p)).toContain('example.com/ready');

    Object.assign(hubCheck, { status: 'down', last: { at: at.toISOString(), ok: false }, stale: true });
    const stale = await checkConnectionHealth(t.services, await load(), new Date(at.getTime() + 300_000));
    expect(stale).toMatchObject({ status: 'unknown', line: 'Not checked' });
    const unseen = await page(mara, thingId('connection', connection.id));
    expect(unseen).toMatchObject({ status: 'unknown', readAt: at.toISOString() });
    hubCheck.stale = false;
    const down = await checkConnectionHealth(t.services, await load(), new Date(at.getTime() + 600_000));
    expect(down).toMatchObject({ status: 'offline', lines: [{ check: 'uptime.down' }] });
    const thing = thingId('connection', connection.id);
    const lineStates = () => t.services.db.select().from(noticeStates).where(eq(noticeStates.thingId, thing));
    expect(await lineStates()).toMatchObject([{ checkId: 'uptime.down' }]);

    const addAlert = (id: string, checkId: unknown) =>
      fake.openAlert({
        id,
        rule: 'check.down',
        entity: `check:${checkId}`,
        severity: 'critical',
        server: null,
        title: id,
      });
    addAlert('owned-hub-check', first.hubCheckId);
    addAlert('standalone-hub-check', 'ck_standalone');
    hostsFor(t.services).forget();
    const ctx = {
      services: t.services,
      db: t.services.db,
      personId: IDS.mara,
      burrowId: t.burrowId,
      now: at,
    };
    for (const items of [await hostsNeedsYou(ctx), await hostsWatch(ctx)]) {
      expect(items.map((item) => item.title)).toContain('standalone-hub-check');
      expect(items.map((item) => item.title)).not.toContain('owned-hub-check');
    }
    fake.resolveAlert('owned-hub-check');
    fake.resolveAlert('standalone-hub-check');

    fake.on('PATCH', `/api/v1/checks/${first.hubCheckId}`, (r) => {
      expect(r.body).not.toHaveProperty('owner');
      Object.assign(hubCheck, r.body);
      return { status: 200, body: hubCheck };
    });
    const edited = await call(mara, 'PATCH', `/connections/${connection.id}`, {
      label: 'Example website',
      fields: { address: 'https://example.com/status', keyword: '', every: '5' },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(hubCheck).toMatchObject({
      name: 'Example website',
      target: 'https://example.com/status',
      interval_s: 300,
      options: {},
    });
    expect(await load()).toMatchObject({ hubCheckId: first.hubCheckId, glanceAt: null, glance: null });
    expect(await lineStates()).toEqual([]);
    const home = await call(mara, 'GET', '/home');
    expect(home.status).toBe(200);
    expect(
      api.home.overview.response.parse(home.body).things.find((item) => item.id === thing),
    ).toMatchObject({
      status: 'unknown',
      line: 'Not checked yet',
    });

    fake.checks.splice(fake.checks.indexOf(hubCheck), 1);
    const beforeRepair = await load();
    await Promise.all([
      checkConnectionHealth(t.services, beforeRepair),
      checkConnectionHealth(t.services, beforeRepair),
    ]);
    const repaired = await load();
    expect(repaired.hubCheckId).not.toBe(first.hubCheckId);
    expect(fake.checks).toHaveLength(1);
    const removed = await call(mara, 'DELETE', `/connections/${connection.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(fake.checks).toHaveLength(0);
  });

  it('records a failure between passes while showing the current recovered status', async () => {
    const site = await addWebsite('Health history');
    const first = t.services.clock();
    const second = new Date(first.getTime() + 5 * 60_000);
    Object.assign(site.check, { status: 'up', last: { at: first.toISOString(), ok: true, latency_ms: 20 } });
    fake.on('GET', site.path, (r) => ({
      status: 200,
      body: {
        ...site.check,
        period_status:
          r.query.get('since') === first.toISOString() && r.query.get('until') === second.toISOString()
            ? 'down'
            : 'up',
      },
    }));
    await checkConnectionHealth(t.services, await site.load(), first);
    Object.assign(site.check, { last: { at: second.toISOString(), ok: true, latency_ms: 20 } });
    expect(await checkConnectionHealth(t.services, await site.load(), second)).toMatchObject({
      status: 'ok',
      line: 'Answering',
    });
    const points = await t.services.db
      .select()
      .from(connectionPoints)
      .where(and(eq(connectionPoints.connectionId, site.id), eq(connectionPoints.key, UP_KEY)))
      .orderBy(asc(connectionPoints.at));
    expect(points.map((p) => p.value)).toEqual([1, 0]);
    expect((await call(mara, 'DELETE', `/connections/${site.id}`)).status).toBe(200);
  });

  it('reports down and not checked separately in Check again and keeps monitoring', async () => {
    const site = await addWebsite('Manual check');
    const at = t.services.clock().toISOString();
    Object.assign(site.check, { status: 'down', last: { at, ok: false } });
    fake.on('GET', site.path, () => ({ status: 200, body: site.check }));
    const recheck = () => call(mara, 'POST', `/connections/${site.id}/check`);
    const down = await recheck();
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({
      connection: { status: 'active' },
      checks: [{ id: 'destination', state: 'error', message: expect.stringContaining('answering') }],
    });
    expect(JSON.stringify(await page(mara, thingId('connection', site.id)))).not.toContain(
      'address isn’t allowed',
    );
    Object.assign(site.check, { stale: true, status: 'pending' });
    expect((await recheck()).body).toMatchObject({
      connection: { status: 'active' },
      checks: [{ id: 'destination', state: 'warning', message: expect.stringContaining('checked') }],
    });
    expect((await call(mara, 'DELETE', `/connections/${site.id}`)).status).toBe(200);
  });

  it('disconnects while the hosts service is unavailable and later sweeps only the orphan', async () => {
    const gone = await addWebsite('Orphan');
    const kept = await addWebsite('Kept');
    const standalone = { ...kept.check, id: 'ck_standalone', owner: undefined };
    fake.checks.push(standalone);
    fake.refuseToken = true;
    try {
      expect((await call(mara, 'DELETE', `/connections/${gone.id}`)).status).toBe(200);
      await expect(gone.load()).rejects.toThrow('Missing connection');
      expect(fake.checks).toContain(gone.check);
    } finally {
      fake.refuseToken = false;
    }
    await pollConnectionHealth(t.services);
    expect(fake.checks).not.toContain(gone.check);
    expect(fake.checks).toEqual(expect.arrayContaining([kept.check, standalone]));
    expect((await call(mara, 'DELETE', `/connections/${kept.id}`)).status).toBe(200);
    fake.checks.splice(fake.checks.indexOf(standalone), 1);
  });

  it('keeps a failed detail read from its first failure until a read works', async () => {
    const kind = kindOf('homeassistant');
    if (!kind?.seen) throw new Error('Home Assistant has no reader');
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, haId));
    if (!row) throw new Error('Connection is missing');
    const at = t.services.clock();
    const failing = vi.spyOn(kind, 'seen').mockRejectedValue(new Error('Reader failed'));
    try {
      const first = await checkConnectionHealth(t.services, row, at);
      expect(first?.readFailedSince).toBe(at.toISOString());
      await checkConnectionHealth(t.services, { ...row, glance: first }, new Date(at.getTime() + 3_600_000));
      expect(
        await t.services.db.select().from(noticeStates).where(eq(noticeStates.checkId, 'conn.read_failed')),
      ).toHaveLength(1);
    } finally {
      failing.mockRestore();
    }
    const recovered = await checkConnectionHealth(t.services, row, new Date(at.getTime() + 3_900_000));
    expect(recovered?.readFailedSince).toBeUndefined();
    expect(
      await t.services.db.select().from(noticeStates).where(eq(noticeStates.checkId, 'conn.read_failed')),
    ).toHaveLength(0);
  });

  it('filters out unscheduled connections before taking the poll batch', async () => {
    const now = t.services.clock();
    const old = new Date(now.getTime() - 3_600_000);
    await t.services.db.insert(catalogConnections).values(
      Array.from({ length: 51 }, (_, i) => ({
        id: `con_unscheduled_${i}`,
        catalogId: 'onepassword',
        burrowId: t.burrowId,
        label: `Unscheduled ${i}`,
        handle: `unscheduled-${i}`,
        transport: 'rest' as const,
        signIn: 'token' as const,
        baseUrl: 'onepassword:',
        glanceAt: old,
      })),
    );
    await t.services.db
      .update(catalogConnections)
      .set({ glanceAt: null })
      .where(eq(catalogConnections.id, haId));
    expect(await pollConnectionHealth(t.services, now)).toBeGreaterThan(0);
    const [looked] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, haId));
    expect(looked?.glanceAt).toEqual(now);
  });
});

it('starts server uptime at its first report on the page and in history', async () => {
  const server = fake.detailOf('shale')?.server as Record<string, unknown>;
  const now = t.services.clock().getTime();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const started = hoursAgo(5);
  const alert = fake.openAlert({
    id: 'history-offline',
    server: 'shale',
    rule: 'agent.heartbeat_missing',
    severity: 'critical',
    title: 'Didn’t check in',
    state: 'resolved',
    opened_at: hoursAgo(6),
    resolved_at: hoursAgo(4),
  });
  server.first_report_at = started;
  try {
    const uptime = { from: started, upPct: 80, downMinutes: 60, text: expect.stringContaining('since') };
    const detail = await call(mara, 'GET', '/hosts/servers/shale');
    expect(detail.status).toBe(200);
    expect(detail.body.uptime).toMatchObject(uptime);
    const history = await call(mara, 'GET', '/things/server%3Ashale/history?days=30');
    expect(history.status).toBe(200);
    expect(history.body.uptime).toMatchObject(uptime);
  } finally {
    fake.alerts.splice(fake.alerts.indexOf(alert), 1);
    delete server.first_report_at;
  }
});

it('lists server alerts that were still open during the history period', async () => {
  const now = t.services.clock().getTime();
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const alerts = [
    { id: 'history-open', title: '/srv full', opened_at: daysAgo(40) },
    {
      id: 'history-crossed',
      title: '/data full',
      opened_at: daysAgo(42),
      state: 'resolved',
      resolved_at: daysAgo(22),
    },
    {
      id: 'history-too-early',
      title: '/archive full',
      opened_at: daysAgo(42),
      state: 'resolved',
      resolved_at: daysAgo(32),
    },
  ].map((alert) =>
    fake.openAlert({ server: 'shale', rule: 'disk.space_high', severity: 'warning', ...alert }),
  );
  try {
    const history = await call(mara, 'GET', '/things/server%3Ashale/history?days=30');
    expect(history.status).toBe(200);
    expect(history.body.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '/srv full', openedAt: daysAgo(40), resolvedAt: null }),
        expect.objectContaining({ title: '/data full', openedAt: daysAgo(42), resolvedAt: daysAgo(22) }),
      ]),
    );
    expect(history.body.alerts).not.toContainEqual(expect.objectContaining({ title: '/archive full' }));
  } finally {
    for (const alert of alerts) fake.alerts.splice(fake.alerts.indexOf(alert), 1);
  }
});

it('marks server alerts unavailable when the fleet works but the alert list fails', async () => {
  const hosts = hostsFor(t.services);
  const callHost = hosts.call.bind(hosts);
  const spy = vi.spyOn(hosts, 'call').mockImplementation(async (request) => {
    if (request.path.endsWith('/alerts')) throw new Error('Alerts unavailable');
    return callHost(request);
  });
  try {
    const history = await call(mara, 'GET', '/things/server%3Ashale/history?days=30');
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ incidents: [], alertsUnavailable: { serverName: 'shale' } });
    expect(history.body).not.toHaveProperty('alerts');
  } finally {
    spy.mockRestore();
  }
  const history = await call(mara, 'GET', '/things/server%3Ashale/history?days=30');
  expect(history.status).toBe(200);
  expect(history.body).not.toHaveProperty('alertsUnavailable');
});
