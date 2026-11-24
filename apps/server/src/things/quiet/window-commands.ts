/**
 * Keeping a thing quiet for a while in the commit pipeline: `keep_quiet` keeps a
 * server, connection or device quiet until a time (a thing kept quiet already gets the new end and note), `end_quiet`
 * ends it now. Both are the person's, signed, and recorded as a change of the thing: keeping quiet with Undo (which ends
 * it), ending it in the thing's Activity. The assistant does it only on the person's word (`quiet_until`), recorded as
 * its change for them. A server's maintenance window in the hosts service is made before the commit and removed after
 * it (`window-service.ts`); here only its id is kept.
 */
import { thingHref } from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../../commit/types';
import { defineCommand } from '../../commit/types';
import { quietWindows } from '../../db/schema/index';
import { EVERYDAY_CHANGE_PREFIX } from '../../home/changes';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import { recordChange } from '../../home/registry';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { QuietThingInput } from './commands';
import { windowHolds } from './windows';
import { untilWords } from './words';

/** The kind of the change that keeps a thing quiet: its Undo ends the window. */
export const KEEP_QUIET_CHANGE_KIND = 'things.keepQuiet';

/** What Undo of keeping quiet needs: the thing and the window. */
export interface KeepQuietUndo {
  thing: string;
  windowId: string;
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

/** Keep a thing quiet until `until`, with an optional note; a window that holds already is changed in place. */
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
          isNull(quietWindows.endedAt),
        ),
      );
    const holding = open.filter((w) => windowHolds(w, ctx.now)).sort((a, b) => +b.endsAt - +a.endsAt)[0];
    const note = input.note?.trim() || null;
    const previousMaintenance = holding?.maintenanceId ?? null;
    let windowId: string;
    if (holding) {
      windowId = holding.id;
      await tx
        .update(quietWindows)
        .set({
          endsAt: until,
          note,
          byId: ctx.actor.id,
          work: null,
          maintenanceId: input.maintenanceId ?? holding.maintenanceId,
        })
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
    const undo: KeepQuietUndo = { thing: thing.id, windowId };
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
      input.maintenanceId && previousMaintenance && previousMaintenance !== input.maintenanceId
        ? previousMaintenance
        : null;
    return { windowId, changeId, replaced };
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
    if (input.windowId) ids = [input.windowId];
    else {
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

export const QUIET_WINDOW_COMMANDS = [keepQuiet, endQuiet];
