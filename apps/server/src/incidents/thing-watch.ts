import {
  ConversationId,
  EventId,
  MessageId,
  newId,
  THING_BACK,
  THING_DOWN,
  ThingIncidentEvent,
  ThingIncidentTarget,
  ThingWatchEvent,
  ThingWatchId,
  ThingWatchMinutes,
  thingWatchExpiredText,
  thingWatchMatches,
  thingWatchResultText,
  thingWatchStartText,
  topics,
} from '@whombat/core';
import { and, desc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { events, incidents, thingWatches } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import type { Services } from '../services';
import { holdsIncident } from './holds';
import { type ThingWatchRow, thingWatchView } from './thing-watch-cards';

const ACTIVE_WATCH_LIMIT = 10;

export async function runningThingWatches(db: Db, burrowId: string, agentId?: string) {
  return db
    .select()
    .from(thingWatches)
    .where(
      and(
        eq(thingWatches.burrowId, burrowId),
        eq(thingWatches.status, 'watching'),
        agentId ? eq(thingWatches.agentId, agentId) : undefined,
      ),
    )
    .orderBy(desc(thingWatches.startedAt));
}

/** Claim a matching watch in the same transaction as the signed event. A later sweep can still deliver its reply. */
export async function claimThingWatches(
  ctx: ApplyContext,
  type: string,
  incident: ThingIncidentEvent,
  eventId: string,
): Promise<boolean> {
  if (type !== THING_DOWN && type !== THING_BACK) return false;
  const event = type === THING_DOWN ? 'down' : 'back';
  if (!thingWatchMatches({ event, thing: incident.thing }, type, incident)) return false;
  const happenedAt = incident.endedAt ? new Date(incident.endedAt) : ctx.now;
  const where = and(
    eq(thingWatches.burrowId, ctx.burrow.id),
    eq(thingWatches.thing, incident.thing),
    eq(thingWatches.event, event),
    eq(thingWatches.status, 'watching'),
    isNull(thingWatches.eventId),
    gt(thingWatches.endsAt, ctx.now),
  );
  const found = await ctx.tx.select({ id: thingWatches.id }).from(thingWatches).where(where).limit(1);
  if (!found.length || (await holdsIncident(ctx.tx, ctx.burrow.id, incident.thing, ctx.now, happenedAt)))
    return false;
  await ctx.tx.update(thingWatches).set({ eventId }).where(where);
  return true;
}

async function settleWatch(
  ctx: ApplyContext,
  row: ThingWatchRow,
  status: 'happened' | 'expired' | 'cancelled',
) {
  const [settled] = await ctx.tx
    .update(thingWatches)
    .set({ status, endedAt: ctx.now })
    .where(eq(thingWatches.id, row.id))
    .returning();
  if (!settled) throw notFound('Watch');
  const message = row.messageId ? await loadMessageRow(ctx.tx, row.messageId) : undefined;
  if (message) {
    const [loaded] = await loadMessages(ctx.tx, [message], null);
    if (loaded)
      ctx.publish(
        topics.conversation(row.conversationId),
        { type: 'message.updated', message: loaded },
        { eventId: null },
      );
  }
  return thingWatchView(settled);
}

async function watchIn(ctx: ApplyContext, id: string): Promise<ThingWatchRow> {
  const [row] = await ctx.tx
    .select()
    .from(thingWatches)
    .where(and(eq(thingWatches.id, id), eq(thingWatches.burrowId, ctx.burrow.id)));
  if (!row) throw notFound('Watch');
  return row;
}

export const startThingWatch = defineCommand({
  name: 'thing.watch_started',
  schema: z.object({
    thing: ThingIncidentTarget,
    name: z.string().min(1).max(120),
    event: ThingWatchEvent,
    minutes: ThingWatchMinutes,
    conversationId: ConversationId,
    threadRootId: MessageId.nullable(),
    observed: z.enum(['up', 'down', 'unknown']),
    observedAt: z.iso.datetime({ offset: true }),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant starts a watch.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');

    // A health pass may have committed after the tool read the thing. Its incident takes precedence.
    const [latest] = await tx
      .select()
      .from(incidents)
      .where(and(eq(incidents.burrowId, ctx.burrow.id), eq(incidents.thingId, input.thing)))
      .orderBy(desc(incidents.startedAt))
      .limit(1);
    const open = latest && !latest.endedAt ? latest : null;
    const justEnded = latest?.endedAt && latest.endedAt.getTime() >= Date.parse(input.observedAt);
    const current = open ? (open.nature === 'down' ? 'down' : 'unknown') : justEnded ? 'up' : input.observed;
    const already =
      current === (input.event === 'down' ? 'down' : 'up') &&
      !open?.causeThing &&
      !(justEnded && latest?.causeThing) &&
      !(await holdsIncident(
        tx,
        ctx.burrow.id,
        input.thing,
        ctx.now,
        justEnded && latest?.endedAt ? latest.endedAt : ctx.now,
      ));

    if (!already) {
      const running = await runningThingWatches(tx, ctx.burrow.id);
      const same = running.find(
        (w) =>
          w.thing === input.thing &&
          w.event === input.event &&
          w.conversationId === conversation.id &&
          w.threadRootId === input.threadRootId &&
          w.endsAt > ctx.now,
      );
      if (same) return { watch: thingWatchView(same) };
      if (running.filter((w) => w.endsAt > ctx.now).length >= ACTIVE_WATCH_LIMIT)
        throw badRequest('There are already 10 watches running. Cancel one first.');
    }

    const [row] = await tx
      .insert(thingWatches)
      .values({
        id: newId('thingWatch'),
        burrowId: ctx.burrow.id,
        thing: input.thing,
        name: input.name,
        event: input.event,
        agentId: ctx.actor.id,
        conversationId: conversation.id,
        threadRootId: input.threadRootId,
        status: already ? 'happened' : 'watching',
        startedAt: ctx.now,
        endsAt: new Date(ctx.now.getTime() + input.minutes * 60_000),
        endedAt: already ? ctx.now : null,
      })
      .returning();
    if (!row) throw notFound('Watch');
    const posted = await postMessage(ctx, {
      conversation,
      text: already ? thingWatchResultText(row) : thingWatchStartText(row),
      card: { kind: 'thing_watch', watchId: row.id },
      threadRootId: input.threadRootId,
      mentions: [],
      dispatch: false,
      notify: already,
    });
    await tx.update(thingWatches).set({ messageId: posted.id }).where(eq(thingWatches.id, row.id));
    return { watch: thingWatchView(row) };
  },
});

export const endThingWatch = defineCommand({
  name: 'thing.watch_ended',
  schema: z.object({ watchId: ThingWatchId, eventId: EventId.nullable() }),
  async apply(tx, ctx, input) {
    const row = await watchIn(ctx, input.watchId);
    if (ctx.actor.id !== row.agentId) throw forbidden('Only the assistant that started a watch ends it.');
    if (row.status !== 'watching' || row.eventId !== input.eventId) return;
    if (!row.eventId && row.endsAt > ctx.now) return;
    const status = row.eventId ? 'happened' : 'expired';
    const [event] = row.eventId ? await tx.select().from(events).where(eq(events.id, row.eventId)) : [];
    const incident = ThingIncidentEvent.safeParse(event?.payload);
    await settleWatch(ctx, row, status);
    const conversation = await loadConversationRow(tx, row.conversationId);
    if (!conversation) return;
    await postMessage(ctx, {
      conversation,
      text: status === 'happened' ? thingWatchResultText(row, incident.data) : thingWatchExpiredText(row),
      threadRootId:
        row.threadRootId && (await loadMessageRow(tx, row.threadRootId)) ? row.threadRootId : row.messageId,
      mentions: [],
      dispatch: false,
    });
  },
});

export const cancelThingWatch = defineCommand({
  name: 'thing.watch_cancelled',
  schema: z.object({ watchId: ThingWatchId }),
  async apply(_tx, ctx, input) {
    const row = await watchIn(ctx, input.watchId);
    if (ctx.actor.kind !== 'person' && ctx.actor.id !== row.agentId)
      throw forbidden('Only you or the assistant that started it can stop a watch.');
    if (row.status !== 'watching') return { watch: thingWatchView(row) };
    return { watch: await settleWatch(ctx, row, 'cancelled') };
  },
});

export const THING_WATCH_COMMANDS = [startThingWatch, endThingWatch, cancelThingWatch];

export async function deliverThingWatches(services: Services, burrowId: string): Promise<void> {
  const rows = await services.db
    .select()
    .from(thingWatches)
    .where(
      and(
        eq(thingWatches.burrowId, burrowId),
        eq(thingWatches.status, 'watching'),
        or(isNotNull(thingWatches.eventId), lte(thingWatches.endsAt, services.clock())),
      ),
    );
  for (const row of rows)
    await services.pipeline
      .commit(
        endThingWatch,
        { watchId: row.id, eventId: row.eventId },
        {
          burrowId,
          actorId: row.agentId,
        },
      )
      .catch((err: unknown) => services.log.warn({ err, watchId: row.id }, 'A thing watch will be retried'));
}
