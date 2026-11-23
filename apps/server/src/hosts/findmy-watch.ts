/**
 * One-time Find My watches (docs/decisions/findmy-watch.md): the assistant starts one in a thread with `findmy_watch`
 * (“tell me when Noor leaves”), and from then on Whombat compares every read of the connection's Mac with it itself,
 * with no AI turn. The first read that shows the change ends the watch and the assistant's message in the thread says
 * so; a watch nothing happened to stops after a day, and one whose Find My went stops at the next background pass, both
 * saying so too. The person cancels one with its card's Cancel. Where someone was is kept only while it watches.
 */
import {
  ConnectionId,
  ConversationId,
  FIND_MY_PLACE_MAX,
  FIND_MY_WATCH_EVERY_MIN,
  FIND_MY_WATCH_HOURS,
  FIND_MY_WATCHES_MAX,
  FindMyPersonId,
  FindMySpot,
  FindMyWatchChange,
  FindMyWatchId,
  type FindMyWatchStatus,
  type FindMyWatchView,
  findMyWatchArrived,
  findMyWatchEndText,
  findMyWatchLeft,
  findMyWatchStartText,
  type HostFindMyPerson,
  MessageId,
  newId,
  topics,
} from '@whombat/core';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { findMyWatches } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import type { Services } from '../services';
import { type FindMyPace, findMyConnectionRow, findMyConnections } from './findmy-connection';

import { type WatchRow, watchView } from './findmy-watch-cards';

const HOUR_MS = 3_600_000;
const WORDS_MAX = 300;

const words = (s: string | null | undefined, max = WORDS_MAX): string | null => {
  const w = s?.replace(/\s+/g, ' ').trim().slice(0, max);
  return w ? w : null;
};

/** The card's place words for a `leaves` watch: the street they are on, else Find My's words. */
export function leavesPlace(p: Pick<HostFindMyPerson, 'place' | 'address'>): string | null {
  return words(p.address) ?? words(p.place);
}

/** Whether a read shows a watch's change happened (pure). */
export function watchHappened(
  row: Pick<WatchRow, 'change' | 'place' | 'fromPlace' | 'fromAddress' | 'lat' | 'lon' | 'accuracyM'>,
  now: Pick<HostFindMyPerson, 'place' | 'address' | 'location'>,
): boolean {
  if (row.change === 'arrives') return findMyWatchArrived(row.place, now);
  const spot =
    row.lat !== null && row.lon !== null
      ? { lat: row.lat, lon: row.lon, accuracyM: row.accuracyM ?? 0 }
      : null;
  return findMyWatchLeft({ place: row.fromPlace, address: row.fromAddress, spot }, now);
}

/* Reading --------------------------------------------------------------------------------------------------------- */

/** The watches running on these connections. */
export async function watchingOn(db: Db | Tx, connectionIds: readonly string[]): Promise<WatchRow[]> {
  if (!connectionIds.length) return [];
  return db
    .select()
    .from(findMyWatches)
    .where(and(inArray(findMyWatches.connectionId, [...connectionIds]), eq(findMyWatches.status, 'watching')))
    .orderBy(asc(findMyWatches.startedAt));
}

/** The watches running in a burrow, oldest first. */
export async function watchingIn(db: Db | Tx, burrowId: string): Promise<WatchRow[]> {
  return db
    .select()
    .from(findMyWatches)
    .where(and(eq(findMyWatches.burrowId, burrowId), eq(findMyWatches.status, 'watching')))
    .orderBy(asc(findMyWatches.startedAt));
}

/** For each connection with a watch running: who it watches (“Noor Visser”, “Noor Visser and Ruben Visser”). */
export async function watchedConnections(db: Db | Tx): Promise<Map<string, string>> {
  const rows = await db
    .select({ connectionId: findMyWatches.connectionId, name: findMyWatches.name })
    .from(findMyWatches)
    .where(eq(findMyWatches.status, 'watching'))
    .orderBy(asc(findMyWatches.startedAt));
  const names = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.connectionId) continue;
    const list = names.get(r.connectionId) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    names.set(r.connectionId, list);
  }
  const out = new Map<string, string>();
  for (const [id, list] of names) {
    const said = list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    out.set(id, said.length <= 200 ? said : `${list.length} people`);
  }
  return out;
}

