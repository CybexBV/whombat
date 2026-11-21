/**
 * People's quiet changes in the commit pipeline (quiet-notices.md QN-10…QN-17; QN-S09, QN-S10): Ignore, Remind me
 * tomorrow and their Undo on one line (`quiet_notice`), and Stop watching / watching again a check or one item of it,
 * or turning on a check that starts off (`set_watch`). Each is signed (no text: an everyday change, like a page's switches, SD-08) and recorded as a change of
 * the thing, so its Activity says who quieted what (“Ignored “Hallway AP is offline” until it’s back online”) while
 * Done recently leaves it out. Who may do it is checked before the commit (`service.ts`): the line exists now, and the
 * person may manage the thing. The person gets `home.changed`: its dot, Watch and Needs you follow.
 */
import { Timestamp, thingHref } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../../commit/types';
import { defineCommand } from '../../commit/types';
import { noticeQuiets } from '../../db/schema/index';
import { EVERYDAY_CHANGE_PREFIX } from '../../home/changes';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import { recordChange } from '../../home/registry';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { NoticeCheck, NoticeSubject } from './schema';
import { dropOff, dropOn, dropQuiet, putOff, putOn, putQuiet } from './store';
import { lowerWords, quietTitle, untilWords, watchTitle } from './words';

/** The longest Remind me: a month, as Home's snoozes. */
const SNOOZE_MAX_MS = 31 * 24 * 3600_000;

/** The thing a quiet change is about, with whose its quiets are. */
export const QuietThingInput = z.object({
  /** `connection:con_…`, `device:con_…`, `server:<id>`. */
  id: z.string().min(1).max(200),
  kind: z.enum(['connection', 'device', 'server']),
  /** Its id without the kind (the change's subject). */
  ref: z.string().min(1).max(160),
  name: z.string().min(1).max(120),
  /** Whose its quiets are: the thing's burrow (one-person.md OP-S52). */
  owner: z.string().min(1).max(64),
});
export type QuietThing = z.infer<typeof QuietThingInput>;

/** The line as it is now (what a later pass compares); for Undo only its check and item. */
const QuietLineInput = z.object({
  check: NoticeCheck,
  subject: NoticeSubject.optional(),
  title: z.string().min(1).max(120),
  tone: z.enum(['bad', 'warn', 'info']),
  band: z.number().int().optional(),
  episode: z.string().max(200).optional(),
  lifts: z.enum(['fixed', 'newer', 'period']).optional(),
  words: z.string().max(60).optional(),
  until: Timestamp.optional(),
});

/**
 * The kind of a change the assistant made to what Whombat watches, on the person's word (on-purpose.md): not an everyday
 * switch, so it is in what the assistant did, with Undo (`things/quiet/agent.ts`).
 */
export const AGENT_WATCH_CHANGE_KIND = 'things.watch';

/** What Undo of the assistant's switch puts back. */
export interface WatchUndo {
  thing: string;
  check: string;
  subject?: { id: string; name: string };
  watched: boolean;
}

async function record(
  ctx: ApplyContext,
  thing: QuietThing,
  kind: string,
  title: string,
  payload: object,
  agent?: { agentId: string; undo: WatchUndo },
) {
  await ctx.emit({
    type: 'thing.quiet',
    kind: 'System',
    // An everyday change (SD-08): the thing's own Activity says it, the burrow's log doesn't.
    text: null,
    where: null,
    payload: { thing: thing.id, kind, ...payload },
  });
  const changeId = await recordChange(ctx, {
    burrowId: ctx.burrow.id,
    actorId: ctx.actor.id,
    personId: ctx.actor.id,
    ...(agent
      ? {
          agentId: agent.agentId,
          kind: AGENT_WATCH_CHANGE_KIND,
          undo: { kind: AGENT_WATCH_CHANGE_KIND, payload: agent.undo, until: null },
        }
      : { kind: `${EVERYDAY_CHANGE_PREFIX}${kind}` }),
    title,
    subject: { kind: thing.kind, id: thing.ref, name: thing.name },
    link: thingHref(thing.kind, thing.ref),
    at: ctx.now,
  });
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['things', 'watch', 'needsYou']);
  return changeId;
}

