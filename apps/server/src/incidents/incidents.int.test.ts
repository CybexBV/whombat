/**
 * Incidents end to end on a real database (monitoring.md MON-06, MON-09, MON-10): a connection that stops answering
 * opens an incident on the watcher's second pass and signs `thing.down`; ten minutes on it is pushed once, as the
 * person's “Needs you” row; when it answers again for two passes it ends, signs `thing.back` and its push is withdrawn
 * (the row read). Its page says its week, `things.history` lists it, and the assistant reads it with `watch_status` and
 * `watch_history`. What was already down at the watcher's very first pass is never pushed; a thing kept quiet or not
 * seen keeps its incident without a push until it is seen fine again. Postgres because each step is a signed commit, an
 * inbox row and a read across them.
 */
import { topics } from '@whombat/core';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogConnections,
  events,
  incidents,
  notifications,
  quietWindows,
  wayOutOutages,
} from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { serversPrincipal } from '../hosts/principal';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { agentTokenFor } from '../test/tokens';
import { thingPage } from '../things/page';
import { thingHistory } from './history';
import type { PassBefore } from './plan';
import { incidentsPass, incidentsPush, pushKey } from './store';
import { watchIncidents } from './watch';

const t = useTestServer({ seed: true, listen: true });
const MIN = 60_000;
const T0 = new Date('2026-11-24T13:00:00Z');
let now = T0;
let real: () => Date;
let before: PassBefore | null = null;
let mine: PersonalSetup;
let plex = '';
let sonarr = '';

/** One watcher pass at `minutes` past T0, remembering what it saw. */
async function passAt(minutes: number) {
  now = new Date(T0.getTime() + minutes * MIN);
  before = await watchIncidents(t.services, TEST_BURROW_ID, before);
  await t.services.background.settle();
}

/** The line a connection that doesn't answer has, as the health pass keeps it. */
const NOT_ANSWERING = {
  check: 'conn.answers',
  tone: 'bad',
  nature: 'problem',
  title: 'Whombat can’t reach it',
  confirm: 2,
  seen: 2,
  offline: true,
} as const;

function glance(status: 'offline' | 'ok' | 'unknown', id = plex) {
  return t.services.db
    .update(catalogConnections)
    .set({
      glance:
        status === 'offline'
          ? { status, reason: 'Not answering', facts: [], lines: [NOT_ANSWERING] }
          : status === 'ok'
            ? { status, facts: [], lines: [] }
            : { status, facts: [] },
      glanceAt: now,
    })
    .where(eq(catalogConnections.id, id));
}

const thing = () => `connection:${plex}`;

async function rows() {
  return t.services.db.select().from(incidents).where(eq(incidents.thingId, thing()));
}

async function signed(type: string, of = thing()) {
  const rows = await t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, TEST_BURROW_ID), eq(events.type, type)));
  return rows.filter((e) => (e.payload as { thing?: string }).thing === of);
}

async function incidentPushes() {
  return t.services.db.select().from(notifications).where(like(notifications.dedupKey, 'incident:%'));
}

/** The parts of every `home.changed` the person gets while `run` runs. */
async function homeChanged(run: () => Promise<void>): Promise<string[][]> {
  const person = await thePerson(t.services.db, TEST_BURROW_ID);
  const parts: string[][] = [];
  const stop = t.services.bus.onFrame((f) => {
    if (f.topic === topics.me(person?.id ?? '') && f.event.type === 'home.changed')
      parts.push([...f.event.parts]);
  });
  try {
    await run();
  } finally {
    stop();
  }
  return parts;
}

beforeAll(async () => {
  real = t.services.clock;
  t.services.clock = () => now;
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  // Only this test's connection needs a look: the seed's are fine.
  await t.services.db.update(catalogConnections).set({ status: 'active', glance: null });
  plex = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: TEST_BURROW_ID,
    label: 'Plex',
    handle: 'plex',
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'token-plex',
  });
  sonarr = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: TEST_BURROW_ID,
    label: 'Sonarr',
    handle: 'sonarr',
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'token-sonarr',
  });
  await glance('ok');
  // Sonarr has been down since before Whombat watched (the update that brings incidents).
  await glance('offline', sonarr);
});

afterAll(() => {
  t.services.clock = real;
});

describe('what was down before Whombat watched', () => {
  it('opens on the first passes after the update as already told, and never pushes', async () => {
    await passAt(-30);
    await passAt(-29);
    const [row] = await t.services.db
      .select()
      .from(incidents)
      .where(eq(incidents.thingId, `connection:${sonarr}`));
    expect(row).toMatchObject({ nature: 'down', endedAt: null, pushGroup: null });
    expect(row?.pushedAt).not.toBeNull();
    await passAt(-15);
    expect(await incidentPushes()).toEqual([]);
    await glance('ok', sonarr);
    await passAt(-14);
    await passAt(-13);
    const [ended] = await t.services.db
      .select()
      .from(incidents)
      .where(eq(incidents.thingId, `connection:${sonarr}`));
    expect(ended?.endedAt).toEqual(new Date(T0.getTime() - 14 * MIN));
  });
});

