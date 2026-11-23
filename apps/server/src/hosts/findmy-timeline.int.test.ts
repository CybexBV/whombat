/**
 * A Find My timeline end to end (docs/decisions/findmy-timeline.md). Needs Postgres: the rows the Find My signer writes
 * through the commit pipeline without an event, the person's signed commands with their change on the connection's
 * page, the 30 days deleted in batches, the four session routes as the person's device calls them, the map from the
 * Mac and the assistant's `findmy_timeline`. The clock is the test's; nothing sleeps. Made-up names only (Noor, Ruben
 * and Ilse, a Mac called Studio, towns Rietveen and Wilgendam).
 */
import type { FindMyTimeline, FindMyTimelineChanged, HostFindMyPerson } from '@whombat/core';
import { and, asc, eq, like } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { FINDMY_ADAPTER } from '../connections/adapters/findmy';
import type { AdapterContext } from '../connections/adapters/types';
import { connectionRow } from '../connections/store';
import { changes, events, findMyStops, findMyTimelinePeople } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { inProcessApi } from '../test/api';
import { useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { sessionFor } from '../test/tokens';
import { findMyPersonId } from './findmy';
import { findMyPrincipal } from './findmy-places';
import { findMyTimelineFor, setFindMyTimeline } from './findmy-timeline';
import { findMyTimelineMapOf } from './findmy-timeline-view';
import type { HostsService } from './service';
import { FakeFindMyMac } from './testing/fake-findmy';

const w = useAutomationWorld();
const api = inProcessApi(() => w.services);
const NOOR = findMyPersonId('Noor Visser');
const RUBEN = findMyPersonId('Ruben Visser');
const ILSE = findMyPersonId('Ilse Visser');
const MIN = 60_000;
const TZ = 'Europe/Amsterdam';
let connectionId: string;
let cookie: string;
let t0: number;

const at = (minutes: number) => new Date(t0 + minutes * MIN);

const person = (
  name: string,
  place: string | null,
  address: string | null,
  lat = 52.1,
): HostFindMyPerson => ({
  id: findMyPersonId(name),
  name,
  place,
  address,
  when: '5 min ago',
  nearby: false,
  location: place ? { lat, lon: 5.2, accuracyM: 100 } : null,
});

const home = person('Noor Visser', 'Home', 'Kerkstraat 4, Rietveen', 52.1);
const school = person('Noor Visser', 'School', 'Dorpsweg 2, Wilgendam', 52.3);
const town = person('Ruben Visser', 'Wilgendam', null, 52.4);
const ilse = person('Ilse Visser', 'Rietveen', null, 52.0);

async function as(method: string, path: string, body?: unknown) {
  const res = await api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq/connections/${connectionId}${path}`,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
  return { status: res.statusCode, body: res.json() };
}

const stops = () =>
  w.services.db
    .select()
    .from(findMyStops)
    .where(eq(findMyStops.connectionId, connectionId))
    .orderBy(asc(findMyStops.person), asc(findMyStops.firstAt));

const timelineEvents = () =>
  w.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, w.burrowId), like(events.type, 'findmy.timeline%')))
    .orderBy(asc(events.seq));

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(w.now());

beforeAll(async () => {
  connectionId = await insertConnection(w.services, {
    catalogId: 'findmy',
    burrowId: w.burrowId,
    signIn: 'none',
    fields: { mac: 'studio', background: 'off' },
  });
  cookie = (await sessionFor(w.services, IDS.mara)).cookie;
  t0 = w.now().getTime();
});

describe('a Find My timeline', () => {
  it('keeps nothing until the person ticks someone', async () => {
    await findMyTimelineFor(w.services).noted('studio', [home, town], at(0));
    expect(await stops()).toEqual([]);
  });

  it('is turned on by the person, signed with names only and shown on the connection’s page', async () => {
    const { eventId } = await w.ok(IDS.mara, setFindMyTimeline, {
      connectionId,
      people: [
        { person: NOOR, name: 'Noor Visser' },
        { person: RUBEN, name: 'Ruben Visser' },
      ],
    });
    expect(eventId).toBeTruthy();
    const [event] = await timelineEvents();
    expect(event?.text).toBe('Kept a Find My timeline for Noor Visser and Ruben Visser');
    expect(event?.actorId).toBe(IDS.mara);
    const [change] = await w.services.db
      .select()
      .from(changes)
      .where(and(eq(changes.subjectKind, 'connection'), eq(changes.subjectId, connectionId)));
    expect(change?.kind).toBe('findmy.timeline_set');
    // The same choice again changes nothing and signs nothing.
    const again = await w.ok(IDS.mara, setFindMyTimeline, {
      connectionId,
      people: [
        { person: RUBEN, name: 'Ruben Visser' },
        { person: NOOR, name: 'Noor Visser' },
      ],
    });
    expect(again.eventId).toBeNull();
  });

  it('extends a stop while the reads say the same, starts one when they don’t, and signs no event', async () => {
    const writer = findMyTimelineFor(w.services);
    w.setNow(at(0));
    await writer.noted('studio', [home, town, ilse], at(0));
    await writer.noted('studio', [home, town, ilse], at(15));
    // Ruben isn't on this read: no location.
    await writer.noted('studio', [school], at(30));
    await writer.failed('studio', connectionId, 'in_use', at(45));
    await writer.noted('studio', [school, town], at(60));
    const rows = (await stops()).map((r) => ({
      person: r.person,
      kind: r.kind,
      place: r.place,
      code: r.code,
      first: (r.firstAt.getTime() - t0) / MIN,
      last: (r.lastAt.getTime() - t0) / MIN,
    }));
    const noor = rows.filter((r) => r.person === NOOR);
    const ruben = rows.filter((r) => r.person === RUBEN);
    expect(noor.map((r) => [r.kind, r.place ?? r.code, r.first, r.last])).toEqual([
      ['place', 'Home', 0, 15],
      ['place', 'School', 30, 30],
      ['unread', 'in_use', 45, 45],
      ['place', 'School', 60, 60],
    ]);
    expect(ruben.map((r) => [r.kind, r.first, r.last])).toEqual([
      ['place', 0, 15],
      ['none', 30, 30],
      ['unread', 45, 45],
      ['place', 60, 60],
    ]);
    // Ilse isn't kept; the event log never holds a place.
    expect(rows.some((r) => r.person === ILSE)).toBe(false);
    const signer = await findMyPrincipal.find(w.services.db, w.burrowId);
    const signed = await w.services.db
      .select()
      .from(events)
      .where(eq(events.actorId, signer ?? ''));
    expect(signed.map((e) => e.type)).toEqual(['findmy.system_principal']);
    expect(JSON.stringify(await w.services.db.select().from(events))).not.toMatch(/Kerkstraat|Dorpsweg/);
  });

  it('answers the day in the viewer’s time zone, with everyone, the pace and the assistant’s switch', async () => {
    w.setNow(at(65));
    const res = await as('GET', `/find-my/timeline?date=${today()}&tz=${encodeURIComponent(TZ)}`);
    expect(res.status).toBe(200);
    const timeline = res.body as FindMyTimeline;
    expect(timeline.paceMinutes).toBe(15);
    expect(timeline.assistantReads).toBe(true);
    expect(timeline.people.map((p) => [p.name, p.kept])).toEqual([
      ['Noor Visser', true],
      ['Ruben Visser', true],
    ]);
    const [day] = timeline.days;
    const noor = day?.people.find((p) => p.person === NOOR)?.segments ?? [];
    expect(noor.map((s) => (s.kind === 'stay' ? s.place : s.kind))).toEqual(['Home', 'trip', 'School']);
    const last = noor.at(-1);
    expect(last).toMatchObject({ kind: 'stay', ongoing: true });
    expect(last?.kind === 'stay' && last.holes.map((h) => h.why)).toEqual(['in_use']);
    const ruben = day?.people.find((p) => p.person === RUBEN)?.segments ?? [];
    expect(ruben).toHaveLength(1);
    expect(ruben[0]?.kind === 'stay' && ruben[0].holes.map((h) => h.why)).toEqual(['no_location', 'in_use']);

    // A week answers seven days, oldest first.
    const week = (await as('GET', `/find-my/timeline?date=${today()}&tz=${encodeURIComponent(TZ)}&days=7`))
      .body as FindMyTimeline;
    expect(week.days).toHaveLength(7);
    expect(week.days.at(-1)?.date).toBe(today());

    // The assistant's switch is the tool's tier.
    const off = await api.inject({
      method: 'PATCH',
      url: `/api/v1/burrows/burrow-hq/connections/${connectionId}/tools/findmy_timeline`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { tier: 'off' },
    });
    expect(off.statusCode).toBe(200);
    const after = (await as('GET', `/find-my/timeline?date=${today()}&tz=${encodeURIComponent(TZ)}`))
      .body as FindMyTimeline;
    expect(after.assistantReads).toBe(false);
  });

  it('draws a day’s map on the Mac, numbered stops at their pins, and says when a day has no spot', async () => {
    const mac = new FakeFindMyMac();
    const hosts = { call: mac.call.bind(mac) } as unknown as HostsService;
    const row = await connectionRow(w.services.db, connectionId);
    if (!row) throw new Error('no connection');
    const actor = { id: IDS.mara, name: 'Mara', role: 'admin' as const };
    const map = await findMyTimelineMapOf(
      w.services,
      hosts,
      row,
      { person: NOOR, date: today(), tz: TZ, w: 320, h: 200, dark: true },
      actor,
    );
    expect(map).toMatchObject({ person: NOOR, w: 640, h: 400, imageB64: 'bWFw' });
    // Home is stop 1, School stop 2 (the fake leaves the last pin outside the picture).
    expect(map.points).toEqual([{ stops: [1], x: 10, y: 20 }]);
    const snapshot = mac.steps.find((s) => s.op === 'map.snapshot');
    expect(snapshot?.pins).toHaveLength(2);
    await expect(
      findMyTimelineMapOf(
        w.services,
        hosts,
        row,
        { person: NOOR, date: '2026-01-01', tz: TZ, w: 320, h: 200 },
        actor,
      ),
    ).rejects.toMatchObject({ extra: { details: { code: 'find_my_no_places' } } });
  });

  it('is read by the assistant in the person’s own turns only, in words', async () => {
    const tool = FINDMY_ADAPTER.findmy_timeline;
    if (!tool) throw new Error('no tool');
    const ctx = (personId: string | null): AdapterContext => ({
      baseUrl: 'whombat-hosts:',
      fields: { mac: 'studio' },
      bases: {},
      send: async () => {
        throw new Error('Find My sends nothing to its base');
      },
      call: {
        services: w.services,
        burrowId: w.burrowId,
        agentId: IDS.dusty,
        connectionId,
        callId: 'call_timeline',
        conversationId: null,
        personId,
      },
    });
    const out = await tool(ctx(IDS.mara), { person: 'Noor' });
    expect(out.isError).toBe(false);
    const answer = JSON.parse(out.content) as { people: { name: string; day: string[] }[] };
    expect(answer.people.map((p) => p.name)).toEqual(['Noor Visser']);
    const day = answer.people[0]?.day.join('\n') ?? '';
    expect(day).toContain('Home (Kerkstraat 4, Rietveen)');
    expect(day).toContain('on the way');
    expect(day).toContain('still there');
    expect(day).not.toMatch(/52\.|5\.2/);
    // Someone not kept, a day past the 30 and an outsiders' turn.
    expect(JSON.parse((await tool(ctx(IDS.mara), { person: 'Ilse' })).content)).toEqual({
      date: today(),
      notFound: expect.stringContaining('Nobody called Ilse'),
    });
    expect((await tool(ctx(IDS.mara), { date: '2026-01-01' })).content).toContain('Whombat keeps 30 days.');
    expect((await tool(ctx(null), {})).isError).toBe(true);
  });

  it('deletes every day kept on request, keeping whose', async () => {
    const res = await as('POST', '/find-my/timeline/delete', {});
    expect(res.status).toBe(200);
    expect((res.body as FindMyTimelineChanged).eventId).toBeTruthy();
    expect(await stops()).toEqual([]);
    expect((res.body as FindMyTimelineChanged).people.filter((p) => p.kept)).toHaveLength(2);
    expect((await timelineEvents()).at(-1)?.text).toBe('Deleted the Find My timeline');
  });

  it('changes whose days through the route, deleting those unticked, and refuses someone it never read', async () => {
    const writer = findMyTimelineFor(w.services);
    w.setNow(at(120));
    await writer.noted('studio', [home, town], at(120));
    const unknown = await as('PUT', '/find-my/timeline', { people: [ILSE] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.details.code).toBe('find_my_person');
    const res = await as('PUT', '/find-my/timeline', { people: [NOOR] });
    expect(res.status).toBe(200);
    expect((await stops()).map((r) => r.person)).toEqual([NOOR]);
    expect((await timelineEvents()).at(-1)?.text).toBe('Kept a Find My timeline for Noor Visser');
    // No one: it stops and everything goes.
    const stop = await as('PUT', '/find-my/timeline', { people: [] });
    expect((stop.body as FindMyTimelineChanged).people).toEqual([]);
    expect(await stops()).toEqual([]);
    expect(
      await w.services.db
        .select()
        .from(findMyTimelinePeople)
        .where(eq(findMyTimelinePeople.connectionId, connectionId)),
    ).toEqual([]);
  });

  it('deletes rows whose last read is over 30 days old, and keeps the rest', async () => {
    await w.ok(IDS.mara, setFindMyTimeline, {
      connectionId,
      people: [{ person: NOOR, name: 'Noor Visser' }],
    });
    const writer = findMyTimelineFor(w.services);
    const old = 31 * 24 * 60;
    await writer.noted('studio', [home], at(200 - old));
    await writer.noted('studio', [school], at(200));
    w.setNow(at(205));
    expect(await writer.expire(w.now())).toBe(1);
    expect((await stops()).map((r) => r.place)).toEqual(['School']);
  });

  it('answers only for a Find My connection', async () => {
    const other = await insertConnection(w.services, {
      catalogId: 'todoist',
      burrowId: w.burrowId,
      secret: 'made-up-token',
    });
    const res = await api.inject({
      url: `/api/v1/burrows/burrow-hq/connections/${other}/find-my/timeline?date=${today()}&tz=UTC`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
