/**
 * Postgres keeps the signed incident, automation claim and chat watch across commits and engine restarts.
 * Drive the incident writer directly so the clock can cross a deadline without waiting on health passes; a
 * connection's stored glance says which of its lines count when a delayed start reaches its deadline.
 */
import type { UpdateFacts } from '@whombat/control-contracts/local';
import {
  type AutomationDefinitionInput,
  type AutomationTriggerInput,
  THING_BACK,
  THING_DOWN,
  THING_PROBLEM,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { NewerAutomationsGate, THING_AUTOMATIONS_LATER } from '../automations/release-gate';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  dispatches,
  events,
  incidents,
  incidentTriggers,
  quietWindows,
  thingCauses,
  thingWatches,
} from '../db/schema/index';
import { serversPrincipal } from '../hosts/principal';
import { callTool } from '../mcp/server';
import { loadMessages } from '../read/messages';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import type { GlanceLine } from '../things/quiet/glance';
import { thingWatchTool } from './agent';
import { periodUptime } from './history';
import { incidentsPass } from './store';
import { cancelThingWatch, deliverThingWatches } from './thing-watch';
import { watchIncidents } from './watch';

const w = useAutomationWorld();
const MINUTE = 60_000;

function definition(triggers: AutomationTriggerInput[], text = '{{trigger.name}} · {{trigger.words}}') {
  return {
    version: 1,
    conversationId: IDS.incidents,
    triggers,
    steps: [{ id: 'note', kind: 'post_message', text }],
  } satisfies AutomationDefinitionInput;
}

async function sign(input: Parameters<typeof incidentsPass.apply>[2]) {
  const signer = await serversPrincipal(w.services, w.burrowId);
  return w.ok(signer, incidentsPass, input);
}

async function open(
  thing: string,
  nature: 'down' | 'problem',
  cause: { thing: string; name: string } | null = null,
  check = 'conn.answers',
) {
  await sign({
    opened: [
      {
        thing,
        kind: 'connection',
        name: 'Plex',
        nature,
        words: 'Not answering',
        check,
        subject: '',
        cause,
        startedAt: w.now().toISOString(),
      },
    ],
    changed: [],
    ended: [],
  });
  const [row] = await w.services.db
    .select()
    .from(incidents)
    .where(and(eq(incidents.thingId, thing), eq(incidents.startedAt, w.now())));
  if (!row) throw new Error('Missing incident');
  return row.id;
}

function close(id: string) {
  return sign({ opened: [], changed: [], ended: [{ id, endedAt: w.now().toISOString() }] });
}

async function connection(handle: string, label = handle === 'plex' ? 'Plex' : 'Media') {
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

/** A line as the health pass keeps it in the glance. */
const line = (check: string, title: string, more: Partial<GlanceLine> = {}): GlanceLine => ({
  check,
  tone: 'bad',
  nature: 'problem',
  title,
  seen: 2,
  ...more,
});

/** What the last health pass stored for a connection: its lines that count (none: it answers and is fine). */
async function lines(thing: string, list: GlanceLine[]) {
  const offline = list.some((l) => l.offline);
  await w.services.db
    .update(catalogConnections)
    .set({
      glance: { status: offline ? 'offline' : list.length ? 'bad' : 'ok', facts: [], lines: list },
      glanceAt: w.now(),
    })
    .where(eq(catalogConnections.id, thing.slice('connection:'.length)));
}

const NOT_ANSWERING = line('conn.answers', 'Whombat can’t reach it', { confirm: 2, offline: true });

async function watch(thing: string, event: 'down' | 'back', minutes?: number) {
  const { id: messageId } = await w.ok(IDS.mara, sendMessage, {
    conversationId: IDS.dmDusty,
    text: `Tell me when it goes ${event}.`,
  });
  const dispatchId = await w.turn(IDS.dusty, IDS.dmDusty, { messageId });
  const [dispatch] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!dispatch) throw new Error('Missing dispatch');
  const result = await thingWatchTool(
    {
      services: w.services,
      agentId: IDS.dusty,
      burrowId: w.burrowId,
      dispatch,
      onBehalfOf: {},
    },
    { action: 'start', thing, event, minutes },
  );
  if (result.status !== 'ok' || !result.watches[0]) throw new Error('Missing watch');
  return { watch: result.watches[0], messageId };
}

