/**
 * The end of an outage read from the thing itself, on a real database with the watcher's own passes: a Google account
 * that needs a new sign-in opens an incident, stays open while kept quiet and ends as back (not as removed) once signed
 * in, while a watch on it keeps running; a server whose failing disk the person ignored keeps its incident; a
 * connection whose details couldn't be read isn't back; a pass that couldn't read a connection doesn't start its run
 * again. Postgres because each pass is a signed commit read back with the connector rows, line states and windows
 * beside it.
 */
import { FEEDBACK_THING_ID, newId, THING_BACK } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  connections,
  dispatches,
  events,
  incidents,
  noticeStates,
  principals,
  quietWindows,
  thingWatches,
} from '../db/schema/index';
import { createFeedbackIntegration } from '../feedback/integrations';
import { HOSTS_API } from '../hosts/client';
import { hostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { integrationSettings } from '../test/feedback';
import type { GlanceLine } from '../things/quiet/glance';
import { thingWatchTool } from './agent';
import type { PassBefore } from './plan';
import { watchIncidents } from './watch';

const fake = new FakeHostsService();
const w = useAutomationWorld({
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});
const MINUTE = 60_000;
let before: PassBefore | null = null;

beforeAll(async () => {
  await fake.start();
});

afterAll(async () => {
  await fake.stop();
});

/** One watcher pass a minute after the last, remembering what it saw (the servers read afresh). */
async function pass() {
  w.advance(MINUTE);
  hostsFor(w.services).forget('fleet');
  before = await watchIncidents(w.services, w.burrowId, before);
  await w.settle();
}

async function incidentsOf(thing: string) {
  return w.services.db.select().from(incidents).where(eq(incidents.thingId, thing));
}

async function open(thing: string) {
  return (await incidentsOf(thing)).find((r) => !r.endedAt);
}

async function backs(thing: string) {
  return (await w.services.db.select().from(events).where(eq(events.type, THING_BACK))).filter(
    (e) => (e.payload as { thing?: string }).thing === thing,
  );
}

const line = (check: string, title: string, more: Partial<GlanceLine> = {}): GlanceLine => ({
  check,
  tone: 'bad',
  nature: 'problem',
  title,
  seen: 2,
  ...more,
});

const NOT_ANSWERING = line('conn.answers', 'Whombat can’t reach it', { confirm: 2, offline: true });

async function connection(handle: string, label: string) {
  const id = await insertConnection(w.services, {
    catalogId: 'homeassistant',
    burrowId: w.burrowId,
    label,
    handle,
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'test-token',
  });
  return `connection:${id}`;
}

/** What the last health pass stored for a connection (`more`: what else its glance says). */
async function stored(thing: string, list: GlanceLine[] | null, more: Record<string, unknown> = {}) {
  const offline = list?.some((l) => l.offline);
  await w.services.db
    .update(catalogConnections)
    .set({
      glance: list
        ? { status: offline ? 'offline' : list.length ? 'bad' : 'ok', facts: [], lines: list, ...more }
        : { status: 'unknown', facts: [] },
      glanceAt: w.now(),
    })
    .where(eq(catalogConnections.id, thing.slice('connection:'.length)));
}

async function watch(thing: string, event: 'down' | 'back') {
  const { id: messageId } = await w.ok(IDS.mara, sendMessage, {
    conversationId: IDS.dmDusty,
    text: `Tell me when it goes ${event}.`,
  });
  const dispatchId = await w.turn(IDS.dusty, IDS.dmDusty, { messageId });
  const [dispatch] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!dispatch) throw new Error('Missing dispatch');
  const result = await thingWatchTool(
    { services: w.services, agentId: IDS.dusty, burrowId: w.burrowId, dispatch, onBehalfOf: {} },
    { action: 'start', thing, event },
  );
  if (result.status !== 'ok' || !result.watches[0]) throw new Error('Missing watch');
  return result.watches[0].id;
}

async function watchStatus(id: string) {
  return (await w.services.db.select().from(thingWatches).where(eq(thingWatches.id, id)))[0]?.status;
}