/* Commands -------------------------------------------------------------------------------------------------------- */

/** Re-sends a watch's card to the conversation, as its row is now. */
async function republishCard(ctx: ApplyContext, row: Pick<WatchRow, 'messageId'>): Promise<void> {
  const message = row.messageId ? await loadMessageRow(ctx.tx, row.messageId) : undefined;
  if (!message) return;
  const [loaded] = await loadMessages(ctx.tx, [message], null);
  if (loaded)
    ctx.publish(
      topics.conversation(message.conversationId),
      { type: 'message.updated', message: loaded },
      {
        eventId: null,
      },
    );
}

async function lockWatch(tx: Tx, id: string): Promise<WatchRow | undefined> {
  const [row] = await tx.select().from(findMyWatches).where(eq(findMyWatches.id, id)).for('update');
  return row;
}

/** Ends a watch (no longer watching, where they were cleared) and re-sends its card. */
async function endWatch(
  ctx: ApplyContext,
  row: WatchRow,
  status: Exclude<FindMyWatchStatus, 'watching'>,
  to: string | null,
): Promise<WatchRow> {
  const [ended] = await ctx.tx
    .update(findMyWatches)
    .set({
      status,
      to,
      endedAt: ctx.now,
      fromPlace: null,
      fromAddress: null,
      lat: null,
      lon: null,
      accuracyM: null,
    })
    .where(eq(findMyWatches.id, row.id))
    .returning();
  const out = ended ?? row;
  await republishCard(ctx, out);
  return out;
}

export const FIND_MY_WATCH_TEXT = {
  limit: `There are already ${FIND_MY_WATCHES_MAX} watches running. Cancel one first.`,
} as const;

export type StartOutcome = { status: 'ok'; watch: FindMyWatchView } | { status: 'invalid'; problem: string };

/**
 * The assistant starts a watch in the conversation and thread of its turn: the row, and its card under its words
 * (“I’ll tell you when Noor Visser leaves Keizersgracht.”). A watch of the same person for the same change on the same
 * connection is replaced (cancelled). No event of its own: the card's message is the record, and the event log never
 * holds a spot.
 */
export const startFindMyWatch = defineCommand({
  name: 'findmy.watch_started',
  schema: z.object({
    connectionId: ConnectionId,
    conversationId: ConversationId,
    threadRootId: MessageId.nullable(),
    person: FindMyPersonId,
    name: z.string().min(1).max(200),
    change: FindMyWatchChange,
    place: z.string().min(1).max(WORDS_MAX),
    from: z
      .object({
        place: z.string().min(1).max(WORDS_MAX).nullable(),
        address: z.string().min(1).max(WORDS_MAX).nullable(),
        spot: FindMySpot.nullable(),
      })
      .nullable(),
  }),
  async apply(tx, ctx, input): Promise<StartOutcome> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant starts a watch.');
    if (!(await findMyConnectionRow(tx, ctx.burrow.id, input.connectionId)))
      throw notFound('Find My connection');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const running = await watchingIn(tx, ctx.burrow.id);
    const same = running.filter(
      (w) => w.connectionId === input.connectionId && w.person === input.person && w.change === input.change,
    );
    if (running.length - same.length >= FIND_MY_WATCHES_MAX)
      return { status: 'invalid', problem: FIND_MY_WATCH_TEXT.limit };
    for (const w of same) {
      const locked = await lockWatch(tx, w.id);
      if (locked?.status === 'watching') await endWatch(ctx, locked, 'cancelled', null);
    }
    const id = newId('findMyWatch');
    const from = input.change === 'leaves' ? input.from : null;
    const [row] = await tx
      .insert(findMyWatches)
      .values({
        id,
        burrowId: ctx.burrow.id,
        connectionId: input.connectionId,
        person: input.person,
        name: input.name,
        change: input.change,
        place: input.place,
        fromPlace: from?.place ?? null,
        fromAddress: from?.address ?? null,
        lat: from?.spot?.lat ?? null,
        lon: from?.spot?.lon ?? null,
        accuracyM: from?.spot?.accuracyM ?? null,
        agentId: ctx.actor.id,
        conversationId: conversation.id,
        threadRootId: input.threadRootId,
        messageId: null,
        status: 'watching',
        to: null,
        startedAt: ctx.now,
        endsAt: new Date(ctx.now.getTime() + FIND_MY_WATCH_HOURS * HOUR_MS),
        endedAt: null,
      })
      .returning();
    if (!row) throw notFound('Watch');
    // The card wakes nobody: the assistant's own reply follows in the same turn.
    const posted = await postMessage(ctx, {
      conversation,
      text: findMyWatchStartText(row),
      card: { kind: 'findmy_watch', watchId: id },
      threadRootId: input.threadRootId,
      mentions: [],
      dispatch: false,
      notifyMentions: false,
    });
    const [saved] = await tx
      .update(findMyWatches)
      .set({ messageId: posted.id })
      .where(eq(findMyWatches.id, id))
      .returning();
    return { status: 'ok', watch: watchView(saved ?? row) };
  },
});

