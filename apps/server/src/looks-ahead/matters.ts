/**
 * What Looks ahead keeps an eye on (“Keeping an eye on”, docs/decisions/looks-ahead.md): a short list of matters with
 * fixed, scrubbed fields. The person starts one in their own turn (`ahead_watch`), or a mail check does (`ahead_report`'s
 * `matter`, matched only by that mail's thread and sender). Here: reading them, how a turn and Settings see one, its
 * date, closing one, which turn may start one, and the commands `ahead_watch` runs.
 */
import {
  AHEAD_MATCH_WORD_MIN,
  AHEAD_MATTER_SENDERS_MAX,
  AHEAD_MATTER_TITLE_MAX,
  AHEAD_MATTER_WHO_MAX,
  AHEAD_MATTER_WORDS_MAX,
  AHEAD_MATTERS_MAX,
  type AheadMatterContext,
  type AheadMatterReason,
  AheadWaitingOn,
  aheadMatterDayOk,
  aheadSenderRefusal,
  type LooksAheadMatter,
  newId,
  zonedInstant,
  zonedParts,
} from '@whombat/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { type AheadMatterRow, aheadMatters, dispatches, messages } from '../db/schema/index';
import { isThePerson } from '../domain/the-person';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { cleanShortLabel } from './store';

/** What the assistant hears when the list is full. */
export const MATTERS_FULL = `Whombat already keeps an eye on ${AHEAD_MATTERS_MAX} things: ask the person to remove one in Settings first.`;
/** What the assistant hears when a title holds nothing Whombat may keep. */
export const MATTER_TITLE_EMPTY = 'Give it a title in a few plain words, without links or addresses.';
/** What the assistant hears when the matter to stop isn't on the list. */
export const MATTER_UNKNOWN = 'That isn’t on the list: call ahead_watch with list for the ids.';

/** The open matters of a Whombat, newest first. */
export async function openMatters(db: Db | Tx, burrowId: string): Promise<AheadMatterRow[]> {
  return db
    .select()
    .from(aheadMatters)
    .where(and(eq(aheadMatters.burrowId, burrowId), eq(aheadMatters.state, 'open')))
    .orderBy(desc(aheadMatters.createdAt), desc(aheadMatters.id));
}

/** One matter, locked for this change, or null. */
export async function matterForUpdate(tx: Tx, burrowId: string, id: string): Promise<AheadMatterRow | null> {
  const [row] = await tx
    .select()
    .from(aheadMatters)
    .where(and(eq(aheadMatters.burrowId, burrowId), eq(aheadMatters.id, id)))
    .for('update');
  return row ?? null;
}

/** A matter as Settings and `ahead_watch` show it. */
export function matterItem(row: AheadMatterRow): LooksAheadMatter {
  return {
    id: row.id,
    title: row.title.slice(0, AHEAD_MATTER_TITLE_MAX),
    ...(row.who ? { who: row.who.slice(0, AHEAD_MATTER_WHO_MAX) } : {}),
    waitingOn: row.waitingOn,
    ...(row.dueAt ? { due: row.dueAt.toISOString() } : {}),
    since: row.createdAt.toISOString(),
    asked: row.origin === 'person',
  };
}

