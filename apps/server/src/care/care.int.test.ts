/**
 * A care plan when a server is added (docs/decisions/care-plan.md), end to end against the fake hosts service: a
 * Whombat from before writes its servers down as known once; a server that first reports afterwards gets one turn in
 * its own thread that knows Whombat's defaults for it, once (and the server this Whombat runs on once, whatever its id),
 * never a temporary machine or one still waiting for its first report; the plan is one `look_plan` card in Whombat's
 * words; Go ahead turns on its automation as the person and wakes a `look_fix` turn for the rest, and its report goes
 * to Done today. An older server's “Ask {assistant} to handle these” gets the same steps; the quiet hours for changes
 * are read and moved, and the turn and Tonight use them. Postgres because every step is a signed commit and a queued
 * turn.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { DIRECT_SCHEMA, NewerAutomationsGate } from '../automations/release-gate';
import {
  automations,
  burrows,
  dispatches,
  doneTasks,
  events,
  lookResearches,
  messages,
  notifications,
  restoreTestServers,
  serverCares,
} from '../db/schema/index';
import { startHosts } from '../hosts/index';
import { hostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { loadMessageRow, loadMessages } from '../read/messages';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { careOfferFor } from './facts';
import { careBurrow } from './watch';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});
let cookie = '';
const ready = { ready: async () => true };

type Json = Record<string, unknown>;

/** A server added to the fleet: a copy of `like`'s card and page under a new id. */
function addServer(id: string, like: string, over: Json = {}): void {
  const servers = fake.fleet.servers as Json[];
  const card = servers.find((s) => s.id === like);
  if (!card) throw new Error(like);
  servers.push({ ...structuredClone(card), id, hostname: id, status: 'online', status_note: null, ...over });
  const detail = structuredClone(fake.details[like] ?? fake.details.shale) as Json;
  detail.server = {
    ...(detail.server as Json),
    id,
    hostname: id,
    ...(over.hosts_this_whombat ? { hosts_this_whombat: true } : {}),
  };
  fake.details[id] = detail;
  hostsFor(t.services).forget('fleet');
}

async function pass() {
  hostsFor(t.services).forget('fleet');
  return careBurrow(t.services, TEST_BURROW_ID, ready);
}

async function careRow(serverId: string) {
  const [row] = await t.services.db
    .select()
    .from(lookResearches)
    .where(and(eq(lookResearches.lookKey, `care:server:${serverId}`), isNull(lookResearches.goneAt)));
  return row;
}

async function dispatchRow(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error(id);
  return row;
}

async function card(messageId: string) {
  const row = await loadMessageRow(t.services.db, messageId);
  if (!row) throw new Error(messageId);
  const [m] = await loadMessages(t.services.db, [row], IDS.mara);
  return m?.card?.kind === 'look_plan' ? m.card.plan : undefined;
}

function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

beforeAll(async () => {
  await fake.start();
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  startHosts(t.services);
});

afterAll(async () => {
  await fake.stop();
});

