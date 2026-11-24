/**
 * Quiet notices end to end (quiet-notices.md QN-10…QN-17, QN-21, QN-22; QN-S01…): it needs Postgres because the
 * health pass, the commit pipeline's commands, the quiet rows and Home's reads meet only there. A connection to a stub
 * that answers well or with an error: the dot from the second failed check, Ignore over `things.quiet` for the person,
 * the page greyed with who and until when, Home and Activity following, the Ignore ending after
 * two good checks; Remind me tomorrow ended early by a worse line; Stop watching and What Whombat watches; a signed-out
 * connection leaving Needs you and Watch while ignored.
 */
import { api, type ThingPage, thingId } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Stub, startStub } from '../../connections/provision/testing-home';
import * as schema from '../../db/schema/index';
import {
  catalogConnections,
  changes,
  events,
  noticeQuiets,
  noticeStates,
  principals,
  vaultNetworks,
  watchOffs,
  watchOns,
} from '../../db/schema/index';
import { listChanges } from '../../home/changes';
import { checkConnectionHealth, pollConnectionHealth } from '../../home/health';
import { needsYou, things, watchList } from '../../home/overview';
import { directUndoerFor, openChange } from '../../home/registry';
import type { ToolContext } from '../../mcp/tools';
import type { ActorInfo } from '../../read/principals';
import type { DispatchRow } from '../../runtime/context';
import { IDS } from '../../seed/test-world';
import type { Services } from '../../services';
import { insertConnection } from '../../test/connections';
import { useTestServer } from '../../test/harness';
import { sessionFor } from '../../test/tokens';
import { useVaultNetForTests } from '../../vault/net';
import { forgetKindReads } from '../kinds/read';
import { ASK_FIRST_TEXT, watchChecksTool } from './agent';
import { FIXED_PASSES } from './apply';
import { AGENT_WATCH_CHANGE_KIND } from './commands';
import * as store from './store';
import { pruneGoneThings } from './store';

const t = useTestServer({ seed: true, app: true });

let stub: Stub;
/** Every name is the stub's address on the local network, dialled on loopback. */
const stubNet = {
  resolve: async () => [{ address: '192.168.93.10', family: 4 as const }],
  dialAddress: () => '127.0.0.1',
  deadlineMs: 5000,
};
let mode: 'ok' | 'error' = 'ok';
let port = 0;
let apiId = '';
let person = '';

beforeAll(async () => {
  stub = await startStub(() => (mode === 'ok' ? { json: { ok: true } } : { status: 500, body: 'boom' }));
  port = Number(new URL(stub.url).port);
  useVaultNetForTests(t.services, stubNet);
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_quiet_test',
    cidr: '192.168.93.0/24',
    ports: [port],
    note: 'Quiet stub',
    addedAt: t.services.clock(),
  });
  apiId = await insertConnection(t.services, {
    catalogId: 'custom_api',
    burrowId: t.burrowId,
    label: 'Grafana',
    fields: { url: `http://grafana.quiet-test.test:${port}` },
    secret: 'glsa_test',
  });
  person = (await sessionFor(t.services, IDS.mara)).cookie;
});

afterAll(async () => {
  await stub?.close();
});

const thing = () => thingId('connection', apiId);
const path = (suffix = '') => `/api/v1/burrows/burrow-hq/things/${encodeURIComponent(thing())}${suffix}`;

async function call(cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function page(cookie: string): Promise<ThingPage> {
  const res = await call(cookie, 'GET', path());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return api.things.page.response.parse(res.body);
}

function worth(p: ThingPage) {
  // Without a line the page has no Worth a look at all.
  const panel = p.tabs[0]?.panels.find((x) => x.kind === 'notices');
  return panel?.kind === 'notices' ? panel.items : [];
}

async function pass() {
  forgetKindReads(t.services);
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, apiId));
  if (!row) throw new Error('no row');
  return checkConnectionHealth(t.services, row);
}

async function viewer(id: string) {
  const [principal] = await t.services.db.select().from(principals).where(eq(principals.id, id));
  const burrow = await t.services.db.query.burrows.findFirst();
  if (!principal || !burrow) throw new Error('viewer');
  return { principal, burrow };
}

async function myThing(id: string) {
  return (await things(t.services, await viewer(id))).find((x) => x.id === thing());
}