async function replies(rootId: string) {
  const rows = (await w.messagesBy(IDS.dusty)).filter((message) => message.threadRootId === rootId);
  return loadMessages(w.services.db, rows, IDS.mara);
}

it('runs once for an incident, remembers a delay after restart, and replies to a watch in its thread', async () => {
  const thing = await connection('plex');
  const problem = { kind: 'thing', event: 'problem', thing } as const;
  const down = { kind: 'thing', event: 'down', thing } as const;
  const immediate = await w.publish(definition([problem, down]), { name: 'Plex has trouble' });
  const delayed = await w.publish(definition([{ ...problem, forMinutes: 10, check: 'conn.answers' }]), {
    name: 'Plex stays down',
  });
  const recovery = await w.publish(
    definition(
      [{ kind: 'thing', event: 'back', kinds: ['connection:homeassistant'] }],
      '{{trigger.name}} was down for {{trigger.downFor}}',
    ),
    { name: 'Plex is back' },
  );
  const starts = await watch(thing, 'down');
  expect((await replies(starts.messageId))[0]?.card).toMatchObject({
    kind: 'thing_watch',
    watch: { status: 'watching' },
  });

  const incidentId = await open(thing, 'problem');
  await w.settle();
  expect(await w.runs(immediate)).toHaveLength(1);
  expect(await w.runs(delayed)).toHaveLength(0);
  w.advance(MINUTE);
  await sign({
    opened: [],
    changed: [{ id: incidentId, nature: 'down', words: 'Not answering', cause: null, worse: true }],
    ended: [],
  });
  await w.settle();
  expect(await w.runs(immediate)).toHaveLength(1);
  expect((await replies(starts.messageId)).filter((message) => !message.card)).toHaveLength(1);
  const comesBack = await watch(thing, 'back');
  expect(comesBack.watch.status).toBe('watching');
  expect((await watch(thing, 'down')).watch.status).toBe('happened');

  await w.restart();
  // Still not answering when the wait is over: the line it waited on counts.
  await lines(thing, [NOT_ANSWERING]);
  w.advance(8 * MINUTE);
  await w.settle();
  expect(await w.runs(delayed)).toHaveLength(0);
  w.advance(MINUTE);
  await w.settle();
  expect(await w.runs(delayed)).toHaveLength(1);
  w.advance(15 * MINUTE);
  await close(incidentId);
  await w.settle();
  const [run] = await w.runs(recovery);
  expect(run?.trigger).toMatchObject({ kind: 'thing', summary: 'Plex is back' });
  const [event] = await w.services.db
    .select()
    .from(events)
    .where(and(eq(events.type, THING_BACK), eq(events.id, run?.trigger.eventId ?? '')));
  expect(event?.payload).toMatchObject({ incidentId, thing });
  if (!run) throw new Error('Missing run');
  expect((await w.runThread(run.id)).map((m) => m.text).join(' ')).toContain('25 minutes');

  await deliverThingWatches(w.services, w.burrowId);
  const thread = await replies(comesBack.messageId);
  expect(thread).toHaveLength(2);
  expect(thread.find((m) => m.card)?.card).toMatchObject({
    kind: 'thing_watch',
    watch: { status: 'happened' },
  });
  expect(thread.find((m) => !m.card)?.text).toContain('25 minutes');
});

