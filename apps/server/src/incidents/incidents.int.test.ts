/**
 * Incidents end to end on a real database: a connection that stops answering
 * opens an incident on the watcher's second pass and signs `thing.down`; ten minutes on it is pushed once, as the
 * person's “Needs you” row; when it answers again for two passes it ends, signs `thing.back` and its push is withdrawn
 * (the row read). Its page says its week, `things.history` lists it, and the assistant reads it with `watch_status` and
 * `watch_history`. What was already down at the watcher's very first pass is never pushed; a thing kept quiet or not
 * seen keeps its incident without a push until it is seen fine again, by a check made after the hold ended; quieting
 * its down line doesn't end it either. Postgres because each step is a signed commit, an inbox row and a read across
 * them.
 */
import { topics } from '@whombat/core';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  catalogConnections,
  connectionPoints,
  events,
  incidents,
  notifications,
  quietWindows,
  wayOutOutages,
} from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import type { ConnectionGlance } from '../home/types';
import { serversPrincipal } from '../hosts/principal';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { agentTokenFor } from '../test/tokens';
import { thingPage } from '../things/page';
import { UP_KEY } from '../things/points';
import { thingHistory } from './history';
import type { PassBefore } from './plan';
import { incidentsPass, incidentsPush, pushKey } from './store';
import { passMemory, watchIncidents } from './watch';

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

  it('retries a failed Inbox insert on the next pass and pushes only once', async () => {
    await passAt(5);
    expect((await rows())[0]?.pushedAt).toBeNull();
    const control = t.services.push.control;
    const deliver = vi.fn(async () => {});
    t.services.push.control = deliver;
    try {
      await t.services.db.execute(sql`
        alter table notifications add constraint incident_push_unavailable check (dedup_key not like 'incident:%')
      `);
      try {
        await passAt(11);
        expect((await rows())[0]).toMatchObject({ pushedAt: null, pushGroup: null });
        expect(await incidentPushes()).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await t.services.db.execute(sql`alter table notifications drop constraint incident_push_unavailable`);
      }
      await passAt(12);
      const [row] = await rows();
      expect(row?.pushedAt).toEqual(now);
      const person = await thePerson(t.services.db, TEST_BURROW_ID);
      const pushed = await incidentPushes();
      expect(pushed).toHaveLength(1);
      const key = pushKey(row?.pushGroup ?? '');
      expect(pushed[0]).toMatchObject({
        principalId: person?.id,
        kind: 'needs_you',
        readAt: null,
        dedupKey: key,
      });
      expect(pushed[0]?.text).toContain('Plex');
      expect(deliver).toHaveBeenCalledWith(
        [person?.id],
        expect.objectContaining({ notificationId: pushed[0]?.id }),
        expect.objectContaining({ group: key }),
      );
      await passAt(13);
      expect(await incidentPushes()).toHaveLength(1);
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      t.services.push.control = control;
    }
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

  it('reports whole-thing quiet windows without presenting a guest window as a quiet server', async () => {
    const startsAt = new Date(now.getTime() - MIN);
    const endsAt = new Date(now.getTime() + MIN);
    const windows = [
      { id: 'qw_status_guest', thingId: 'server:pve-02', guestId: 'pve:200' },
      { id: 'qw_status_thing', thingId: thing(), guestId: null },
    ];
    await t.services.db.insert(quietWindows).values(
      windows.map((window) => ({
        ...window,
        ownerId: TEST_BURROW_ID,
        startsAt,
        endsAt,
        createdAt: startsAt,
      })),
    );
    const token = await agentTokenFor(t.services, TEST_BURROW_ID, mine.agentId, mine.dmId);
    const mcp = await mcpClient(t.baseUrl, token.token);
    try {
      const status = await mcp.client.callTool({ name: 'watch_status', arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toMatchObject({ quiet: [{ thing: thing(), name: 'Plex' }] });
    } finally {
      await mcp.close();
      await t.services.db.delete(quietWindows).where(
        inArray(
          quietWindows.id,
          windows.map((w) => w.id),
        ),
      );
    }
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

it('clips the 90-day uptime line to its first reading while keeping older incidents in the list', async () => {
  const connectionId = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: TEST_BURROW_ID,
    label: 'Archive',
    handle: 'archive',
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'token-archive',
  });
  const id = `connection:${connectionId}`;
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * MIN);
  await t.services.pipeline.transact(TEST_BURROW_ID, async ({ tx }) => {
    await tx.insert(connectionPoints).values({ connectionId, at: daysAgo(28), key: UP_KEY, value: 1 });
    const base = {
      burrowId: TEST_BURROW_ID,
      thingId: id,
      kind: 'connection' as const,
      name: 'Archive',
      nature: 'down' as const,
      words: 'Not answering',
    };
    await tx.insert(incidents).values([
      { ...base, id: 'inc_archive_old', startedAt: daysAgo(55), endedAt: daysAgo(54) },
      { ...base, id: 'inc_archive_recent', startedAt: daysAgo(29), endedAt: daysAgo(27) },
    ]);
  });
  const person = await thePerson(t.services.db, TEST_BURROW_ID);
  if (!person) throw new Error('Missing person');
  const history = await thingHistory(
    t.services,
    { burrowId: TEST_BURROW_ID, principal: person, accountId: person.accountId ?? '' },
    id,
    90,
    'Europe/Amsterdam',
  );
  expect(history.incidents.map((i) => i.id)).toEqual(['inc_archive_recent', 'inc_archive_old']);
  expect(history.uptime).toMatchObject({
    from: daysAgo(28).toISOString(),
    downs: 1,
    downMinutes: 24 * 60,
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
    // The window ends. A check made while it held says nothing of now: Plex isn't back yet.
    await t.services.db
      .update(quietWindows)
      .set({ endedAt: at(115) })
      .where(eq(quietWindows.id, 'qw_plex_fix'));
    await glance('ok');
    await passAt(116);
    await passAt(117);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toBeNull();
    // Checked again after the window, it answers: two passes seen fine end it.
    await glance('ok');
    await passAt(118);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toBeNull();
    await passAt(119);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toEqual(at(118));
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

  it('keeps it while its down line is quieted, or not counted again yet after a hold', async () => {
    await glance('offline');
    await passAt(150);
    await passAt(151);
    const [open] = (await rows()).filter((r) => !r.endedAt);
    expect(open).toBeDefined();
    const stored = (glance: Omit<ConnectionGlance, 'facts'>) =>
      t.services.db
        .update(catalogConnections)
        .set({ glance: { facts: [], ...glance }, glanceAt: now })
        .where(eq(catalogConnections.id, plex));
    // Its check switched off mid-outage: the dot is fine, yet the check found it doesn't answer.
    await stored({ status: 'ok', outcome: 'offline', lines: [] });
    for (const minute of [152, 153, 154]) await passAt(minute);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toBeNull();
    // A line a hold reset counts once more before it colours the dot: still not answering meanwhile.
    await stored({ status: 'ok', outcome: 'offline', lines: [{ ...NOT_ANSWERING, seen: 1 }] });
    for (const minute of [155, 156, 157]) await passAt(minute);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toBeNull();
    expect((await signed('thing.back')).length).toBe(3);
    await glance('ok');
    await passAt(158);
    await passAt(159);
    expect((await rows()).find((r) => r.id === open?.id)?.endedAt).toEqual(at(158));
  });

  it('pushes what is still down after a long hold ten minutes after the hold ended', async () => {
    const of = async () =>
      (
        await t.services.db
          .select()
          .from(incidents)
          .where(eq(incidents.thingId, `connection:${sonarr}`))
      ).find((r) => !r.endedAt);
    await glance('offline', sonarr);
    await passAt(160);
    await passAt(161);
    expect((await of())?.startedAt).toEqual(at(160));
    // Kept quiet for two hours before the push was due.
    await t.services.db.insert(quietWindows).values({
      id: 'qw_sonarr_long',
      ownerId: TEST_BURROW_ID,
      thingId: `connection:${sonarr}`,
      startsAt: at(162),
      endsAt: at(282),
      createdAt: at(162),
    });
    for (const minute of [165, 200, 281]) await passAt(minute);
    expect((await of())?.pushedAt).toBeNull();
    // Still down when it ends: the push waits ten minutes from then, as for a new outage, instead of never.
    await passAt(283);
    expect((await of())?.pushedAt).toBeNull();
    await passAt(293);
    expect((await of())?.pushedAt).toEqual(at(293));
    await glance('ok', sonarr);
    await passAt(294);
    await passAt(295);
    expect(await of()).toBeUndefined();
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

  it('pushes an outage ten minutes after Home can be read again, when it couldn’t be for an hour', async () => {
    const radarr = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: TEST_BURROW_ID,
      label: 'Radarr',
      handle: 'radarr',
      fields: { url: 'http://127.0.0.1:9' },
      secret: 'token-radarr',
    });
    const of = async () =>
      (
        await t.services.db
          .select()
          .from(incidents)
          .where(eq(incidents.thingId, `connection:${radarr}`))
      ).find((r) => !r.endedAt);
    await glance('offline', radarr);
    await passAt(400);
    await passAt(401);
    expect((await of())?.startedAt).toEqual(at(400));
    // Passes that couldn't read Home for over an hour, before its push was due.
    for (const minute of [405, 440, 470]) {
      now = at(minute);
      before = await passMemory(t.services, TEST_BURROW_ID, before, null);
    }
    await passAt(471);
    expect((await of())?.pushedAt).toBeNull();
    await passAt(480);
    expect((await of())?.pushedAt).toEqual(at(480));
  });

  it('pushes it the same way when Home couldn’t be read right after a restart', async () => {
    const lidarr = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: TEST_BURROW_ID,
      label: 'Lidarr',
      handle: 'lidarr',
      fields: { url: 'http://127.0.0.1:9' },
      secret: 'token-lidarr',
    });
    const of = async () =>
      (
        await t.services.db
          .select()
          .from(incidents)
          .where(eq(incidents.thingId, `connection:${lidarr}`))
      ).find((r) => !r.endedAt);
    await glance('offline', lidarr);
    await passAt(500);
    await passAt(501);
    expect((await of())?.startedAt).toEqual(at(500));
    // The server restarts; Home can't be read for over an hour, its open incidents can.
    before = null;
    for (const minute of [505, 540, 570]) {
      now = at(minute);
      before = await passMemory(t.services, TEST_BURROW_ID, before, null);
    }
    expect([...(before?.open?.values() ?? [])]).toContain(`connection:${lidarr}`);
    await passAt(571);
    expect((await of())?.pushedAt).toBeNull();
    await passAt(580);
    expect((await of())?.pushedAt).toEqual(at(580));
  });
});
