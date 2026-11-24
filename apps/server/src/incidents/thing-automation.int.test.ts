/**
 * Postgres keeps the signed incident, automation claim and chat watch across commits and engine restarts.
 * Drive the incident writer directly so the clock can cross a deadline without waiting on health passes.
 */
import { type AutomationDefinitionInput, type AutomationTriggerInput, THING_BACK } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, events, incidents, quietWindows, thingWatches } from '../db/schema/index';
import { serversPrincipal } from '../hosts/principal';
import { loadMessages } from '../read/messages';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { thingWatchTool } from './agent';
import { incidentsPass } from './store';
import { cancelThingWatch, deliverThingWatches } from './thing-watch';

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
) {
  await sign({
    opened: [
      {
        thing,
        kind: 'connection',
        name: 'Plex',
        nature,
        words: 'Not answering',
        check: 'plex.down',
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

async function connection(handle: string) {
  const id = await insertConnection(w.services, {
    catalogId: 'homeassistant',
    burrowId: w.burrowId,
    label: handle === 'plex' ? 'Plex' : 'Media',
    handle,
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'test-token',
  });
  return `connection:${id}`;
}

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
  const delayed = await w.publish(definition([{ ...problem, forMinutes: 10, check: 'plex.down' }]), {
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