it('skips dependent, quiet and ended incidents, and settles expired or cancelled watches once', async () => {
  const thing = await connection('media');
  const id = await w.publish(definition([{ kind: 'thing', event: 'down', thing, forMinutes: 2 }]), {
    name: 'Media is down',
  });

  const expired = await watch(thing, 'down', 4);
  const dependent = await open(thing, 'down', { thing: 'server:nas', name: 'NAS' });
  await w.settle();
  w.advance(3 * MINUTE);
  await close(dependent);
  await w.services.pipeline.transact(w.burrowId, async ({ tx }) => {
    await tx.insert(quietWindows).values({
      id: 'quiet_test',
      ownerId: w.burrowId,
      thingId: thing,
      startsAt: w.now(),
      endsAt: new Date(w.now().getTime() + MINUTE),
      createdAt: w.now(),
    });
  });
  const quiet = await open(thing, 'down');
  await w.settle();
  w.advance(MINUTE);
  await close(quiet);

  const endsEarly = await open(thing, 'down');
  const cancelled = await watch(thing, 'back', 5);
  await w.ok(IDS.mara, cancelThingWatch, { watchId: cancelled.watch.id });
  await w.settle();
  w.advance(MINUTE);
  await close(endsEarly);
  w.advance(4 * MINUTE);
  await w.settle();
  await deliverThingWatches(w.services, w.burrowId);
  await deliverThingWatches(w.services, w.burrowId);
  expect(await w.runs(id)).toHaveLength(0);
  const [row] = await w.services.db
    .select()
    .from(thingWatches)
    .where(eq(thingWatches.id, cancelled.watch.id));
  expect(row?.status).toBe('cancelled');
  expect(await replies(cancelled.messageId)).toHaveLength(1);
  const thread = await replies(expired.messageId);
  expect(thread).toHaveLength(2);
  expect(thread.find((m) => m.card)?.card).toMatchObject({ watch: { status: 'expired' } });
});

it('waits the full down delay when a thing with an existing problem stops answering', async () => {
  const thing = await connection('media-down');
  const automation = await w.publish(definition([{ kind: 'thing', event: 'down', thing, forMinutes: 10 }]), {
    name: 'Media is down',
  });
  const problemSince = w.now();
  const incidentId = await open(thing, 'problem', null, 'machine.disk');
  await w.settle();
  w.advance(50 * MINUTE);
  const downSince = w.now();
  await lines(thing, [NOT_ANSWERING]);
  await watchIncidents(w.services, w.burrowId, null);
  await w.settle();
  expect(await w.runs(automation)).toHaveLength(0);
  const [row] = await w.services.db.select().from(incidents).where(eq(incidents.id, incidentId));
  expect(row).toMatchObject({ startedAt: problemSince, downSince });
  const downEvents = await w.services.db
    .select()
    .from(events)
    .where(and(eq(events.type, THING_DOWN), eq(events.burrowId, w.burrowId)));
  expect(downEvents.find((event) => event.payload.incidentId === incidentId)?.payload).toMatchObject({
    incidentId,
    startedAt: downSince.toISOString(),
  });

  w.advance(9 * MINUTE);
  await w.settle();
  expect(await w.runs(automation)).toHaveLength(0);
  w.advance(MINUTE);
  await w.settle();
  expect(await w.runs(automation)).toHaveLength(1);
  await close(incidentId);

  const history = await periodUptime(w.services, w.burrowId, thing, {
    now: w.now(),
    days: 30,
    timeZone: 'UTC',
  });
  expect(history?.uptime).toMatchObject({ downs: 1, downMinutes: 10 });
});

it('doesn’t start a delayed automation whose check cleared while another line keeps the incident open', async () => {
  const thing = await connection('ups', 'UPS');
  const named = await w.publish(
    definition([{ kind: 'thing', event: 'problem', thing, forMinutes: 10, check: 'conn.check' }]),
    { name: 'Shut down after ten minutes on battery' },
  );
  const unnamed = await w.publish(definition([{ kind: 'thing', event: 'problem', thing, forMinutes: 10 }]), {
    name: 'Any problem for ten minutes',
  });
  const disk = line('machine.disk', 'The disk is almost full');
  await lines(thing, [line('conn.check', 'On battery'), disk]);
  const incidentId = await open(thing, 'problem', null, 'conn.check');
  await w.settle();
  // Power is back at minute 6; the disk line keeps the incident open.
  w.advance(6 * MINUTE);
  await lines(thing, [disk]);
  w.advance(5 * MINUTE);
  await w.settle();
  expect(await w.runs(named)).toHaveLength(0);
  expect(await w.runs(unnamed)).toHaveLength(0);
  const [row] = await w.services.db.select().from(incidents).where(eq(incidents.id, incidentId));
  expect(row?.endedAt).toBeNull();
});