async function rows() {
  return t.services.db.select().from(noticeQuiets).where(eq(noticeQuiets.thingId, thing()));
}

const answers = { check: 'conn.answers' };

describe('Ignore until it is fixed (QN-11, QN-14, QN-17)', () => {
  it('an error colours the dot from the second check in a row', async () => {
    mode = 'error';
    const first = await pass();
    expect(first).toMatchObject({ status: 'ok', outcome: 'error' });
    expect(first?.lines).toMatchObject([{ check: 'conn.answers', nature: 'problem', seen: 1 }]);
    expect((await myThing(IDS.mara))?.status).toBe('ok');
    const second = await pass();
    expect(second).toMatchObject({ status: 'warn', reason: 'It answered with an error' });
    expect(await myThing(IDS.mara)).toMatchObject({ status: 'warn', reason: 'It answered with an error' });
    const p = await page(person);
    expect(p).toMatchObject({ status: 'warn' });
    expect(worth(p)).toMatchObject([
      { check: 'conn.answers', nature: 'problem', ignore: { lifts: 'fixed' }, link: { kind: 'ask' } },
    ]);
  });

  it('the person ignores it', async () => {
    const res = await call(person, 'POST', path('/quiet'), { notice: answers, how: 'ignore' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const answer = api.things.quiet.response.parse(res.body);
    expect(answer.quiet).toMatchObject({ state: 'ignored', by: { id: IDS.mara, name: 'Mara' } });
    expect(answer.quiet?.words).toContain('answers properly again');
    // The dot and the page follow at once; the figures stay true.
    const after = await myThing(IDS.mara);
    expect(after?.status).toBe('ok');
    expect(after?.reason).toBeUndefined();
    const p = await page(person);
    expect(p.status).toBe('ok');
    expect(worth(p)).toMatchObject([
      { check: 'conn.answers', quiet: { state: 'ignored', by: { name: 'Mara' } } },
    ]);
    const answered = p.tabs[0]?.panels.find((x) => x.id === 'answers');
    expect(answered?.kind === 'list' && answered.items[0]?.figure?.note).toBe('Answers with errors');
    // In the thing's Activity, not in Done recently; signed without words for the burrow's log.
    const mara = (await viewer(IDS.mara)).principal;
    const mine = await listChanges(t.services.db, mara, { thing: thing(), now: t.services.clock() });
    expect(mine.changes[0]?.title).toContain('It’s answering with errors');
    const done = await listChanges(t.services.db, mara, { now: t.services.clock() });
    expect(done.changes.some((c) => c.title.includes('It answered the last check'))).toBe(false);
    const [signed] = await t.services.db.select().from(events).where(eq(events.type, 'thing.quiet'));
    expect(signed?.text).toBeNull();
  });

  it('stays ignored while it fails, ends after an hour of good checks, and the next outage shows again', async () => {
    expect((await pass())?.status).toBe('ok');
    expect(await rows()).toHaveLength(1);
    mode = 'ok';
    await pass();
    expect((await rows())[0]?.clearPasses).toBe(1);
    for (let i = 2; i < FIXED_PASSES; i++) await pass();
    expect((await rows())[0]?.clearPasses).toBe(FIXED_PASSES - 1);
    await pass();
    expect(await rows()).toEqual([]);
    // Ending by itself isn't recorded (QN-17), and the line's state is gone with it.
    expect(
      await t.services.db
        .select()
        .from(noticeStates)
        .where(and(eq(noticeStates.thingId, thing()), eq(noticeStates.checkId, 'conn.answers'))),
    ).toEqual([]);
    mode = 'error';
    await pass();
    expect((await pass())?.status).toBe('warn');
    // Nothing quiet to take back now.
    expect((await call(person, 'POST', path('/quiet'), { notice: answers, how: 'undo' })).status).toBe(404);
  });
});

describe('Remind me tomorrow (QN-12)', () => {
  it('quiets it until 09:00 tomorrow, and a worse line ends it early', async () => {
    const res = await call(person, 'POST', path('/quiet'), { notice: answers, how: 'snooze' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const answer = api.things.quiet.response.parse(res.body);
    expect(answer.quiet).toMatchObject({ state: 'snoozed', words: expect.stringContaining('09:00') });
    expect((await myThing(IDS.mara))?.status).toBe('ok');
    // It stops answering at all: worse than an error (warn → bad).
    await t.services.db
      .update(catalogConnections)
      .set({
        baseUrl: 'http://grafana.quiet-test.test:1',
        fields: { url: 'http://grafana.quiet-test.test:1' },
      })
      .where(eq(catalogConnections.id, apiId));
    await pass();
    expect(await rows()).toEqual([]);
    expect((await pass())?.status).toBe('offline');
    await t.services.db
      .update(catalogConnections)
      .set({
        baseUrl: `http://grafana.quiet-test.test:${port}`,
        fields: { url: `http://grafana.quiet-test.test:${port}` },
      })
      .where(eq(catalogConnections.id, apiId));
    await pass();
    await pass();
  });
});

describe('Stop watching (QN-13, QN-15)', () => {
  it('drops the line everywhere until it is watched again, with What Whombat watches saying so', async () => {
    expect((await myThing(IDS.mara))?.status).toBe('warn');
    const off = await call(person, 'POST', path('/watch'), { check: 'conn.answers', watched: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const watch = api.things.setWatch.response.parse(off.body);
    expect(watch.mayChange).toBe(true);
    expect(watch.checks.find((c) => c.check === 'conn.answers')).toMatchObject({
      on: false,
      off: { by: { id: IDS.mara } },
    });
    expect(worth(await page(person)).some((n) => n.check === 'conn.answers')).toBe(false);
    expect((await myThing(IDS.mara))?.status).toBe('ok');
    expect(
      (await call(person, 'POST', path('/watch'), { check: 'nope.nothing', watched: false })).status,
    ).toBe(404);
    const on = await call(person, 'POST', path('/watch'), { check: 'conn.answers', watched: true });
    expect(
      api.things.setWatch.response.parse(on.body).checks.find((c) => c.check === 'conn.answers')?.on,
    ).toBe(true);
    expect((await myThing(IDS.mara))?.status).toBe('warn');
    mode = 'ok';
    await pass();
  });

  it('a check that starts off is off until someone turns it on, and off again without a trace (watch-defaults.md)', async () => {
    const check = (body: Record<string, unknown>) =>
      api.things.setWatch.response.parse(body).checks.find((c) => c.check === 'conn.read');
    const listed = await call(person, 'GET', path('/watch'));
    expect(check(listed.body)).toMatchObject({ on: false });
    expect(check(listed.body)?.off).toBeUndefined();
    const on = await call(person, 'POST', path('/watch'), { check: 'conn.read', watched: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(check(on.body)).toMatchObject({ on: true });
    const rows = () =>
      t.services.db
        .select()
        .from(watchOns)
        .where(and(eq(watchOns.thingId, thing()), eq(watchOns.checkId, 'conn.read')));
    expect(await rows()).toMatchObject([{ byId: IDS.mara }]);
    const mara = (await viewer(IDS.mara)).principal;
    const mine = await listChanges(t.services.db, mara, { thing: thing(), now: t.services.clock() });
    expect(mine.changes[0]?.title).toMatch(/^Started watching .*Reading its details/);
    const off = await call(person, 'POST', path('/watch'), { check: 'conn.read', watched: false });
    expect(check(off.body)).toMatchObject({ on: false });
    expect(check(off.body)?.off).toBeUndefined();
    expect(await rows()).toEqual([]);
  });
});

describe('The assistant stops watching on the person’s word (on-purpose.md)', () => {
  const toolCtx = (asked: string | undefined): ToolContext => ({
    services: t.services,
    agentId: IDS.dusty,
    burrowId: t.burrowId,
    dispatch: { id: 'dsp_watch_test', burrowId: t.burrowId, onBehalfOfAccountId: 'acc_mara' } as DispatchRow,
    onBehalfOf: asked ? { principalId: asked } : {},
  });
  const answersCheck = (checks: { check: string; on: boolean }[]) =>
    checks.find((c) => c.check === 'conn.answers');

  it('lists the checks in any turn, and switches one only when the person’s own message started the turn', async () => {
    const listed = await watchChecksTool(toolCtx(undefined), { thing: thing() });
    expect(listed.status === 'ok' && answersCheck(listed.checks)?.on).toBe(true);
    // A turn the assistant started itself (a look it looked into): it asks first.
    await expect(
      watchChecksTool(toolCtx(undefined), { thing: thing(), check: 'conn.answers', watched: false }),
    ).rejects.toThrow(ASK_FIRST_TEXT);
    await expect(
      watchChecksTool(toolCtx(IDS.dusty), { thing: thing(), check: 'conn.answers', watched: false }),
    ).rejects.toThrow(ASK_FIRST_TEXT);
  });

  it('requires the person’s word before the assistant can change a server alert limit', async () => {
    const input = { thing: 'server:granite', check: 'host.disk.space_high', limit: 95 };
    for (const asked of [undefined, IDS.dusty]) {
      await expect(watchChecksTool(toolCtx(asked), input)).rejects.toThrow('Ask the person');
    }
  });

  it('records the switch as the assistant’s change for the person, whose Undo watches it again', async () => {
    const off = await watchChecksTool(toolCtx(IDS.mara), {
      thing: thing(),
      check: 'conn.answers',
      watched: false,
    });
    expect(off.status === 'ok' && answersCheck(off.checks)?.on).toBe(false);
    const mara = (await viewer(IDS.mara)).principal;
    // In what the assistant did, with Undo (not an everyday switch).
    const done = await listChanges(t.services.db, mara, { now: t.services.clock() });
    const change = done.changes.find((c) => c.title.startsWith('Stopped watching'));
    expect(change).toBeDefined();
    const [row] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.id, change?.id ?? ''));
    expect(row).toMatchObject({ agentId: IDS.dusty, personId: IDS.mara, kind: AGENT_WATCH_CHANGE_KIND });
    const undoer = directUndoerFor(AGENT_WATCH_CHANGE_KIND);
    expect(undoer).not.toBeNull();
    const opened = openChange(t.services.custody, row as NonNullable<typeof row>);
    if (!opened || !undoer) throw new Error('no undo');
    const result = await undoer(
      {
        services: t.services,
        burrowId: t.burrowId,
        person: { id: IDS.mara, kind: 'person' } as ActorInfo,
        now: t.services.clock(),
      },
      opened,
    );
    expect(result).toMatchObject({ ok: true, state: 'undone' });
    const back = await call(person, 'GET', path('/watch'));
    expect(answersCheck(api.things.watch.response.parse(back.body).checks)?.on).toBe(true);
  });
});

describe('Signed out (QN-21, QN-22)', () => {
  it('leaves Needs you and Watch while someone ignores it, and comes back on Undo', async () => {
    await t.services.db
      .update(catalogConnections)
      .set({ status: 'needs_reauth' })
      .where(eq(catalogConnections.id, apiId));
    const mara = await viewer(IDS.mara);
    expect((await needsYou(t.services, mara)).some((i) => i.ref.id === apiId)).toBe(true);
    expect((await watchList(t.services, mara)).some((i) => i.ref.id === apiId)).toBe(true);
    expect((await myThing(IDS.mara))?.status).toBe('bad');
    const signin = { check: 'conn.signin' };
    const res = await call(person, 'POST', path('/quiet'), { notice: signin, how: 'ignore' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await needsYou(t.services, mara)).some((i) => i.ref.id === apiId)).toBe(false);
    expect((await watchList(t.services, mara)).some((i) => i.ref.id === apiId)).toBe(false);
    expect(await myThing(IDS.mara)).toMatchObject({ status: 'ok', line: 'Needs you to sign in again' });
    const undo = await call(person, 'POST', path('/quiet'), { notice: signin, how: 'undo' });
    expect(api.things.quiet.response.parse(undo.body).quiet).toBeNull();
    expect((await needsYou(t.services, mara)).some((i) => i.ref.id === apiId)).toBe(true);
    // Needs you's own Ignore on it is the quiet store's (QN-21): Watch follows it.
    const ref = { kind: 'connection', id: apiId };
    const ignored = await call(person, 'POST', '/api/v1/burrows/burrow-hq/needs-you/ignore', {
      ref,
      ignored: true,
    });
    expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
    expect((await rows()).map((r) => [r.checkId, r.state])).toEqual([['conn.signin', 'ignored']]);
    expect((await watchList(t.services, await viewer(IDS.mara))).some((i) => i.ref.id === apiId)).toBe(false);
    await call(person, 'POST', '/api/v1/burrows/burrow-hq/needs-you/ignore', { ref, ignored: false });
    expect(await rows()).toEqual([]);
    await t.services.db
      .update(catalogConnections)
      .set({ status: 'active' })
      .where(eq(catalogConnections.id, apiId));
  });
});

describe('Things that are gone (QN-S02)', () => {
  it('lose their quiet rows, offs, ons and states in the hourly sweep', async () => {
    await call(person, 'POST', path('/watch'), { check: 'conn.check', watched: false });
    await call(person, 'POST', path('/watch'), { check: 'conn.read', watched: true });
    expect(await t.services.db.select().from(watchOffs).where(eq(watchOffs.thingId, thing()))).toHaveLength(
      1,
    );
    expect(await t.services.db.select().from(watchOns).where(eq(watchOns.thingId, thing()))).toHaveLength(1);
    await t.services.db.delete(catalogConnections).where(eq(catalogConnections.id, apiId));
    await pruneGoneThings(t.services.db);
    expect(await t.services.db.select().from(watchOffs).where(eq(watchOffs.thingId, thing()))).toEqual([]);
    expect(await t.services.db.select().from(watchOns).where(eq(watchOns.thingId, thing()))).toEqual([]);
    expect(await t.services.db.select().from(noticeStates).where(eq(noticeStates.thingId, thing()))).toEqual(
      [],
    );
  });
});

describe('the health pass', () => {
  /** Services whose reads are logged (the pipeline's writes aren't). */
  function logged() {
    const queries: string[] = [];
    const db = drizzle(t.services.sql, { schema, logger: { logQuery: (q) => void queries.push(q) } });
    const services: Services = { ...t.services, db };
    useVaultNetForTests(services, stubNet);
    const reads = (table: string) =>
      queries.filter((q) => q.startsWith('select') && q.includes(`from "${table}"`)).length;
    return { services, reads };
  }
  const ids: Record<string, string> = {};
  const glances = async () =>
    Object.fromEntries(
      (
        await t.services.db
          .select({ id: catalogConnections.id, glance: catalogConnections.glance })
          .from(catalogConnections)
          .where(inArray(catalogConnections.id, Object.values(ids)))
      ).map((r) => [r.id, r.glance]),
    );
  const due = () =>
    t.services.db
      .update(catalogConnections)
      .set({ glanceAt: null })
      .where(inArray(catalogConnections.id, Object.values(ids)));

  it('reads every connection’s quiet rows, states and the person once, and applies each one’s own', async () => {
    mode = 'error';
    for (const label of ['Prometheus', 'Loki', 'Tempo'])
      ids[label] = await insertConnection(t.services, {
        catalogId: 'custom_api',
        burrowId: t.burrowId,
        label,
        handle: label.toLowerCase(),
        fields: { url: `http://${label.toLowerCase()}.quiet-test.test:${port}` },
        secret: 'glsa_test',
      });
    await pollConnectionHealth(t.services);
    // The person ignores Loki's errors: the next pass applies that to Loki alone.
    const loki = encodeURIComponent(thingId('connection', ids.Loki as string));
    const ignored = await call(person, 'POST', `/api/v1/burrows/burrow-hq/things/${loki}/quiet`, {
      notice: answers,
      how: 'ignore',
    });
    expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
    await due();
    const { services, reads } = logged();
    await pollConnectionHealth(services);
    expect(await glances()).toMatchObject({
      [ids.Prometheus as string]: { status: 'warn', lines: [{ check: 'conn.answers', seen: 2 }] },
      [ids.Loki as string]: { status: 'ok', lines: [{ check: 'conn.answers', seen: 2 }] },
      [ids.Tempo as string]: { status: 'warn', lines: [{ check: 'conn.answers', seen: 2 }] },
    });
    expect({
      quiets: reads('notice_quiets'),
      offs: reads('watch_offs'),
      ons: reads('watch_ons'),
      states: reads('notice_states'),
      person: reads('principals'),
    }).toEqual({ quiets: 1, offs: 1, ons: 1, states: 1, person: 1 });
  });

  it('reads each connection’s own when the pass can’t read them together', async () => {
    vi.spyOn(store, 'passQuiet').mockRejectedValueOnce(new Error('No pass reads'));
    mode = 'ok';
    await due();
    const { services, reads } = logged();
    await pollConnectionHealth(services);
    vi.restoreAllMocks();
    const all = await glances();
    expect(Object.values(all).map((g) => (g as { outcome?: string } | null)?.outcome)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(reads('notice_quiets')).toBe(3);
  });
});