/** `YYYY-MM-DD` of an instant in the Whombat's zone. */
function localDay(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The most of each anchor a follow-up or a matter's mail check is given. */
const ANCHORS_MAX = 5;
/** The longest anchor kept: a longer message id is left out rather than cut into one that isn't. */
const ANCHOR_LONGEST = 200;

/**
 * A matter as a turn reads it, by its number in that turn (`k1`…): its date as a day, when it began as a moment.
 * - `list`: as a triage pass sees it among others: title, who, waiting on, date, asked and since, never its note.
 * - `own`: the matter a mail check or a follow-up is about: its note, when the last news came, why a follow-up runs, and
 *   where to look (`anchors`: its senders and the message ids of the mails its earlier checks were about).
 */
export function matterContext(
  row: AheadMatterRow,
  ref: string,
  timeZone: string,
  own?: { reason?: AheadMatterReason; messageIds?: readonly string[] },
): AheadMatterContext {
  const senders = row.match.senders.filter((s) => s.length <= ANCHOR_LONGEST).slice(0, ANCHORS_MAX);
  const messageIds = [...new Set(own?.messageIds ?? [])]
    .filter((id) => id.length > 0 && id.length <= ANCHOR_LONGEST)
    .slice(0, ANCHORS_MAX);
  return {
    ref,
    title: row.title.slice(0, AHEAD_MATTER_TITLE_MAX),
    ...(row.who ? { who: row.who.slice(0, AHEAD_MATTER_WHO_MAX) } : {}),
    waitingOn: row.waitingOn,
    ...(row.dueAt ? { due: localDay(row.dueAt, timeZone) } : {}),
    asked: row.origin === 'person',
    since: row.createdAt.toISOString(),
    ...(own
      ? {
          ...(row.note ? { note: row.note } : {}),
          lastNews: row.lastNewsAt.toISOString(),
          ...(own.reason ? { reason: own.reason } : {}),
          ...(senders.length || messageIds.length
            ? {
                anchors: {
                  ...(senders.length ? { senders } : {}),
                  ...(messageIds.length ? { messageIds } : {}),
                },
              }
            : {}),
        }
      : {}),
  };
}

/**
 * A matter's date (`YYYY-MM-DD`) as an instant: noon that day in the Whombat's zone. Null when it isn't a real day, or
 * isn't from today to a year ahead (`aheadMatterDayOk`).
 */
export function matterDueAt(day: string | undefined, timeZone: string, now: Date): Date | null {
  if (!day || !aheadMatterDayOk(day, now, timeZone)) return null;
  const [year, month, date] = day.trim().split('-').map(Number) as [number, number, number];
  return zonedInstant({ year, month, day: date }, '12:00', timeZone);
}

/** What the assistant hears when the person's date is no date to follow up by. */
export const MATTER_DATE_REFUSED =
  'That date can’t be used: give one from today to a year ahead as YYYY-MM-DD, or leave it out.';

/**
 * The address a matter a check opened keeps (`notary@example.com`), read from the whole From line when the mail came:
 * never a parse of the cut-down line. Null when there is none, or one too long to keep.
 */
export function senderAddress(address: string | undefined): string | null {
  return address && address.length <= 80 ? address : null;
}

/** Closes a matter that is still open; nothing when it is closed already. Whether it closed now. */
export async function closeMatterIn(
  ctx: ApplyContext,
  row: AheadMatterRow,
  reason: 'done' | 'removed' | 'expired',
): Promise<boolean> {
  if (row.state !== 'open') return false;
  await ctx.tx
    .update(aheadMatters)
    .set({ state: 'closed', closedReason: reason, closedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(aheadMatters.id, row.id), eq(aheadMatters.state, 'open')));
  // Signed without its words: what someone keeps an eye on stays out of the log.
  await ctx.emit({
    type: 'ahead.matter_closed',
    kind: 'System',
    text: null,
    where: null,
    payload: { aheadMatterId: row.id, reason },
  });
  return true;
}

/** The root of a matter's thread when its message is still there, in that conversation; else null. */
export async function matterThreadRoot(
  tx: Pick<Tx, 'select'>,
  row: Pick<AheadMatterRow, 'threadRootId' | 'conversationId'>,
): Promise<{ rootId: string; conversationId: string } | null> {
  if (!row.threadRootId) return null;
  const [msg] = await tx
    .select({ id: messages.id, threadRootId: messages.threadRootId, conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.id, row.threadRootId), isNull(messages.deletedAt)));
  if (!msg || (row.conversationId && msg.conversationId !== row.conversationId)) return null;
  return { rootId: msg.threadRootId ?? msg.id, conversationId: msg.conversationId };
}

/** The triggers that are a person's own message to the assistant: in its direct chat, or naming it. */
const THE_PERSONS_MESSAGE: ReadonlySet<string> = new Set(['dm', 'mention']);
/** How many “Try again”s back a retry is followed to the turn it tries again. */
const RETRIES_FOLLOWED = 5;

/**
 * Whether the turn is the person's own message to the assistant: `dm` or `mention`, or “Try again” on such a turn
 * (followed back through its retries to the turn it tries again, with the same message).
 */