describe('a care plan when a server is added (care-plan.md)', () => {
  it('writes down the servers of a Whombat from before as known, once, and plans none of them', async () => {
    await t.services.db.update(burrows).set({ careBaselineDue: true }).where(eq(burrows.id, TEST_BURROW_ID));
    expect(await pass()).toBeNull();
    const known = await t.services.db
      .select()
      .from(serverCares)
      .where(eq(serverCares.burrowId, TEST_BURROW_ID));
    expect(known.length).toBe((fake.fleet.servers as Json[]).length);
    expect(known.every((k) => k.state === 'known')).toBe(true);
    expect(known.find((k) => k.serverId === 'basalt')?.self).toBe(true);
    const [b] = await t.services.db.select().from(burrows).where(eq(burrows.id, TEST_BURROW_ID));
    expect(b?.careBaselineDue).toBe(false);
    expect(await pass()).toBeNull();
    const researches = await t.services.db.select().from(lookResearches);
    expect(researches.filter((r) => r.lookKey.startsWith('care:'))).toHaveLength(0);
  });

  it('waits for a new server’s first report, and never plans a temporary machine', async () => {
    addServer('pve-new', 'shale', { status: 'pending', os: null, last_seen: null, current: null });
    addServer('ci-job-a8791974', 'granite');
    expect(await pass()).toBeNull();
    expect(await careRow('pve-new')).toBeUndefined();
    const [ci] = await t.services.db
      .select()
      .from(serverCares)
      .where(eq(serverCares.serverId, 'ci-job-a8791974'));
    expect(ci?.state).toBe('known');
    expect(await careRow('ci-job-a8791974')).toBeUndefined();
  });

  it('gives a new server one turn in its own thread, with Whombat’s defaults for it, once', async () => {
    const servers = fake.fleet.servers as Json[];
    const fresh = servers.find((s) => s.id === 'pve-new') as Json;
    Object.assign(fresh, { status: 'online', os: 'Proxmox VE 9.0.10', last_seen: new Date().toISOString() });
    const started = await pass();
    expect(started).toBeTruthy();
    const row = await careRow('pve-new');
    expect(row).toMatchObject({ id: started, kind: 'server', state: 'looking', personId: IDS.mara });
    expect(row?.care?.new).toBe(true);
    expect(row?.care?.steps.map((s) => s.care)).toEqual(['backup', 'restore_test', 'updates']);
    // The Backup Server, keeping a week, an hour before the quiet hours.
    expect(row?.care?.steps[0]?.text).toContain('02:00 to pbs-01');
    const [opening] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.threadRootId ?? ''));
    expect(opening).toMatchObject({ threadRootId: null, subjectId: 'pve-new' });
    expect(opening?.text).toContain('pve-new');
    const turn = await dispatchRow(row?.dispatchId ?? '');
    expect(turn).toMatchObject({ trigger: 'look', state: 'queued', threadRootId: opening?.id });
    const context = await buildDispatchContext(t.services, turn);
    expect(context.look).toMatchObject({ kind: 'server', server: 'pve-new' });
    expect(context.look?.care?.new).toBe(true);
    expect(context.look?.care?.steps.map((s) => s.id)).toEqual(['backup', 'restore_test', 'updates']);
    expect(context.changeWindow).toEqual({ start: '03:00', end: '05:00' });
    // Once per server: the next pass starts nothing.
    expect(await pass()).toBeNull();
    const all = await t.services.db.select().from(lookResearches);
    expect(all.filter((r) => r.lookKey === 'care:server:pve-new')).toHaveLength(1);
  });

  it('proposes one card in Whombat’s words, pushed once, and Go ahead carries it out', async () => {
    const row = await careRow('pve-new');
    if (!row?.dispatchId) throw new Error('no care turn');
    const mcp = await mcpClient(t.baseUrl, (await issueDispatchToken(t.services, row.dispatchId)).token);
    const res = await mcp.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'pve-new runs 3 machines',
        summary: 'Nothing on it is backed up yet and updates are installed by hand.',
        fixed: false,
        care: ['updates', 'backup', 'snapshots', 'restore_test'],
      },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    await mcp.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, row.dispatchId));
    await t.services.background.settle();
    const found = await careRow('pve-new');
    expect(found?.state).toBe('found');
    // In the order named, only what was offered, in Whombat's words.
    expect(found?.plan?.map((p) => p.care)).toEqual(['updates', 'backup', 'restore_test']);
    const plan = await card(found?.planMessageId ?? '');
    expect(plan).toMatchObject({ name: 'pve-new', state: 'waiting', care: true });
    expect(plan?.steps[0]).toContain('Sundays at 03:00');
    expect(plan?.research?.key).toBe('care:server:pve-new');
    const pushed = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.messageId, found?.planMessageId ?? ''));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.text).toContain('look after pve-new');

    const fix = await request('POST', '/looks/fix', { key: 'care:server:pve-new' });
    expect(fix.statusCode, fix.body).toBe(200);
    expect(fix.json().research.state).toBe('fixing');
    // The updates are an automation Whombat wrote and turned on with the press, on Sundays at the quiet hours' start.
    const [auto] = await t.services.db
      .select()
      .from(automations)
      .where(eq(automations.name, 'Updates on pve-new'));
    expect(auto).toMatchObject({ status: 'published', currentVersion: 1 });
    const [care] = await t.services.db.select().from(serverCares).where(eq(serverCares.serverId, 'pve-new'));
    expect(care?.automations.updates).toBe(auto?.id);
    // The weekly restore tests are a switch Whombat turned on with the same press.
    const [tests] = await t.services.db
      .select()
      .from(restoreTestServers)
      .where(eq(restoreTestServers.serverId, 'pve-new'));
    expect(tests).toMatchObject({ on: true, guests: [] });
    const fixing = await careRow('pve-new');
    const turn = await dispatchRow(fixing?.dispatchId ?? '');
    expect(turn.trigger).toBe('look_fix');
    const context = await buildDispatchContext(t.services, turn);
    expect(context.look?.plan?.[0]?.step).toContain('Updates on pve-new');
    expect(context.look?.plan?.[1]?.step).toContain('backup_job_set');
    expect(context.look?.plan?.[2]?.step).toContain('restore tests');
    expect(context.look?.care).toBeUndefined();

    const mcp2 = await mcpClient(t.baseUrl, (await issueDispatchToken(t.services, turn.id)).token);
    const done = await mcp2.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'pve-new is looked after',
        summary: 'Backups run nightly and updates weekly.',
        fixed: true,
      },
    });
    expect(done.isError).toBeFalsy();
    await mcp2.close();
    expect((await card(found?.planMessageId ?? ''))?.state).toBe('done');
    const [task] = await t.services.db
      .select()
      .from(doneTasks)
      .where(eq(doneTasks.threadRootId, found?.threadRootId ?? ''));
    expect(task?.summary).toBe('pve-new is looked after');
    // A later plan for it doesn't offer the updates again.
    await t.services.db.delete(serverCares).where(eq(serverCares.serverId, 'pve-new'));
    await t.services.db.insert(serverCares).values({
      burrowId: TEST_BURROW_ID,
      serverId: 'pve-new',
      state: 'known',
      automations: { updates: auto?.id ?? '' },
      createdAt: new Date(),
    });
  });

  it('plans the server this Whombat runs on once, whatever id it comes back with', async () => {
    // Its earlier copy was known from before: a new one gets its plan, a third doesn't.
    addServer('home-box', 'granite', { hosts_this_whombat: true });
    const first = await pass();
    expect(first).toBeTruthy();
    const row = await careRow('home-box');
    expect(row?.care?.steps.find((s) => s.care === 'updates')?.text).toContain('Ask you');
    addServer('home-box-2', 'granite', { hosts_this_whombat: true });
    expect(await pass()).toBeNull();
    expect(await careRow('home-box-2')).toBeUndefined();
    const [again] = await t.services.db
      .select()
      .from(serverCares)
      .where(eq(serverCares.serverId, 'home-box-2'));
    expect(again).toMatchObject({ state: 'known', self: true });
  });
});