describe('an outage, its push and its history', () => {
  it('opens an incident on the second pass in a row and signs thing.down', async () => {
    await glance('offline');
    let opened: string[][] = [];
    await passAt(0);
    expect(await rows()).toEqual([]);
    opened = await homeChanged(() => passAt(1));
    // An open page's “What happened” hears of it.
    expect(opened.some((parts) => parts.includes('things'))).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({ nature: 'down', name: 'Plex', endedAt: null, pushedAt: null });
    expect(row?.startedAt).toEqual(T0);
    const [down] = await signed('thing.down');
    expect(down?.payload).toMatchObject({
      incidentId: row?.id,
      thing: thing(),
      nature: 'down',
      name: 'Plex',
    });
    expect(down?.text).toBeNull();
  });

  it('pushes once after ten minutes, as the person’s Needs you row', async () => {
    await passAt(5);
    expect((await rows())[0]?.pushedAt).toBeNull();
    await passAt(11);
    const [row] = await rows();
    expect(row?.pushedAt).toEqual(now);
    const person = await thePerson(t.services.db, TEST_BURROW_ID);
    const pushed = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, pushKey(row?.pushGroup ?? '')));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ principalId: person?.id, kind: 'needs_you', readAt: null });
    expect(pushed[0]?.text).toContain('Plex');
    // Once: the next pass pushes nothing more.
    await passAt(12);
    const all = await t.services.db
      .select()
      .from(notifications)
      .where(inArray(notifications.dedupKey, [pushKey(row?.pushGroup ?? '')]));
    expect(all).toHaveLength(1);
  });

  it('ends after two passes without, signs thing.back and withdraws the push quietly', async () => {
    await glance('ok');
    await passAt(20);
    expect((await rows())[0]?.endedAt).toBeNull();
    const ended = await homeChanged(() => passAt(21));
    expect(ended.some((parts) => parts.includes('things'))).toBe(true);
    const [row] = await rows();
    expect(row?.endedAt).toEqual(new Date(T0.getTime() + 20 * MIN));
    expect(row?.withdrawnAt).not.toBeNull();
    const [back] = await signed('thing.back');
    expect(back?.payload).toMatchObject({ incidentId: row?.id, thing: thing() });
    const [pushed] = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, pushKey(row?.pushGroup ?? '')));
    expect(pushed?.readAt).not.toBeNull();
  });

  it('says its week on its page and lists it in its history', async () => {
    const person = await thePerson(t.services.db, TEST_BURROW_ID);
    if (!person) throw new Error('no person');
    const viewer = { accountId: person.accountId ?? '', burrowId: TEST_BURROW_ID, principal: person };
    const page = await thingPage(t.services, viewer, thing(), 'Europe/Amsterdam');
    expect(page.uptime).toMatchObject({ downs: 1, downMinutes: 20 });
    expect(page.facts.some((f) => f.map((p) => p.text).join('') === page.uptime?.text)).toBe(true);
    const history = await thingHistory(t.services, viewer, thing(), 30, 'Europe/Amsterdam');
    expect(history.incidents).toHaveLength(1);
    expect(history.incidents[0]).toMatchObject({ nature: 'down', minutes: 20 });
    expect(history.uptime?.downs).toBe(1);
  });

  it('lets the assistant read how everything is and what went wrong', async () => {
    const token = await agentTokenFor(t.services, TEST_BURROW_ID, mine.agentId, mine.dmId);
    const mcp = await mcpClient(t.baseUrl, token.token);
    const status = await mcp.client.callTool({ name: 'watch_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toMatchObject({ status: 'ok', incidents: [] });
    const history = await mcp.client.callTool({
      name: 'watch_history',
      arguments: { thing: 'plex', days: 7 },
    });
    expect(history.isError).toBeFalsy();
    const out = history.structuredContent as { incidents: { name: string; minutes: number }[] };
    expect(out.incidents.map((i) => [i.name, i.minutes])).toEqual([['Plex', 20]]);
    await mcp.close();
  });

  it('includes saved internet outages in all-things history', async () => {
    await t.services.pipeline.transactAccount((tx) =>
      tx.insert(wayOutOutages).values({
        id: 'wo_history',
        step: 'internet',
        startedAt: new Date(T0.getTime() - 25 * MIN),
        endedAt: new Date(T0.getTime() - 15 * MIN),
      }),
    );
    const token = await agentTokenFor(t.services, TEST_BURROW_ID, mine.agentId, mine.dmId);
    const mcp = await mcpClient(t.baseUrl, token.token);
    try {
      const all = await mcp.client.callTool({ name: 'watch_history', arguments: {} });
      expect(all.isError).toBeFalsy();
      expect(all.structuredContent).toMatchObject({
        wayOutOutages: [
          {
            words: expect.stringContaining('internet was down'),
            started: expect.any(String),
            ended: expect.any(String),
          },
        ],
      });
      const one = await mcp.client.callTool({ name: 'watch_history', arguments: { thing: 'plex' } });
      expect(one.structuredContent).not.toHaveProperty('wayOutOutages');
    } finally {
      await mcp.close();
    }
  });
});

