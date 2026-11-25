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
}

/** What Undo of keeping quiet needs: the thing, the window, the end this change set and the window before it. */
export interface KeepQuietUndo {
  thing: string;
  windowId: string;
  /** The end this change set: a window changed again since is left as it is (absent on changes made before it). */
  endsAt?: string;
  /** The window as it was, when this change changed one that held already; absent when it made the window. */
  previous?: QuietWindowWas;
}

/** Thrown when Undo finds the window changed again since the change it takes back. */
export const CHANGED_SINCE = 'It was changed again since.';

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
    const maintenanceId = input.maintenanceId ?? previousMaintenance;
    let windowId: string;
    if (holding) {
      windowId = holding.id;
      await tx
        .update(quietWindows)
        .set({ endsAt: until, note, byId: ctx.actor.id, maintenanceId })
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
        maintenanceId: input.maintenanceId ?? null,
        endedAt: null,
        endedById: null,
        createdAt: ctx.now,
      });
    }
    const words = untilWords(until, ctx.now, input.timeZone ?? ctx.burrow.timeZone ?? 'UTC');
    await tell(ctx, thing, { kind: 'quiet.keep', until: until.toISOString() });
    const undo: KeepQuietUndo = {
      thing: thing.id,
      windowId,
      endsAt: until.toISOString(),
      ...(holding
        ? { previous: { endsAt: holding.endsAt.toISOString(), note: holding.note, byId: holding.byId } }
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
 * Undo of keeping quiet that changed the person's window: it gets its end, note and who kept it quiet back (with a new
 * maintenance window for a server, made before the commit). A window that ended, or whose end changed again since, is
 * left alone.
 */
export const restoreQuiet = defineCommand({
  name: 'restore_quiet',
  schema: z.object({
    thing: QuietThingInput,
    windowId: z.string().min(1).max(64),
    /** The end the change being undone set. */
    set: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    note: z.string().max(120).nullable(),
    byId: z.string().min(1).max(64).nullable(),
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
    if (w.endsAt.getTime() !== new Date(input.set).getTime()) throw conflict(CHANGED_SINCE);
    const endsAt = new Date(input.endsAt);
    const maintenanceId = input.maintenanceId ?? w.maintenanceId;
    await tx
      .update(quietWindows)
      .set({ endsAt, note: input.note, byId: input.byId, maintenanceId })
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
      if (input.set) {
        const [w] = await tx
          .select({ endsAt: quietWindows.endsAt })
          .from(quietWindows)
          .where(and(mine, eq(quietWindows.id, input.windowId)));
        if (w && w.endsAt.getTime() !== new Date(input.set).getTime()) throw conflict(CHANGED_SINCE);
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