describe('older servers’ hints get the same plan', () => {
  it('offers the care plan’s steps when the person hands a server’s missing backups over', async () => {
    fake.setHint('shale', 'guest.no_backup_job', {
      server: 'shale',
      kind: 'guest.no_backup_job',
      severity: 'warning',
      entity: 'pve',
      title: '3 guests have no backup job',
      detail: 'web, db, mail',
      link: '#guests',
    });
    hostsFor(t.services).forget('fleet');
    const res = await request('POST', '/looks/handle', { key: 'server:shale' });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await t.services.db
      .select()
      .from(lookResearches)
      .where(and(eq(lookResearches.lookKey, 'server:shale'), isNull(lookResearches.goneAt)));
    expect(row?.care?.new).toBe(false);
    expect(row?.care?.steps.map((s) => s.care)).toContain('backup');
    const context = await buildDispatchContext(t.services, await dispatchRow(row?.dispatchId ?? ''));
    expect(context.look?.care?.new).toBe(false);
    expect(context.look?.care?.steps.some((s) => s.id === 'backup')).toBe(true);
  });

  it('leaves out restore tests while the release the box would go back to doesn’t know them', async () => {
    const opened = t.services.newerAutomations;
    const closed = new NewerAutomationsGate(
      { NODE_ENV: 'production', WHOMBAT_RELEASE_ID: 'rel-now' },
      async () => true,
      async () => DIRECT_SCHEMA,
    );
    closed.follow(() => ({
      state: 'Healthy',
      current: 'rel-now',
      candidate: null,
      lastCheckedAt: null,
      deferredReason: null,
      failure: null,
      lastUpdate: { release: 'rel-now', from: 'rel-before', at: new Date().toISOString() },
    }));
    hostsFor(t.services).forget();
    expect((await careOfferFor(t.services, TEST_BURROW_ID, 'shale'))?.steps.map((s) => s.care)).toContain(
      'restore_test',
    );
    t.services.newerAutomations = closed;
    try {
      const steps = (await careOfferFor(t.services, TEST_BURROW_ID, 'shale'))?.steps ?? [];
      expect(steps.map((s) => s.care)).toContain('backup');
      expect(steps.some((s) => s.care === 'restore_test' || s.restoreTests)).toBe(false);
    } finally {
      t.services.newerAutomations = opened;
    }
  });
});

describe('the quiet hours for changes', () => {
  it('reads 03:00–05:00 until moved, moves them signed, and Tonight and the turn use them', async () => {
    const got = await request('GET', '/change-window');
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toMatchObject({ window: { start: '03:00', end: '05:00' }, default: true });
    const bad = await request('PUT', '/change-window', { window: { start: '02:00', end: '02:00' } });
    expect(bad.statusCode).toBe(400);
    const set = await request('PUT', '/change-window', { window: { start: '22:30', end: '00:30' } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ window: { start: '22:30', end: '00:30' }, default: false });
    const [event] = await t.services.db.select().from(events).where(eq(events.type, 'care.window_set'));
    expect(event?.text).toContain('22:30–00:30');
    const row = await careRow('home-box');
    const context = await buildDispatchContext(t.services, await dispatchRow(row?.dispatchId ?? ''));
    expect(context.changeWindow).toEqual({ start: '22:30', end: '00:30' });
  });
});