it('tells when a thing down because of its server answers again', async () => {
  const thing = await connection('sonarr', 'Sonarr');
  await lines(thing, [NOT_ANSWERING]);
  await w.services.pipeline.transact(w.burrowId, async ({ tx }) => {
    await tx.insert(thingCauses).values({
      ownerId: w.burrowId,
      thingId: thing,
      causeThing: 'server:pve-02',
      causeName: 'pve-02',
      words: 'while pve-02 is down',
      since: w.now(),
      checkedAt: w.now(),
    });
  });
  const back = await watch(thing, 'back');
  expect(back.watch.status).toBe('watching');
  const [card] = await replies(back.messageId);
  expect(card?.text).toContain('pve-02');
  expect(card?.text).toContain('answers again');
  // Still down with its server: nothing yet.
  let before = await watchIncidents(w.services, w.burrowId, null);
  const status = async () =>
    (await w.services.db.select().from(thingWatches).where(eq(thingWatches.id, back.watch.id)))[0]?.status;
  expect(await status()).toBe('watching');
  // pve-02 is back and so is Sonarr: no outage of its own, yet it answers again.
  w.advance(MINUTE);
  await w.services.db.delete(thingCauses).where(eq(thingCauses.thingId, thing));
  await lines(thing, []);
  before = await watchIncidents(w.services, w.burrowId, before);
  expect(before).not.toBeNull();
  expect(await status()).toBe('happened');
  const thread = await replies(back.messageId);
  expect(thread).toHaveLength(2);
  expect(thread.find((m) => !m.card)?.text).toContain('Sonarr is back');
});

it('doesn’t start a delayed “goes down” automation once the thing answers again, with an error', async () => {
  const thing = await connection('jellyfin', 'Jellyfin');
  const id = await w.publish(definition([{ kind: 'thing', event: 'down', thing, forMinutes: 5 }]), {
    name: 'Jellyfin stays down',
  });
  await lines(thing, [NOT_ANSWERING]);
  const incidentId = await open(thing, 'down');
  await w.settle();
  // It answers again, with an error: the same check counts, as a bad line, but it isn't down.
  w.advance(3 * MINUTE);
  await lines(thing, [line('conn.answers', 'It answered with an error')]);
  w.advance(3 * MINUTE);
  await w.settle();
  expect(await w.runs(id)).toHaveLength(0);
  await close(incidentId);
  // Still not answering at the deadline: it runs.
  const again = await open(thing, 'down');
  await lines(thing, [NOT_ANSWERING]);
  await w.settle();
  w.advance(6 * MINUTE);
  await w.settle();
  expect(await w.runs(id)).toHaveLength(1);
  await close(again);
});

it('starts an automation naming a check that begins counting on an incident already open, once', async () => {
  const thing = await connection('nas', 'NAS');
  const id = await w.publish(
    definition([{ kind: 'thing', event: 'problem', thing, forMinutes: 10, check: 'conn.check' }]),
    { name: 'Shut down after ten minutes on battery' },
  );
  const disk = line('machine.disk', 'The disk is almost full');
  await lines(thing, [disk]);
  const incidentId = await open(thing, 'problem', null, 'machine.disk');
  await w.settle();
  // Twenty minutes into the disk problem, the battery runs low.
  w.advance(20 * MINUTE);
  await lines(thing, [disk, line('conn.check', 'The battery is low')]);
  let before = await watchIncidents(w.services, w.burrowId, null);
  before = await watchIncidents(w.services, w.burrowId, before);
  const noted = (await w.services.db.select().from(events).where(eq(events.type, THING_PROBLEM))).filter(
    (e) => (e.payload as { incidentId?: string }).incidentId === incidentId,
  );
  // Once each, also after a second pass.
  expect(noted.map((e) => (e.payload as { check?: string }).check).sort()).toEqual([
    'conn.check',
    'machine.disk',
  ]);
  // Its ten minutes count from when the battery line came, not from the disk's.
  await w.settle();
  expect(await w.runs(id)).toHaveLength(0);
  w.advance(9 * MINUTE);
  await w.settle();
  expect(await w.runs(id)).toHaveLength(0);
  w.advance(2 * MINUTE);
  await w.settle();
  expect(await w.runs(id)).toHaveLength(1);
  await close(incidentId);
});