async function personsMessageTurn(
  db: Db | Tx,
  dispatch: Pick<DispatchRow, 'trigger' | 'messageId'> & { retryOfId?: string | null },
): Promise<boolean> {
  let turn = dispatch;
  for (let i = 0; i <= RETRIES_FOLLOWED; i++) {
    if (THE_PERSONS_MESSAGE.has(turn.trigger)) return true;
    if (turn.trigger !== 'retry' || !turn.retryOfId) return false;
    const [before] = await db
      .select({
        trigger: dispatches.trigger,
        messageId: dispatches.messageId,
        retryOfId: dispatches.retryOfId,
      })
      .from(dispatches)
      .where(eq(dispatches.id, turn.retryOfId));
    if (!before || before.messageId !== dispatch.messageId) return false;
    turn = before;
  }
  return false;
}

/**
 * Whether the person began this turn themselves, in their own words: it is for them (not an outsiders' turn), it is
 * their message to the assistant (`personsMessageTurn`; never a Looks ahead check, an automation's step, a scheduled
 * turn or anything else Whombat woke it for), and the message that started it is theirs.
 */
export async function personBeganTurn(
  db: Db | Tx,
  dispatch: Pick<DispatchRow, 'trigger' | 'burrowId' | 'onBehalfOfAccountId' | 'messageId'> & {
    retryOfId?: string | null;
  },
): Promise<boolean> {
  if (!dispatch.onBehalfOfAccountId || !dispatch.messageId) return false;
  if (!(await personsMessageTurn(db, dispatch))) return false;
  const [msg] = await db
    .select({ authorId: messages.authorId, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, dispatch.messageId));
  if (!msg) return false;
  const author = await loadPrincipalRow(db, msg.authorId);
  return (
    author?.kind === 'person' &&
    author.burrowId === dispatch.burrowId &&
    author.accountId === dispatch.onBehalfOfAccountId
  );
}

/** Words to match mail by: trimmed, lowercased, long enough, each once. */
function matchWords(words: readonly string[] | undefined, max: number, longest: number): string[] {
  const out: string[] = [];
  for (const w of words ?? []) {
    const word = w.trim().toLowerCase().slice(0, longest);
    if (word.length >= AHEAD_MATCH_WORD_MIN && !out.includes(word)) out.push(word);
  }
  return out.slice(0, max);
}

/** What the assistant hears when a sender word would match everyone's mail. */
export function commonSenderRefusal(word: string): string {
  return `“${word}” is a public mailbox provider that almost everyone’s mail comes from: give the sender’s full address or their own site, or subject words instead.`;
}

/** What the assistant hears when a sender word is neither an address nor a site. */
export function notSenderRefusal(word: string): string {
  return `“${word}” isn’t a sender’s address or site: give the sender’s full address or their site (the part after the @), or subject words instead.`;
}

/**
 * The person asked the assistant to keep an eye on something in their mail (`ahead_watch` `start`, in their own turn):
 * a matter they own, matched by their own sender and subject words, told in the conversation and thread they asked in.
 * An open one of theirs with the same title is answered instead of a second one; one with the same title a check opened
 * becomes theirs on their terms (told where they asked; their who, waiting on, date, senders and words replace the
 * check's, and its mail threads are kept).
 */
