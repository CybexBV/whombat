/**
 * Incidents end to end on a real database (monitoring.md MON-06, MON-09, MON-10): a connection that stops answering
 * opens an incident on the watcher's second pass and signs `thing.down`; ten minutes on it is pushed once, as the
 * person's “Needs you” row; when it answers again for two passes it ends, signs `thing.back` and its push is withdrawn
 * (the row read). Its page says its week, `things.history` lists it, and the assistant reads it with `watch_status` and
 * `watch_history`. Postgres because each step is a signed commit, an inbox row and a read across them.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections, events, incidents, notifications } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { agentTokenFor } from '../test/tokens';
import { thingPage } from '../things/page';
import { thingHistory } from './history';
import type { PassBefore } from './plan';
import { pushKey } from './store';
import { watchIncidents } from './watch';

const t = useTestServer({ seed: true, listen: true });
const MIN = 60_000;
const T0 = new Date('2026-11-24T13:00:00Z');
let now = T0;
let real: () => Date;
let before: PassBefore | null = null;
let mine: PersonalSetup;
let plex = '';

/** One watcher pass at `minutes` past T0, remembering what it saw. */
async function passAt(minutes: number) {
  now = new Date(T0.getTime() + minutes * MIN);
  before = await watchIncidents(t.services, TEST_BURROW_ID, before);
  await t.services.background.settle();
}

function glance(status: 'offline' | 'ok') {
  return t.services.db
    .update(catalogConnections)
    .set({
      glance: status === 'ok' ? { status, facts: [] } : { status, reason: 'Not answering', facts: [] },
      glanceAt: now,
    })
    .where(eq(catalogConnections.id, plex));
}

const thing = () => `connection:${plex}`;

async function rows() {
  return t.services.db.select().from(incidents).where(eq(incidents.thingId, thing()));
}

async function signed(type: string) {
  return t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, TEST_BURROW_ID), eq(events.type, type)));
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
  await glance('offline');
});

afterAll(() => {
  t.services.clock = real;
});

describe('an outage, its push and its history', () => {
  it('opens an incident on the second pass in a row and signs thing.down', async () => {
    await passAt(0);
    expect(await rows()).toEqual([]);
    await passAt(1);
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
    await passAt(21);
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
});
