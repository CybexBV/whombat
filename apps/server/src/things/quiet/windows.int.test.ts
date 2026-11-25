/**
 * Keep quiet for a while and one cause, end to end. It needs Postgres because
 * the commands, the health pass, the quiet reads, the causes job and Home's reads meet only there. A connection to a
 * stub that answers with an error: kept quiet over `things.keepQuiet` (its page says so, its dot and Needs you are
 * quiet, the pass counts nothing), ended with End now (what is still wrong counts again from the start), Undo, the
 * assistant only on the person's word, a cause on its page and Home, and an internet outage taking it with it.
 */
import { api, type ThingPage, thingId } from '@whombat/core';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Stub, startStub } from '../../connections/provision/testing-home';
import {
  catalogConnections,
  changes,
  noticeStates,
  principals,
  quietWindows,
  thingCauses,
  vaultNetworks,
  wayOutOutages,
} from '../../db/schema/index';
import { checkConnectionHealth } from '../../home/health';
import { needsYou, things, watchList } from '../../home/overview';
import { directUndoerFor, openChange } from '../../home/registry';
import type { ToolContext } from '../../mcp/tools';
import type { ActorInfo } from '../../read/principals';
import type { DispatchRow } from '../../runtime/context';
import { IDS } from '../../seed/test-world';
import { insertConnection } from '../../test/connections';
import { useTestServer } from '../../test/harness';
import { sessionFor } from '../../test/tokens';
import { useVaultNetForTests } from '../../vault/net';
import { passCauses, takenNames } from '../causes';
import { forgetKindReads } from '../kinds/read';
import { KEEP_QUIET_CHANGE_KIND } from './window-commands';
import { QUIET_ASK_FIRST_TEXT, quietUntilTool } from './window-service';

const t = useTestServer({ seed: true, app: true });

let stub: Stub;
const stubNet = {
  resolve: async () => [{ address: '192.168.94.10', family: 4 as const }],
  dialAddress: () => '127.0.0.1',
  deadlineMs: 5000,
};
let port = 0;
let apiId = '';
let person = '';

beforeAll(async () => {
  stub = await startStub(() => ({ status: 500, body: 'boom' }));
  port = Number(new URL(stub.url).port);
  useVaultNetForTests(t.services, stubNet);
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_windows_test',
    cidr: '192.168.94.0/24',
    ports: [port],
    note: 'Windows stub',
    addedAt: t.services.clock(),
  });
  apiId = await insertConnection(t.services, {
    catalogId: 'custom_api',
    burrowId: t.burrowId,
    label: 'Grafana',
    fields: { url: `http://grafana.windows-test.example:${port}` },
    secret: 'glsa_test',
  });
  person = (await sessionFor(t.services, IDS.mara)).cookie;
});

afterAll(async () => {
  await stub?.close();
});

beforeEach(async () => {
  await t.services.db.delete(quietWindows);
  await t.services.db.delete(thingCauses);
  await t.services.db.delete(wayOutOutages);
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

async function page(): Promise<ThingPage> {
  const res = await call(person, 'GET', path());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return api.things.page.response.parse(res.body);
}

function worth(p: ThingPage) {
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

async function myThing() {
  return (await things(t.services, await viewer(IDS.mara))).find((x) => x.id === thing());
}

async function watched() {
  return (await watchList(t.services, await viewer(IDS.mara))).some((i) => i.ref.id === apiId);
}

async function states() {
  return t.services.db.select().from(noticeStates).where(eq(noticeStates.thingId, thing()));
}

async function failing() {
  // A failed check colours the dot from its second pass in a row.
  await pass();
  await pass();
  expect((await myThing())?.status).not.toBe('ok');
  expect(await watched()).toBe(true);
}

describe('Keep quiet for a while', () => {
  it('keeps every line quiet until its time, with the note, and the pass counts nothing', async () => {
    await failing();
    const res = await call(person, 'POST', path('/keep-quiet'), { minutes: 60, note: 'Moving the NAS' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const kept = api.things.keepQuiet.response.parse(res.body).keptQuiet;
    expect(kept).toMatchObject({ note: 'Moving the NAS', canEnd: true, by: { id: IDS.mara } });
    expect(kept?.words).toContain('Moving the NAS');

    const p = await page();
    expect(p.keptQuiet?.id).toBe(kept?.id);
    expect(p.status).not.toBe('bad');
    const lines = worth(p);
    expect(lines[0]).toMatchObject({ id: 'quiet-window', nature: 'fyi' });
    expect(lines.find((l) => l.check === 'conn.answers')?.quiet).toMatchObject({
      state: 'snoozed',
      held: 'window',
    });

    const mine = await myThing();
    expect(mine?.status).toBe('ok');
    expect(mine?.quietUntil).toBe(kept?.until);
    expect(await watched()).toBe(false);

    await pass();
    expect(await states()).toEqual([]);

    // Kept quiet with Undo, in what was done.
    const [change] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.kind, KEEP_QUIET_CHANGE_KIND));
    expect(change?.title).toContain('Grafana');
  });

  it('End now watches it again, and what is still wrong counts from the start', async () => {
    await failing();
    await call(person, 'POST', path('/keep-quiet'), { minutes: 30 });
    await pass();
    const ended = await call(person, 'POST', path('/keep-quiet/end'), {});
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(api.things.endQuiet.response.parse(ended.body).keptQuiet).toBeNull();
    expect((await page()).keptQuiet).toBeUndefined();
    // Its confirmation passes again: quiet after the first pass, coloured after the second.
    await pass();
    expect((await myThing())?.status).toBe('ok');
    await pass();
    expect((await myThing())?.status).not.toBe('ok');
    expect((await call(person, 'POST', path('/keep-quiet/end'), {})).status).toBe(404);
  });

  it('Undo of keeping it quiet ends it', async () => {
    await call(person, 'POST', path('/keep-quiet'), { minutes: 30 });
    const [row] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.kind, KEEP_QUIET_CHANGE_KIND))
      .orderBy(desc(changes.createdAt))
      .limit(1);
    const undoer = directUndoerFor(KEEP_QUIET_CHANGE_KIND);
    const opened = row ? openChange(t.services.custody, row) : null;
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
    expect((await page()).keptQuiet).toBeUndefined();
  });

  it('Home says until when also while the connection needs signing in again', async () => {
    const [was] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, apiId));
    await t.services.db
      .update(catalogConnections)
      .set({ status: 'needs_reauth' })
      .where(eq(catalogConnections.id, apiId));
    try {
      const res = await call(person, 'POST', path('/keep-quiet'), { minutes: 60 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const kept = api.things.keepQuiet.response.parse(res.body).keptQuiet;
      const mine = await myThing();
      expect(mine?.line).toBe('Needs you to sign in again');
      expect(mine?.quietUntil).toBe(kept?.until);
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ status: was?.status ?? 'active' })
        .where(eq(catalogConnections.id, apiId));
    }
  });

  it('the assistant keeps it quiet only on the person’s word', async () => {
    const toolCtx = (asked: string | undefined): ToolContext => ({
      services: t.services,
      agentId: IDS.dusty,
      burrowId: t.burrowId,
      dispatch: {
        id: 'dsp_quiet_test',
        burrowId: t.burrowId,
        onBehalfOfAccountId: 'acc_mara',
      } as DispatchRow,
      onBehalfOf: asked ? { principalId: asked } : {},
    });
    await expect(quietUntilTool(toolCtx(undefined), { thing: thing(), minutes: 60 })).rejects.toThrow(
      QUIET_ASK_FIRST_TEXT,
    );
    const asked = await quietUntilTool(toolCtx(IDS.mara), { thing: thing(), minutes: 60, note: 'Tonight' });
    expect(asked.status === 'ok' && asked.quiet?.words).toContain('Tonight');
    const listed = await quietUntilTool(toolCtx(undefined), { thing: thing() });
    expect(listed.status === 'ok' && listed.quiet).toBeTruthy();
    const [change] = await t.services.db.select().from(changes).where(eq(changes.agentId, IDS.dusty));
    expect(change).toMatchObject({ personId: IDS.mara });
    const ended = await quietUntilTool(toolCtx(IDS.mara), { thing: thing(), end: true });
    expect(ended.status === 'ok' && ended.quiet).toBeNull();
  });
});