/**
 * A watch ends by itself, said by the assistant that started it in the watch's thread: it happened (`to`: where Find
 * My had them), nothing happened in a day (`expired`), or its Find My went (`stopped`). A watch that already ended
 * says nothing more.
 */
export const endFindMyWatch = defineCommand({
  name: 'findmy.watch_ended',
  schema: z.object({
    watchId: FindMyWatchId,
    status: z.enum(['happened', 'expired', 'stopped']),
    to: z.string().min(1).max(WORDS_MAX).nullable(),
  }),
  async apply(tx, ctx, input) {
    const row = await lockWatch(tx, input.watchId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Watch');
    if (row.agentId !== ctx.actor.id) throw forbidden('Only the assistant that started a watch ends it.');
    if (row.status !== 'watching') return { ended: false, watch: watchView(row) };
    const ended = await endWatch(ctx, row, input.status, input.status === 'happened' ? input.to : null);
    const text = findMyWatchEndText(watchView(ended));
    const conversation = await loadConversationRow(tx, row.conversationId);
    if (text && conversation)
      await postMessage(ctx, {
        conversation,
        text,
        // In the thread it was asked in; a watch started outside one answers under its own card.
        threadRootId: row.threadRootId ?? row.messageId,
        mentions: [],
        dispatch: false,
      });
    return { ended: true, watch: watchView(ended) };
  },
});

/**
 * The person (the card's Cancel) or the assistant that started it (its tool) stops a watch; nothing is posted, the card
 * says it stopped. A watch that already ended answers as it is.
 */
export const cancelFindMyWatch = defineCommand({
  name: 'findmy.watch_cancelled',
  schema: z.object({ watchId: FindMyWatchId }),
  async apply(tx, ctx, input) {
    const row = await lockWatch(tx, input.watchId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Watch');
    const mayCancel =
      ctx.actor.kind === 'person' || (ctx.actor.kind === 'agent' && ctx.actor.id === row.agentId);
    if (!mayCancel) throw forbidden('Only you or the assistant that started it can stop a watch.');
    if (row.status !== 'watching') return { watch: watchView(row) };
    return { watch: watchView(await endWatch(ctx, row, 'cancelled', null)) };
  },
});

export const FIND_MY_WATCH_COMMANDS = [startFindMyWatch, endFindMyWatch, cancelFindMyWatch];

/* The watcher ---------------------------------------------------------------------------------------------------- */

/**
 * Compares the reads of each Mac with the watches on its Find My connections (one Mac at a time, so two reads close
 * together can't both end a watch), and ends the watches whose day is over or whose Find My went. Never throws: a watch
 * that can't be ended is said in the log, with its id only, and tried again on the next read or pass.
 */
export class FindMyWatcher {
  readonly #chains = new Map<string, Promise<void>>();

  constructor(private readonly services: Services) {}

  #inLine(serverId: string, work: () => Promise<void>): Promise<void> {
    const key = serverId.toLowerCase();
    const next = (this.#chains.get(key) ?? Promise.resolve())
      .then(work)
      .catch((err: unknown) =>
        this.services.log.warn(
          { server: serverId, err: err instanceof Error ? err.name : 'error' },
          'Find My: a read wasn’t compared with the watches',
        ),
      );
    this.#chains.set(key, next);
    void next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
    return next;
  }

  /** A read of the Mac that worked: each watch on its connections whose change it shows ends. */
  noted(serverId: string, people: readonly HostFindMyPerson[]): Promise<void> {
    return this.#inLine(serverId, async () => {
      if (this.services.schemaAccess === 'read-only') return;
      const connections = await findMyConnections(this.services.db, { mac: serverId });
      const watches = await watchingOn(
        this.services.db,
        connections.map((c) => c.id),
      );
      for (const w of watches) {
        const now = people.find((p) => p.id === w.person);
        if (!now || !watchHappened(w, now)) continue;
        await this.#end(w, 'happened', words(now.place, FIND_MY_PLACE_MAX) ?? words(now.address));
      }
    });
  }

  /**
   * Each background pass: watches past their day end as `expired`, and those whose connection was removed, or whose Mac
   * is no longer one of the servers (`macGone`, only when the fleet was read), as `stopped`.
   */
  async sweep(now: Date, macGone: (connectionId: string) => boolean = () => false): Promise<void> {
    const services = this.services;
    if (services.schemaAccess === 'read-only') return;
    const due = await services.db
      .select()
      .from(findMyWatches)
      .where(and(eq(findMyWatches.status, 'watching'), lte(findMyWatches.endsAt, now)));
    const orphaned = await services.db
      .select()
      .from(findMyWatches)
      .where(and(eq(findMyWatches.status, 'watching'), isNull(findMyWatches.connectionId)));
    const running = await services.db
      .select()
      .from(findMyWatches)
      .where(eq(findMyWatches.status, 'watching'));
    const gone = running.filter((w) => w.connectionId !== null && macGone(w.connectionId));
    const done = new Set<string>();
    for (const [rows, status] of [
      [orphaned, 'stopped'],
      [gone, 'stopped'],
      [due, 'expired'],
    ] as const)
      for (const w of rows) {
        if (done.has(w.id)) continue;
        done.add(w.id);
        await this.#end(w, status, null).catch((err: unknown) =>
          services.log.warn(
            { watch: w.id, err: err instanceof Error ? err.name : 'error' },
            'Find My: a watch wasn’t ended',
          ),
        );
      }
  }

  async #end(w: WatchRow, status: 'happened' | 'expired' | 'stopped', to: string | null): Promise<void> {
    await this.services.pipeline.commit(
      endFindMyWatch,
      { watchId: w.id, status, to },
      { burrowId: w.burrowId, actorId: w.agentId },
    );
  }
}

const watchers = new WeakMap<Services, FindMyWatcher>();

/** The process's watcher (one per `Services`). */
export function findMyWatcherFor(services: Services): FindMyWatcher {
  let w = watchers.get(services);
  if (!w) {
    w = new FindMyWatcher(services);
    watchers.set(services, w);
  }
  return w;
}

/**
 * A connection's pace with its watches (pure): at least every `FIND_MY_WATCH_EVERY_MIN` while one runs, saying whom it
 * watches; an automation's name stays the reason when the pace is the same.
 */
export function paceWithWatch(pace: FindMyPace | null, watching: string | undefined): FindMyPace | null {
  if (!watching) return pace;
  if (pace && pace.everyMinutes <= FIND_MY_WATCH_EVERY_MIN) return { ...pace, watching };
  return { everyMinutes: FIND_MY_WATCH_EVERY_MIN, automation: null, watching };
}