it('ends the incident of a thing that was removed without saying it is back', async () => {
  const thing = await connection('radarr', 'Radarr');
  const back = await w.publish(definition([{ kind: 'thing', event: 'back', thing }]), {
    name: 'Radarr back',
  });
  await lines(thing, [NOT_ANSWERING]);
  const incidentId = await open(thing, 'down');
  const waiting = await watch(thing, 'back');
  expect(waiting.watch.status).toBe('watching');
  await w.settle();
  // Disconnected while it is down.
  await w.services.db
    .delete(catalogConnections)
    .where(eq(catalogConnections.id, thing.slice('connection:'.length)));
  await watchIncidents(w.services, w.burrowId, null);
  const [row] = await w.services.db.select().from(incidents).where(eq(incidents.id, incidentId));
  expect(row?.endedAt).not.toBeNull();
  const backs = (await w.services.db.select().from(events).where(eq(events.type, THING_BACK))).filter(
    (e) => (e.payload as { thing?: string }).thing === thing,
  );
  expect(backs).toEqual([]);
  await w.settle();
  expect(await w.runs(back)).toHaveLength(0);
  const [settled] = await w.services.db
    .select()
    .from(thingWatches)
    .where(eq(thingWatches.id, waiting.watch.id));
  expect(settled?.status).toBe('cancelled');
  const said = (await replies(waiting.messageId)).filter((m) => !m.card);
  expect(said).toHaveLength(1);
  expect(said[0]?.text).toContain('Radarr');
  expect(said[0]?.text).toContain('removed');
});

it('neither claims an incident nor runs a thing automation while the release to go back to can’t run them', async () => {
  const thing = await connection('lidarr', 'Lidarr');
  const id = await w.publish(
    {
      version: 1,
      conversationId: IDS.incidents,
      triggers: [{ kind: 'thing', event: 'down', thing }],
      steps: [
        { id: 'pause', kind: 'wait', minutes: 1 },
        { id: 'note', kind: 'post_message', text: '{{trigger.name}} is down' },
      ],
    },
    { name: 'Lidarr is down' },
  );
  const first = await open(thing, 'down');
  await w.settle();
  const [run] = await w.runs(id);
  expect(run?.status).toBe('waiting');
  // The box was updated from a release that runs mail and Find My automations but not these.
  const opened = w.services.newerAutomations;
  const update: UpdateFacts = {
    state: 'Healthy',
    current: 'rel-now',
    candidate: null,
    lastCheckedAt: null,
    deferredReason: null,
    failure: null,
    lastUpdate: { release: 'rel-now', from: 'rel-before', at: w.now().toISOString() },
  };
  const gate = new NewerAutomationsGate(
    { NODE_ENV: 'production', WHOMBAT_RELEASE_ID: 'rel-now' },
    async () => true,
    async () => '0026_quiet_windows',
  );
  gate.follow(() => update);
  w.services.newerAutomations = gate;
  try {
    expect([await gate.ready(), await gate.findMyReady(), await gate.thingsReady()]).toEqual([
      true,
      true,
      false,
    ]);
    // The assistant's guide says they wait, before it drafts one.
    const auth: AgentAuth = {
      dispatchId: await w.turn(IDS.dusty, IDS.dmDusty),
      agentId: IDS.dusty,
      burrowId: w.burrowId,
    };
    const read = (await callTool(w.services, auth, 'automation_read', {})).structuredContent as {
      guide: string;
    };
    expect(read.guide).toContain(THING_AUTOMATIONS_LATER);
    // The run already started waits as it is.
    w.advance(2 * MINUTE);
    await w.settle();
    expect((await w.run(run?.id as string)).status).toBe('waiting');
    // Something new going down claims nothing and starts nothing.
    await close(first);
    const second = await open(thing, 'down');
    await w.settle();
    expect(await w.runs(id)).toHaveLength(1);
    const claims = await w.services.db
      .select()
      .from(incidentTriggers)
      .where(eq(incidentTriggers.incidentId, second));
    expect(claims).toEqual([]);
    await close(second);
  } finally {
    w.services.newerAutomations = opened;
  }
  await w.settle();
  expect((await w.run(run?.id as string)).status).toBe('succeeded');
});