describe('a thing held or unseen while it is down', () => {
  const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

  it('keeps the incident without a push while it is kept quiet, and ends it only once seen fine', async () => {
    await glance('offline');
    await passAt(100);
    await passAt(101);
    const [open] = (await rows()).filter((r) => !r.endedAt);
    expect(open?.startedAt).toEqual(at(100));
    // Kept quiet at 14:09 (minute 109) to fix it: it leaves the looks while it is still down.
    await t.services.db.insert(quietWindows).values({
      id: 'qw_plex_fix',
      ownerId: TEST_BURROW_ID,
      thingId: thing(),
      startsAt: at(109),
      endsAt: at(200),
      createdAt: at(109),
    });
    for (const minute of [109, 110, 111, 112]) await passAt(minute);
    const [held] = (await rows()).filter((r) => r.id === open?.id);
    expect(held).toMatchObject({ endedAt: null, pushedAt: null });
    expect(await signed('thing.back')).toHaveLength(1);
    // The window ends and Plex answers: two passes seen fine end it.
    await t.services.db
      .update(quietWindows)
      .set({ endedAt: at(115) })
      .where(eq(quietWindows.id, 'qw_plex_fix'));
    await glance('ok');
    await passAt(116);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toBeNull();
    await passAt(117);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toEqual(at(116));
    expect(await signed('thing.back')).toHaveLength(2);
    expect((await incidentPushes()).filter((n) => n.text.includes('Plex'))).toHaveLength(1);
  });

  it('keeps it while Whombat can’t see the thing', async () => {
    await glance('offline');
    await passAt(130);
    await passAt(131);
    const [open] = (await rows()).filter((r) => !r.endedAt);
    expect(open).toBeDefined();
    await glance('unknown');
    for (const minute of [132, 133, 134]) await passAt(minute);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toBeNull();
    await glance('ok');
    await passAt(135);
    await passAt(136);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toEqual(at(135));
  });

  it('checks again in the push’s own commit, and names only what is still open and not held', async () => {
    const signer = await serversPrincipal(t.services, TEST_BURROW_ID);
    now = at(300);
    const opened = (thingId: string, name: string) => ({
      thing: thingId,
      kind: 'connection' as const,
      name,
      nature: 'down' as const,
      words: 'Not answering',
      check: 'conn.answers',
      subject: '',
      cause: null,
      startedAt: at(290).toISOString(),
    });
    await t.services.pipeline.commit(
      incidentsPass,
      {
        opened: [opened(thing(), 'Plex'), opened(`connection:${sonarr}`, 'Sonarr')],
        changed: [],
        ended: [],
      },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    const open = await t.services.db
      .select()
      .from(incidents)
      .where(eq(incidents.startedAt, at(290)));
    const plexRow = open.find((r) => r.name === 'Plex');
    const sonarrRow = open.find((r) => r.name === 'Sonarr');
    if (!plexRow || !sonarrRow) throw new Error('Missing incidents');
    // Sonarr ended meanwhile: the push names Plex alone.
    await t.services.pipeline.commit(
      incidentsPass,
      { opened: [], changed: [], ended: [{ id: sonarrRow.id, endedAt: at(299).toISOString() }] },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    const result = await t.services.pipeline.commit(
      incidentsPush,
      { ids: [plexRow.id, sonarrRow.id] },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    expect(result).toMatchObject({ status: 'ok', result: { pushed: 1 } });
    await t.services.background.settle();
    const [pushed] = await t.services.db.select().from(incidents).where(eq(incidents.id, plexRow.id));
    const [row] = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, pushKey(pushed?.pushGroup ?? '')));
    expect(row?.text).toContain('Plex');
    expect(row?.text).not.toContain('Sonarr');
    // One kept quiet meanwhile isn't pushed at all.
    await t.services.pipeline.commit(
      incidentsPass,
      { opened: [], changed: [], ended: [{ id: plexRow.id, endedAt: at(301).toISOString() }] },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    now = at(310);
    await t.services.pipeline.commit(
      incidentsPass,
      { opened: [{ ...opened(thing(), 'Plex'), startedAt: at(305).toISOString() }], changed: [], ended: [] },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    const [again] = await t.services.db
      .select()
      .from(incidents)
      .where(eq(incidents.startedAt, at(305)));
    await t.services.db.insert(quietWindows).values({
      id: 'qw_plex_again',
      ownerId: TEST_BURROW_ID,
      thingId: thing(),
      startsAt: at(309),
      endsAt: at(400),
      createdAt: at(309),
    });
    const held = await t.services.pipeline.commit(
      incidentsPush,
      { ids: [again?.id ?? ''] },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    expect(held).toMatchObject({ status: 'ok', result: { pushed: 0 } });
  });
});
