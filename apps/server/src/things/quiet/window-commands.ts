/**
 * Keeping a thing quiet for a while in the commit pipeline: `keep_quiet` keeps a
 * server, connection or device quiet until a time (the person's own window, when one holds already, gets the new end
 * and note; Whombat's window for its planned work is never changed), `end_quiet` ends it now. Both are the person's,
 * signed, and recorded as a change of the thing: keeping quiet with Undo (which puts the person's window back as it was,
 * or ends the one it made: `restore_quiet`, `end_quiet` of one window), ending it in the thing's Activity. The assistant
 * does it only on the person's word (`quiet_until`), recorded as its change for them. A server's maintenance window in
 * the hosts service is made before the commit and removed after it (`window-service.ts`); here only its id is kept, and
 * one a window no longer names goes on the list to give back in the same transaction.
 */
import { thingHref } from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../../commit/types';
import { defineCommand } from '../../commit/types';
import type { Tx } from '../../db/client';
import { quietMaintenanceLeft, quietWindows } from '../../db/schema/index';
import { EVERYDAY_CHANGE_PREFIX } from '../../home/changes';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import { recordChange } from '../../home/registry';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { QuietThingInput } from './commands';
import { windowHolds } from './windows';
import { untilWords } from './words';

/** The kind of the change that keeps a thing quiet: its Undo puts the window back as it was, or ends the one it made. */
export const KEEP_QUIET_CHANGE_KIND = 'things.keepQuiet';

/** The person's window as it was before keeping quiet changed it. */
export interface QuietWindowWas {
  endsAt: string;
  note: string | null;
  byId: string | null;
  /** Its count of changes then, which Undo puts back (absent on changes made before windows counted them). */
  revision?: number;
}

/** What Undo of keeping quiet needs: the thing, the window, the end this change set and the window before it. */
export interface KeepQuietUndo {
  thing: string;
  windowId: string;
  /** The end this change set (absent on changes made before it): what Undo compares when there is no `revision`. */
  endsAt?: string;
  /**
   * The window's count of changes this change left: a window changed again since (another end, or only another note)
   * is left as it is. Absent on changes made before windows counted them.
   */
  revision?: number;
  /** The window as it was, when this change changed one that held already; absent when it made the window. */
  previous?: QuietWindowWas;
}

/** Thrown when Undo finds the window changed again since the change it takes back. */
export const CHANGED_SINCE = 'It was changed again since.';

/**
 * Whether the window is still as the change being undone left it: by its count of changes when the change has one,
 * else by its end (a change recorded before windows counted them).
 */
function unchangedSince(
  w: { endsAt: Date; revision: number },
  since: { revision?: number | undefined; set?: string | undefined },
): boolean {
  if (since.revision !== undefined) return w.revision === since.revision;
  return since.set === undefined || w.endsAt.getTime() === new Date(since.set).getTime();
}

/**
 * A maintenance window no window names any more goes on the list to give back, in the transaction that dropped its id:
 * when removing it from the hub fails later, the minute's sweep still knows it and tries again.
 */
async function giveBackLater(tx: Tx, ctx: ApplyContext, maintenanceId: string): Promise<void> {
  await tx
    .insert(quietMaintenanceLeft)
    .values({ maintenanceId, ownerId: ctx.burrow.id, createdAt: ctx.now })
    .onConflictDoNothing();
}

async function tell(ctx: ApplyContext, thing: z.infer<typeof QuietThingInput>, payload: object) {
  await ctx.emit({
    type: 'thing.quiet',
    kind: 'System',
    text: null,
    where: null,
    payload: { thing: thing.id, ...payload },
  });
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['things', 'watch', 'needsYou']);
}

/**
 * Keep a thing quiet until `until`, with an optional note; the person's own window that holds already is changed in
 * place. Whombat's window for its planned work stays as it is beside it: it keeps its work, its maintenance window and
 * its end after the work.
 */
