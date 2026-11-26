/**
 * A person's “Remind me tomorrow” / “Not now” on a Needs you or Watch item (one-whombat.md ONE-10; needsYou.snooze,
 * CT-336): hidden from their own view until then (`needs_you_snoozes`). Nobody else's view changes. A Watch item's
 * acknowledgement (`watch.acknowledge`, CT-349) is the same row with `state: acknowledged`, and Ignore
 * (`needsYou.ignore`, CT-352) with `state: ignored` and no end.
 */
import { HomeRef, Timestamp } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { needsYouSnoozes } from '../db/schema/index';
import { badRequest, forbidden } from '../lib/errors';
import { settleAheadNotices } from '../looks-ahead/commands';
import { publishHomeChanged } from './notify';

/** The longest snooze: a month. */
export const SNOOZE_MAX_MS = 31 * 24 * 3600_000;

export const snoozeNeedsYou = defineCommand({
  name: 'snooze_needs_you',
  schema: z.object({ ref: HomeRef, until: Timestamp }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people snooze what needs them.');
    const until = new Date(input.until);
    if (until.getTime() <= ctx.now.getTime()) throw badRequest('Pick a time that is still to come.');
    if (until.getTime() - ctx.now.getTime() > SNOOZE_MAX_MS)
      throw badRequest('Pick a time within the next month.');
    await tx
      .insert(needsYouSnoozes)
      .values({
        burrowId: ctx.burrow.id,
        personId: ctx.actor.id,
        refKind: input.ref.kind,
        refId: input.ref.id,
        state: 'snoozed',
        until,
        createdAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [needsYouSnoozes.personId, needsYouSnoozes.refKind, needsYouSnoozes.refId],
        set: { state: 'snoozed', until, createdAt: ctx.now },
      });
    if (input.ref.kind === 'ahead') await settleAheadNotices(ctx, [input.ref.id], 'read');
    publishHomeChanged(ctx, [ctx.actor.id], ['needsYou', 'watch']);
    return { ref: input.ref, snoozedUntil: until.toISOString() };
  },
});

/**
 * How long a person's own acknowledgement of a Watch item lasts (anything but a server alert, whose acknowledgement is
 * the hosts service's until it resolves): a week, then it shows again if it is still there (one-whombat-consoles.md
 * ONE-DC08). A connection's item keeps its id across breakdowns, so “until it changes” can't be told from the item.
 */
export const ACKNOWLEDGE_MAX_MS = 7 * 24 * 3600_000;

/** A person's “I've seen it” on a Watch item, or (`acknowledged: false`) taking it back (`watch.acknowledge`, CT-349). */
export const acknowledgeWatch = defineCommand({
  name: 'acknowledge_watch',
  schema: z.object({ ref: HomeRef, acknowledged: z.boolean() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people acknowledge what they watch.');
    const key = and(
      eq(needsYouSnoozes.personId, ctx.actor.id),
      eq(needsYouSnoozes.refKind, input.ref.kind),
      eq(needsYouSnoozes.refId, input.ref.id),
    );
    if (input.acknowledged) {
      const until = new Date(ctx.now.getTime() + ACKNOWLEDGE_MAX_MS);
      await tx
        .insert(needsYouSnoozes)
        .values({
          burrowId: ctx.burrow.id,
          personId: ctx.actor.id,
          refKind: input.ref.kind,
          refId: input.ref.id,
          state: 'acknowledged',
          until,
          createdAt: ctx.now,
        })
        .onConflictDoUpdate({
          target: [needsYouSnoozes.personId, needsYouSnoozes.refKind, needsYouSnoozes.refId],
          set: { state: 'acknowledged', until, createdAt: ctx.now },
        });
    } else await tx.delete(needsYouSnoozes).where(key);
    publishHomeChanged(ctx, [ctx.actor.id], ['needsYou', 'watch']);
    return { ref: input.ref, state: input.acknowledged ? ('acknowledged' as const) : ('open' as const) };
  },
});

/**
 * A person's Ignore on a Needs you item, or (`ignored: false`) taking it back (`needsYou.ignore`, CT-352;
 * one-whombat.md ONE-24): gone from their Needs you for good, seen in their Watch. Nothing else changes — an approval
 * stays undecided, a server alert stays open on its server.
 */
export const ignoreNeedsYou = defineCommand({
  name: 'ignore_needs_you',
  schema: z.object({ ref: HomeRef, ignored: z.boolean() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people ignore what needs them.');
    if (input.ignored) {
      await tx
        .insert(needsYouSnoozes)
        .values({
          burrowId: ctx.burrow.id,
          personId: ctx.actor.id,
          refKind: input.ref.kind,
          refId: input.ref.id,
          state: 'ignored',
          until: null,
          createdAt: ctx.now,
        })
        .onConflictDoUpdate({
          target: [needsYouSnoozes.personId, needsYouSnoozes.refKind, needsYouSnoozes.refId],
          set: { state: 'ignored', until: null, createdAt: ctx.now },
        });
      if (input.ref.kind === 'ahead') await settleAheadNotices(ctx, [input.ref.id], 'read');
    } else
      await tx
        .delete(needsYouSnoozes)
        .where(
          and(
            eq(needsYouSnoozes.personId, ctx.actor.id),
            eq(needsYouSnoozes.refKind, input.ref.kind),
            eq(needsYouSnoozes.refId, input.ref.id),
            eq(needsYouSnoozes.state, 'ignored'),
          ),
        );
    publishHomeChanged(ctx, [ctx.actor.id], ['needsYou', 'watch']);
    return { ref: input.ref, ignored: input.ignored };
  },
});

export const SNOOZE_COMMANDS = [snoozeNeedsYou, acknowledgeWatch, ignoreNeedsYou];