describe('the person’s Google account', () => {
  it('opens on a needed sign-in, holds while kept quiet, ends as back once signed in, and keeps a watch', async () => {
    const [mara] = await w.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const id = newId('connection');
    await w.services.db.insert(connections).values({
      id,
      accountId: mara?.accountId as string,
      provider: 'google',
      externalId: 'sub-google',
      email: 'mara@example.com',
      services: ['mail'],
      refreshTokenEnc: 'sealed',
      grantedAt: w.now(),
      status: 'active',
      createdAt: w.now(),
      updatedAt: w.now(),
    } as never);
    const thing = `connection:${id}`;
    const signedIn = (status: 'active' | 'needs_reauth') =>
      w.services.db.update(connections).set({ status }).where(eq(connections.id, id));
    const waiting = await watch(thing, 'down');
    await pass();
    await pass();
    // Signed in and fine: a watch on it isn't stopped as if Google were removed.
    expect(await watchStatus(waiting)).toBe('watching');

    await signedIn('needs_reauth');
    await pass();
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ nature: 'problem', checkId: 'conn.signin' });

    // Kept quiet: it leaves the looks and stays open, not removed.
    await w.services.db.insert(quietWindows).values({
      id: 'qw_google',
      ownerId: w.burrowId,
      thingId: thing,
      startsAt: w.now(),
      endsAt: new Date(w.now().getTime() + 3 * MINUTE),
      createdAt: w.now(),
    });
    await pass();
    await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    // The window over, it still needs the sign-in: still open.
    await pass();
    await pass();
    expect((await open(thing))?.id).toBe(incident?.id);

    // Signed in again: two passes that see it fine end it as back, not as removed.
    await signedIn('active');
    await pass();
    await pass();
    const [ended] = (await incidentsOf(thing)).filter((r) => r.id === incident?.id);
    expect(ended?.endedAt).not.toBeNull();
    // Back, not removed: removed signs nothing.
    expect(await backs(thing)).toHaveLength(1);
    expect(await watchStatus(waiting)).toBe('watching');
  });
});

describe('Website feedback', () => {
  it('keeps a watch on it while it is on here', async () => {
    await w.ok(IDS.mara, createFeedbackIntegration, integrationSettings());
    const waiting = await watch(FEEDBACK_THING_ID, 'down');
    await pass();
    await pass();
    expect(await watchStatus(waiting)).toBe('watching');
  });
});

describe('a server whose critical alert the person ignored', () => {
  it('keeps its incident while the disk still fails, and ends it when the alert resolves', async () => {
    const thing = 'server:granite';
    fake.openAlert({
      id: 'al_granite_disk',
      server: 'granite',
      rule: 'disk.smart_failing',
      severity: 'critical',
      title: 'A disk is failing',
      entity: 'disk:sda',
    });
    await pass();
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ nature: 'problem' });
    // Ignored on its page: the server's dot is fine, its look goes, the disk still fails.
    await hostsFor(w.services).call({
      method: 'POST',
      path: `${HOSTS_API}/alerts/al_granite_disk/ack`,
      body: {},
      actor: { id: IDS.mara, name: 'Mara', role: 'operator' },
    });
    for (let i = 0; i < 3; i++) await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    expect(await backs(thing)).toEqual([]);
    fake.resolveAlert('al_granite_disk');
    await pass();
    await pass();
    expect(await open(thing)).toBeUndefined();
    expect(await backs(thing)).toHaveLength(1);
  });
});

describe('a connection Whombat couldn’t read', () => {
  it('isn’t back while the details that found the fault weren’t read', async () => {
    const thing = await connection('nextcloud', 'Nextcloud');
    const disk = line('machine.disk', 'The disk is almost full');
    await stored(thing, [disk]);
    await pass();
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ checkId: 'machine.disk' });
    // It answers, and its reader fails: the disk wasn't read.
    await stored(thing, [], { readFailedSince: w.now().toISOString() });
    for (let i = 0; i < 3; i++) await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    // The details are read again, but not the machine's disk: its line is the one kept from before.
    await w.services.db.insert(noticeStates).values({
      thingId: thing,
      checkId: 'machine.disk',
      subject: '',
      firstSeen: new Date(w.now().getTime() - 10 * MINUTE),
      lastSeen: new Date(w.now().getTime() - 5 * MINUTE),
      seenPasses: 2,
      tone: 'bad',
    });
    await stored(thing, []);
    for (let i = 0; i < 3; i++) await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    expect(await backs(thing)).toEqual([]);
    // Read fine: the pass drops the line's state, and two such passes end it.
    await w.services.db.delete(noticeStates).where(eq(noticeStates.thingId, thing));
    await pass();
    await pass();
    expect(await open(thing)).toBeUndefined();
    expect(await backs(thing)).toHaveLength(1);
  });

  it('opens from the first bad pass when a pass in between couldn’t read it', async () => {
    const thing = await connection('jellyfin', 'Jellyfin');
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    const first = w.now();
    // Its check couldn't run.
    await stored(thing, null);
    await pass();
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    expect((await open(thing))?.startedAt).toEqual(first);
  });
});