export const keepQuiet = defineCommand({
  name: 'keep_quiet',
  schema: z.object({
    thing: QuietThingInput,
    /** The new window's id (unused when one holds already). */
    windowId: z.string().min(1).max(64),
    until: z.string().datetime({ offset: true }),
    note: z.string().max(120).optional(),
    /** The hosts service's maintenance window made for a server's. */
    maintenanceId: z.string().min(1).max(64).optional(),
    /** The assistant that did it on the person's word (`quiet_until`). */
    agentId: z.string().min(1).max(64).optional(),
    timeZone: z.string().max(64).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can keep things quiet.');
    const { thing } = input;
    const until = new Date(input.until);
    if (until.getTime() <= ctx.now.getTime()) throw badRequest('Pick a time that is still to come.');
    const open = await tx
      .select()
      .from(quietWindows)
      .where(
        and(
          eq(quietWindows.ownerId, thing.owner),
          eq(quietWindows.thingId, thing.id),
          isNull(quietWindows.guestId),
          isNull(quietWindows.work),
          isNull(quietWindows.endedAt),
        ),
      );
    const holding = open.filter((w) => windowHolds(w, ctx.now)).sort((a, b) => +b.endsAt - +a.endsAt)[0];
    const note = input.note?.trim() || null;
    const previousMaintenance = holding?.maintenanceId ?? null;
    // A server's window names only the maintenance window made for its new end: when the hub couldn't make one, the old
    // one (perhaps longer) goes back all the same, and Whombat's own window keeps the server quiet by itself.
    const maintenanceId = input.maintenanceId ?? null;
    const revision = holding ? holding.revision + 1 : 0;
    let windowId: string;
    if (holding) {
      windowId = holding.id;
      await tx
        .update(quietWindows)
        .set({ endsAt: until, note, byId: ctx.actor.id, maintenanceId, revision })
        .where(eq(quietWindows.id, holding.id));
    } else {
      windowId = input.windowId;
      await tx.insert(quietWindows).values({
        id: windowId,
        ownerId: thing.owner,
        thingId: thing.id,
        guestId: null,
        startsAt: ctx.now,
        endsAt: until,
        note,
        byId: ctx.actor.id,
        work: null,
        maintenanceId,
        endedAt: null,
        endedById: null,
        createdAt: ctx.now,
        revision,
      });
    }
    const words = untilWords(until, ctx.now, input.timeZone ?? ctx.burrow.timeZone ?? 'UTC');
    await tell(ctx, thing, { kind: 'quiet.keep', until: until.toISOString() });
    const undo: KeepQuietUndo = {
      thing: thing.id,
      windowId,
      endsAt: until.toISOString(),
      revision,
      ...(holding
        ? {
            previous: {
              endsAt: holding.endsAt.toISOString(),
              note: holding.note,
              byId: holding.byId,
              revision: holding.revision,
            },
          }
        : {}),
    };
    const changeId = await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      personId: ctx.actor.id,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      kind: KEEP_QUIET_CHANGE_KIND,
      title: `Kept ${thing.name} quiet ${words}`.slice(0, 200),
      ...(note ? { detail: note } : {}),
      subject: { kind: thing.kind, id: thing.ref, name: thing.name },
      link: thingHref(thing.kind, thing.ref),
      undo: { kind: KEEP_QUIET_CHANGE_KIND, payload: undo, until },
      at: ctx.now,
    });
    // A maintenance window this one replaced: the caller removes it from the hosts service after the commit.
    const replaced =
      previousMaintenance && previousMaintenance !== maintenanceId ? previousMaintenance : null;
    if (replaced) await giveBackLater(tx, ctx, replaced);
    return { windowId, changeId, replaced };
  },
});

/**
 * Undo of keeping quiet that changed the person's window: it gets its end, note, who kept it quiet and its count of
 * changes back (with a new maintenance window for a server, made before the commit), so the change before it can be
 * undone next. A window that ended, or that changed again since, is left alone.
 */