describe('One cause, one message', () => {
  it('a thing down because of its server is grey, says why, and is in no list of its own', async () => {
    await failing();
    const now = t.services.clock();
    await t.services.db.insert(thingCauses).values({
      ownerId: t.burrowId,
      thingId: thing(),
      causeThing: 'server:pve-02',
      causeName: 'pve-02',
      words: 'while pve-02 is down',
      since: now,
      checkedAt: now,
    });
    const p = await page();
    expect(p.status).toBe('unknown');
    expect(p.badge).toBe('Not answering while pve-02 is down');
    expect(p.causedBy).toMatchObject({ thing: 'server:pve-02', name: 'pve-02' });
    expect(worth(p)[0]).toMatchObject({ id: 'quiet-cause' });
    const mine = await myThing();
    expect(mine).toMatchObject({ status: 'unknown', causedBy: { thing: 'server:pve-02' } });
    expect(mine?.line).toBe('Not answering while pve-02 is down');
    expect(await watched()).toBe(false);
  });

  it('while the internet is down, the connections on it that don’t answer are listed under that one item', async () => {
    await failing();
    const since = new Date(t.services.clock().getTime() - 5 * 60_000);
    await t.services.db.insert(wayOutOutages).values({ id: 'wo_test', step: 'internet', startedAt: since });
    // Answering with an error is answering: the internet being down doesn't explain it, as for the incidents.
    await passCauses(t.services);
    expect(await t.services.db.select().from(thingCauses).where(eq(thingCauses.thingId, thing()))).toEqual(
      [],
    );
    // Now it doesn't answer at all: nothing listens where it is dialled.
    useVaultNetForTests(t.services, { ...stubNet, dialAddress: () => '127.0.0.2' });
    try {
      await pass();
    } finally {
      useVaultNetForTests(t.services, stubNet);
    }
    expect(await passCauses(t.services)).toBeGreaterThanOrEqual(1);
    const [cause] = await t.services.db.select().from(thingCauses).where(eq(thingCauses.thingId, thing()));
    expect(cause).toMatchObject({ causeThing: 'box:network', words: 'while the internet is down' });
    expect(await watched()).toBe(false);
    const items = await needsYou(t.services, await viewer(IDS.mara));
    const outage = items.find((i) => i.ref.kind === 'way_out');
    expect(outage?.title).toContain('The internet is down since');
    expect(outage?.body).toContain('Grafana');

    // A cause the job hasn't confirmed lately counts for nothing, also in what the outage takes with it.
    const now = t.services.clock();
    expect(await takenNames(t.services.db, t.burrowId, 'box:network', now)).toEqual(['Grafana']);
    expect(
      await takenNames(t.services.db, t.burrowId, 'box:network', new Date(now.getTime() + 10 * 60_000)),
    ).toEqual([]);

    // Once the internet is back the cause goes, and the connection counts again on its own.
    await t.services.db.update(wayOutOutages).set({ endedAt: t.services.clock() });
    await passCauses(t.services);
    expect(await t.services.db.select().from(thingCauses).where(eq(thingCauses.thingId, thing()))).toEqual(
      [],
    );
  });
});
