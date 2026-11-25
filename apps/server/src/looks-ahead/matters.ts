/**
 * What Looks ahead keeps an eye on (“Keeping an eye on”, docs/decisions/looks-ahead.md): a short list of matters with
 * fixed, scrubbed fields. The person starts one in their own turn (`ahead_watch`), or a mail check does (`ahead_report`'s
 * `matter`, matched only by that mail's thread and sender). Here: reading them, how a turn and Settings see one, its
 * date, closing one, which turn may start one, and the commands `ahead_watch` runs.
 */
import {
  AHEAD_MATTER_TITLE_MAX,
  AHEAD_MATTER_WHO_MAX,
  AHEAD_MATTERS_MAX,
  type AheadMatterContext,
  type AheadMatterReason,
  AheadWaitingOn,
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
import { type AheadMatterRow, aheadMatters, messages } from '../db/schema/index';
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

/** A matter as a turn reads it, by its number in that turn (`k1`…): its date as a day, when it began as a moment. */
export function matterContext(
  row: AheadMatterRow,
  ref: string,
  timeZone: string,
  reason?: AheadMatterReason,
): AheadMatterContext {
  return {
    ref,
    title: row.title.slice(0, AHEAD_MATTER_TITLE_MAX),
    ...(row.who ? { who: row.who.slice(0, AHEAD_MATTER_WHO_MAX) } : {}),
    waitingOn: row.waitingOn,
    ...(row.dueAt ? { due: localDay(row.dueAt, timeZone) } : {}),
    ...(row.note ? { note: row.note } : {}),
    asked: row.origin === 'person',
    since: row.createdAt.toISOString(),
    lastNews: row.lastNewsAt.toISOString(),
    ...(reason ? { reason } : {}),
  };
}

/** A matter's date (`YYYY-MM-DD`) as an instant: noon that day in the Whombat's zone. Null when it isn't a real day. */
export function matterDueAt(day: string | undefined, timeZone: string): Date | null {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return zonedInstant({ year, month, day: date }, '12:00', timeZone);
}

/** The address a mail came from, lowercased (`notary@example.com`), or null when it carries none. */
export function senderAddress(from: string): string | null {
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(from)?.[0] ?? '';
  const lower = address.toLowerCase().trim();
  return lower.length >= 3 && lower.length <= 80 ? lower : null;
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

/** Triggers that are never a turn the person began: Whombat's own checks, automations, and turns the agent scheduled. */
const NOT_THE_PERSONS = new Set(['ahead', 'automation', 'schedule', 'feedback']);

/**
 * Whether the person began this turn themselves, in their own words: it is for them (not an outsiders' turn), it isn't
 * a Looks ahead check, an automation's step or a turn the agent scheduled, and the message that started it is theirs.
 */
export async function personBeganTurn(
  db: Db | Tx,
  dispatch: Pick<DispatchRow, 'trigger' | 'burrowId' | 'onBehalfOfAccountId' | 'messageId'>,
): Promise<boolean> {
  if (!dispatch.onBehalfOfAccountId || NOT_THE_PERSONS.has(dispatch.trigger) || !dispatch.messageId)
    return false;
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

/** Words the person gave to match mail by: trimmed, lowercased, each once. */
function matchWords(words: readonly string[] | undefined, max: number, longest: number): string[] {
  const out: string[] = [];
  for (const w of words ?? []) {
    const word = w.trim().toLowerCase().slice(0, longest);
    if (word.length >= 2 && !out.includes(word)) out.push(word);
  }
  return out.slice(0, max);
}

/**
 * The person asked the assistant to keep an eye on something in their mail (`ahead_watch` `start`, in their own turn):
 * a matter they own, matched by their own sender and subject words, told in the conversation and thread they asked in.
 * An open one with the same title is answered instead of a second one.
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
    const open = await openMatters(tx, ctx.burrow.id);
    const same = open.find((m) => m.title.toLowerCase() === title.toLowerCase());
    if (same) return { matter: same, created: false };
    if (open.length >= AHEAD_MATTERS_MAX) throw forbidden(MATTERS_FULL);
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const senders = matchWords(input.senders, 3, 80);
    // Subject words match only when no sender is given (`aheadMatterMatches`); kept as the person said them.
    const words = matchWords(input.words, 5, 40);
    if (!senders.length && !words.length)
      throw badRequest('Say whose mail or which subject words to watch for.');
    const row: AheadMatterRow = {
      id: newId('aheadMatter'),
      burrowId: ctx.burrow.id,
      personId: input.personId,
      origin: 'person',
      title,
      who: cleanShortLabel(input.who, AHEAD_MATTER_WHO_MAX) ?? '',
      waitingOn: input.waitingOn,
      dueAt: matterDueAt(input.due, ctx.burrow.timeZone),
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