export const startAheadMatter = defineCommand({
  name: 'ahead.matter_start',
  schema: z.object({
    personId: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(AHEAD_MATTER_TITLE_MAX),
    who: z.string().trim().max(AHEAD_MATTER_WHO_MAX).optional(),
    senders: z.array(z.string().max(80)).max(10).default([]),
    words: z.array(z.string().max(40)).max(10).default([]),
    waitingOn: AheadWaitingOn,
    due: z.string().max(10).optional(),
    conversationId: z.string().min(1).max(64),
    threadRootId: z.string().min(1).max(64).nullable(),
  }),
  async apply(tx, ctx, input): Promise<{ matter: AheadMatterRow; created: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant keeps an eye on mail.');
    if (!(await isThePerson(tx, ctx.burrow.id, input.personId)))
      throw forbidden('Only the person asks to keep an eye on something.');
    const title = cleanShortLabel(input.title, AHEAD_MATTER_TITLE_MAX);
    if (!title) throw badRequest(MATTER_TITLE_EMPTY);
    const senders = matchWords(input.senders, AHEAD_MATTER_SENDERS_MAX, 80);
    // Subject words narrow a sender, or match on their own without one (`aheadMatterMatchBy`).
    const words = matchWords(input.words, AHEAD_MATTER_WORDS_MAX, 40);
    for (const sender of senders) {
      const refused = aheadSenderRefusal(sender);
      if (refused === 'public') throw badRequest(commonSenderRefusal(sender));
      if (refused) throw badRequest(notSenderRefusal(sender));
    }
    const dueAt = input.due ? matterDueAt(input.due, ctx.burrow.timeZone, ctx.now) : null;
    if (input.due && !dueAt) throw badRequest(MATTER_DATE_REFUSED);
    const who = cleanShortLabel(input.who, AHEAD_MATTER_WHO_MAX) ?? '';
    const open = await openMatters(tx, ctx.burrow.id);
    const same = open.find((m) => m.title.toLowerCase() === title.toLowerCase());
    if (same?.origin === 'person') return { matter: same, created: false };
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    if (same) {
      // A check already keeps an eye on it: now the person asked, it is theirs, on their terms and told where they
      // asked. The mail threads the check found it in stay; what the mail's sender said about it doesn't.
      const matter: AheadMatterRow = {
        ...same,
        origin: 'person',
        personId: input.personId,
        title,
        who,
        waitingOn: input.waitingOn,
        dueAt,
        conversationId: conversation.id,
        threadRootId: input.threadRootId,
        match: { threads: same.match.threads, senders, words },
        updatedAt: ctx.now,
      };
      await tx
        .update(aheadMatters)
        .set({
          origin: matter.origin,
          personId: matter.personId,
          title: matter.title,
          who: matter.who,
          waitingOn: matter.waitingOn,
          dueAt: matter.dueAt,
          conversationId: matter.conversationId,
          threadRootId: matter.threadRootId,
          match: matter.match,
          updatedAt: ctx.now,
        })
        .where(eq(aheadMatters.id, same.id));
      await ctx.emit({
        type: 'ahead.matter_opened',
        kind: 'System',
        text: 'Started keeping an eye on something in mail',
        where: null,
        payload: { aheadMatterId: same.id, origin: 'person', upgraded: true },
      });
      return { matter, created: false };
    }
    if (open.length >= AHEAD_MATTERS_MAX) throw forbidden(MATTERS_FULL);
    if (!senders.length && !words.length)
      throw badRequest('Say whose mail or which subject words to watch for.');
    const row: AheadMatterRow = {
      id: newId('aheadMatter'),
      burrowId: ctx.burrow.id,
      personId: input.personId,
      origin: 'person',
      title,
      who,
      waitingOn: input.waitingOn,
      dueAt,
      note: null,
      match: { threads: [], senders, words },
      state: 'open',
      closedReason: null,
      conversationId: conversation.id,
      threadRootId: input.threadRootId,
      followedUp: [],
      lastNewsAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      closedAt: null,
    };
    await tx.insert(aheadMatters).values(row);
    await ctx.emit({
      type: 'ahead.matter_opened',
      kind: 'System',
      text: 'Started keeping an eye on something in mail',
      where: null,
      payload: { aheadMatterId: row.id, origin: 'person' },
    });
    return { matter: row, created: true };
  },
});

/** The assistant stops keeping an eye on a matter, as the person asked (`ahead_watch` `stop`). */
export const stopAheadMatter = defineCommand({
  name: 'ahead.matter_stop',
  schema: z.object({ matterId: z.string().min(1).max(64) }),
  async apply(tx, ctx, input): Promise<{ matter: AheadMatterRow }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant stops this.');
    const row = await matterForUpdate(tx, ctx.burrow.id, input.matterId);
    if (row?.state !== 'open') throw new ApiError('not_found', MATTER_UNKNOWN);
    await closeMatterIn(ctx, row, 'removed');
    return { matter: { ...row, state: 'closed', closedReason: 'removed', closedAt: ctx.now } };
  },
});

/** How many matters checks opened since `since` (the day's cap leaves the person's own out). */
export async function mattersOpenedByChecks(tx: Pick<Tx, 'select'>, burrowId: string, since: Date) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aheadMatters)
    .where(
      and(
        eq(aheadMatters.burrowId, burrowId),
        eq(aheadMatters.origin, 'check'),
        sql`${aheadMatters.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return row?.n ?? 0;
}