/** Ignore, Remind me tomorrow, or Undo of either, on one line (QN-10…QN-12, QN-14, QN-17). */
export const quietNotice = defineCommand({
  name: 'quiet_notice',
  schema: z.object({
    thing: QuietThingInput,
    line: z.union([QuietLineInput, z.object({ check: NoticeCheck, subject: NoticeSubject.optional() })]),
    how: z.enum(['ignore', 'snooze', 'undo']),
    /** Snooze: when it ends (09:00 tomorrow in the burrow's zone). */
    until: Timestamp.optional(),
    /** The burrow's zone, for the words of a snooze in Activity. */
    timeZone: z.string().max(64).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can quiet what Whombat watches.');
    const { thing, line } = input;
    const subject = line.subject?.id ?? '';
    const key = { ownerId: thing.owner, thingId: thing.id, checkId: line.check, subject };
    if (input.how === 'undo') {
      const gone = await dropQuiet(tx, key);
      if (!gone) throw notFound('Quiet');
      const changeId = await record(
        ctx,
        thing,
        gone.state === 'ignored' ? 'quiet.unignore' : 'quiet.unsnooze',
        quietTitle(gone.state === 'ignored' ? 'unignore' : 'unsnooze', gone.title, ''),
        { check: line.check, subject, how: 'undo' },
      );
      return { row: null, changeId };
    }
    if (!('title' in line)) throw badRequest('Say which line.');
    let until: Date | null = null;
    if (input.how === 'snooze') {
      if (!input.until) throw badRequest('Say until when.');
      until = new Date(input.until);
      if (until.getTime() <= ctx.now.getTime()) throw badRequest('Pick a time that is still to come.');
      if (until.getTime() - ctx.now.getTime() > SNOOZE_MAX_MS)
        throw badRequest('Pick a time within the next month.');
    }
    const lifts = input.how === 'ignore' ? (line.lifts ?? 'fixed') : null;
    if (lifts === 'period') until = line.until ? new Date(line.until) : null;
    const row = await putQuiet(tx, {
      ...key,
      state: input.how === 'ignore' ? ('ignored' as const) : ('snoozed' as const),
      lifts,
      episode: line.episode ?? null,
      tone: line.tone,
      band: line.band ?? null,
      until,
      clearPasses: 0,
      title: line.title,
      subjectName: line.subject?.name ?? null,
      words: input.how === 'ignore' ? (line.words ?? null) : null,
      byId: ctx.actor.id,
      at: ctx.now,
    });
    const words =
      input.how === 'ignore'
        ? lowerWords(line.words)
        : untilWords(until as Date, ctx.now, input.timeZone ?? ctx.burrow.timeZone ?? 'UTC');
    const changeId = await record(
      ctx,
      thing,
      `quiet.${input.how}`,
      quietTitle(input.how, line.title, words),
      {
        check: line.check,
        subject,
        how: input.how,
      },
    );
    return { row, changeId };
  },
});

/**
 * Stop watching a check for the thing or one item, or watch it again (QN-13, QN-15, QN-S10). A check that starts off
 * (`startsOn` false, watch-defaults.md) is on while a `watch_ons` row says someone turned it on: turning it on writes
 * that row (and takes back an off of the whole check from before), turning it off as a whole removes it.
 */
export const setWatch = defineCommand({
  name: 'set_watch',
  schema: z.object({
    thing: QuietThingInput,
    check: NoticeCheck,
    /** The check's words (“Access points and switches going offline”), for a change about the whole check. */
    checkName: z.string().min(1).max(80),
    subject: NoticeSubject.optional(),
    watched: z.boolean(),
    /** Whether the check starts on (absent: it does). */
    startsOn: z.boolean().optional(),
    /**
     * The assistant that switched it because the person said so (on-purpose.md): the person's choice, recorded as the
     * assistant's change for them, in what it did with Undo.
     */
    agentId: z.string().min(1).max(64).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can choose what Whombat watches.');
    const { thing } = input;
    const subject = input.subject?.id ?? '';
    const key = { ownerId: thing.owner, thingId: thing.id, checkId: input.check, subject };
    const startsOff = input.startsOn === false && !input.subject;
    // Turned on for the first time: a check that starts off and nobody had switched off.
    let started = false;
    if (input.watched) {
      const dropped = await dropOff(tx, key);
      const on = { ownerId: thing.owner, thingId: thing.id, checkId: input.check };
      const put = startsOff && (await putOn(tx, { ...on, byId: ctx.actor.id, at: ctx.now }));
      if (!dropped && !put) return { changed: false, changeId: null };
      started = put && !dropped;
    } else if (startsOff) {
      if (!(await dropOn(tx, key))) return { changed: false, changeId: null };
      // As switching off: the check's quiets have nothing left to quiet.
      await tx
        .delete(noticeQuiets)
        .where(
          and(
            eq(noticeQuiets.ownerId, thing.owner),
            eq(noticeQuiets.thingId, thing.id),
            eq(noticeQuiets.checkId, input.check),
          ),
        );
    } else {
      const put = await putOff(tx, {
        ...key,
        subjectName: input.subject?.name ?? null,
        byId: ctx.actor.id,
        at: ctx.now,
      });
      if (!put) return { changed: false, changeId: null };
      // Not watched is more than ignored: the item's (or the check's) quiets have nothing left to quiet (QN-S10).
      await tx
        .delete(noticeQuiets)
        .where(
          and(
            eq(noticeQuiets.ownerId, thing.owner),
            eq(noticeQuiets.thingId, thing.id),
            eq(noticeQuiets.checkId, input.check),
            ...(subject ? [eq(noticeQuiets.subject, subject)] : []),
          ),
        );
    }
    const whole = !input.subject;
    const name = input.subject?.name ?? input.checkName;
    const changeId = await record(
      ctx,
      thing,
      input.watched ? 'watch.on' : 'watch.off',
      watchTitle(input.watched, name, whole, started),
      { check: input.check, subject, watched: input.watched },
      input.agentId
        ? {
            agentId: input.agentId,
            undo: {
              thing: thing.id,
              check: input.check,
              ...(input.subject ? { subject: input.subject } : {}),
              watched: !input.watched,
            },
          }
        : undefined,
    );
    return { changed: true, changeId };
  },
});

export const QUIET_COMMANDS = [quietNotice, setWatch];