export const restoreQuiet = defineCommand({
  name: 'restore_quiet',
  schema: z.object({
    thing: QuietThingInput,
    windowId: z.string().min(1).max(64),
    /** The end the change being undone set. */
    set: z.string().datetime({ offset: true }),
    /** The window's count of changes the change being undone left; absent on changes recorded before windows had one. */
    revision: z.number().int().nonnegative().optional(),
    endsAt: z.string().datetime({ offset: true }),
    note: z.string().max(120).nullable(),
    byId: z.string().min(1).max(64).nullable(),
    /** The count of changes the window had before that change. */
    previousRevision: z.number().int().nonnegative().optional(),
    maintenanceId: z.string().min(1).max(64).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can undo this.');
    const { thing } = input;
    const [w] = await tx
      .select()
      .from(quietWindows)
      .where(
        and(
          eq(quietWindows.id, input.windowId),
          eq(quietWindows.ownerId, thing.owner),
          eq(quietWindows.thingId, thing.id),
          isNull(quietWindows.work),
          isNull(quietWindows.endedAt),
        ),
      );
    if (!w || !windowHolds(w, ctx.now)) throw notFound('Quiet');
    if (!unchangedSince(w, input)) throw conflict(CHANGED_SINCE);
    const endsAt = new Date(input.endsAt);
    // As when keeping quiet: only a maintenance window made for the restored end; Whombat's window holds without one.
    const maintenanceId = input.maintenanceId ?? null;
    await tx
      .update(quietWindows)
      .set({
        endsAt,
        note: input.note,
        byId: input.byId,
        maintenanceId,
        revision: input.previousRevision ?? w.revision + 1,
      })
      .where(eq(quietWindows.id, w.id));
    const replaced = w.maintenanceId && w.maintenanceId !== maintenanceId ? w.maintenanceId : null;
    if (replaced) await giveBackLater(tx, ctx, replaced);
    await tell(ctx, thing, { kind: 'quiet.keep', until: endsAt.toISOString() });
    return { replaced };
  },
});

/**
 * End now: the thing is watched again at once (and what is still wrong counts from the start). Every window that holds
 * the whole thing ends, the person's and Whombat's for its own work alike, so “watched again” is true; Undo of keeping
 * it quiet names its own window (`windowId`) and ends only that one.
 */
export const endQuiet = defineCommand({
  name: 'end_quiet',
  schema: z.object({
    thing: QuietThingInput,
    /** One window only (Undo); without it, every window holding the thing. */
    windowId: z.string().min(1).max(64).optional(),
    /** With `windowId`: the end the change being undone set; a window whose end changed again since stays. */
    set: z.string().datetime({ offset: true }).optional(),
    /** With `windowId`: the window's count of changes the change being undone left; one changed again since stays. */
    revision: z.number().int().nonnegative().optional(),
    agentId: z.string().min(1).max(64).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can end this.');
    const { thing } = input;
    const mine = and(
      eq(quietWindows.ownerId, thing.owner),
      eq(quietWindows.thingId, thing.id),
      isNull(quietWindows.endedAt),
    );
    let ids: string[];
    if (input.windowId) {
      ids = [input.windowId];
      if (input.set !== undefined || input.revision !== undefined) {
        const [w] = await tx
          .select({ endsAt: quietWindows.endsAt, revision: quietWindows.revision })
          .from(quietWindows)
          .where(and(mine, eq(quietWindows.id, input.windowId)));
        if (w && !unchangedSince(w, input)) throw conflict(CHANGED_SINCE);
      }
    } else {
      const open = await tx
        .select()
        .from(quietWindows)
        .where(and(mine, isNull(quietWindows.guestId)));
      ids = open.filter((w) => windowHolds(w, ctx.now)).map((w) => w.id);
    }
    const ended = ids.length
      ? await tx
          .update(quietWindows)
          .set({ endedAt: ctx.now, endedById: ctx.actor.id })
          .where(and(mine, inArray(quietWindows.id, ids)))
          .returning()
      : [];
    if (!ended.length) throw notFound('Quiet');
    await tell(ctx, thing, { kind: 'quiet.end' });
    const changeId = await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      personId: ctx.actor.id,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      // Ending it early is an everyday change: the thing's Activity says it, Done recently doesn't.
      kind: input.agentId ? 'things.endQuiet' : `${EVERYDAY_CHANGE_PREFIX}quiet.end`,
      title: `Watching ${thing.name} again`.slice(0, 200),
      subject: { kind: thing.kind, id: thing.ref, name: thing.name },
      link: thingHref(thing.kind, thing.ref),
      at: ctx.now,
    });
    return { ended: ended.map((w) => ({ id: w.id, maintenanceId: w.maintenanceId })), changeId };
  },
});

export const QUIET_WINDOW_COMMANDS = [keepQuiet, restoreQuiet, endQuiet];
