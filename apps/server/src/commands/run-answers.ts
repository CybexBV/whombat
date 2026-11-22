/**
 * A run whose goal waits on a person (docs/decisions/resourceful-agents.md RA-DS62; amends run-checkout.md RC-11). When
 * what is left of a run needs a person to act — an access the agent lacks, a decision — the agent doesn't finish it: it
 * asks them (`asks: true`) and leaves the run live. Then:
 *
 * - `runtime.run_awaits_answer`: after the turn, the run needs a person in the agent's own words (`runs.attention` = the
 *   question), so the run card, run line, run page and Work say what is missing instead of “Done”;
 * - `run_answered`: the next message of the person the run is for, where the run was asked (its card's thread), and
 *   naming its agent or no agent, means the run no longer needs them; `postMessage` then wakes the agent on the run — a
 *   run turn with its checkout, which can finish it — instead of a chat turn without its tools.
 *
 * No contract change: `attention` is CT-197's, `asks` AS-03's, and the wake is an ordinary `mention` / `dm` turn in run
 * mode (as Resume and Try again queue `run_control` ones).
 */
import { DispatchId, MessageId, RunId } from '@whombat/core';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { messages, runs } from '../db/schema/index';
import { ApiError, forbidden } from '../lib/errors';
import { publishRun } from './runs';

/** `Run.attention`'s length (contracts CT-197). */
const ATTENTION_MAX = 280;

/**
 * A question as its run's attention line: its words on one line, without the mentions that open it (“@John To publish
 * it I need …” → “To publish it I need …”) or chat's emphasis and link markup, cut at a word within 280 characters.
 */
export function questionAttention(text: string): string {
  const flat = text
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:@[\p{L}\p{N}_.-]+[,:]?\s+)+/u, '');
  if (flat.length <= ATTENTION_MAX) return flat;
  const cut = flat.slice(0, ATTENTION_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > ATTENTION_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/* runtime.run_awaits_answer ------------------------------------------------------------------------------------- */

/**
 * The turn left its run live and asked a person something it needs (`asks: true`, the caller checked: nothing else is
 * queued or pending): the run needs that person, in the question's words. Signed by the agent, hidden from the log
 * (the question is in the room); the run card, line and page read “Needs attention · …”.
 */
export const awaitAnswer = defineCommand({
  name: 'runtime.run_awaits_answer',
  schema: z.object({ runId: RunId, messageId: MessageId, dispatchId: DispatchId }),
  async apply(tx, ctx, input): Promise<{ attention: string | null }> {
    const [row] = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id || row.agentId !== ctx.actor.id || row.status !== 'live')
      return { attention: null };
    const [question] = await tx
      .select({
        authorId: messages.authorId,
        asks: messages.asks,
        text: messages.text,
        outsidersRun: messages.outsidersRun,
        provenance: messages.provenance,
      })
      .from(messages)
      .where(eq(messages.id, input.messageId));
    if (
      !question ||
      question.authorId !== ctx.actor.id ||
      !question.asks ||
      question.outsidersRun ||
      question.provenance
    )
      return { attention: row.attention };
    const attention = questionAttention(question.text);
    if (!attention || attention === row.attention) return { attention: row.attention };
    await tx.update(runs).set({ attention, updatedAt: ctx.now }).where(eq(runs.id, row.id));
    const event = await ctx.emit({
      type: 'run.waiting',
      kind: 'Code',
      text: null,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, messageId: input.messageId, dispatchId: input.dispatchId },
    });
    await publishRun(ctx, row.id, event.id);
    return { attention };
  },
});

/* run_answered -------------------------------------------------------------------------------------------------- */

/**
 * The live runs that need `personId` (attention set, asked by them) in the place a message of theirs goes: the
 * conversation and the thread of the run's card (RC-14: the thread the run was asked in), or a reply under the card.
 */
export async function runsAwaitingAnswer(
  db: Pick<Db, 'select'>,
  args: { burrowId: string; conversationId: string; threadRootId: string | null; personId: string },
): Promise<{ id: string; agentId: string }[]> {
  const live = await db
    .select({ id: runs.id, agentId: runs.agentId, messageId: runs.messageId })
    .from(runs)
    .where(
      and(
        eq(runs.burrowId, args.burrowId),
        eq(runs.conversationId, args.conversationId),
        eq(runs.status, 'live'),
        eq(runs.askedById, args.personId),
        isNotNull(runs.attention),
      ),
    )
    .orderBy(desc(runs.startedAt));
  if (!live.length) return [];
  const cards = live.flatMap((r) => (r.messageId ? [r.messageId] : []));
  const threadOf = new Map(
    (cards.length
      ? await db
          .select({ id: messages.id, threadRootId: messages.threadRootId })
          .from(messages)
          .where(inArray(messages.id, cards))
      : []
    ).map((m) => [m.id, m.threadRootId]),
  );
  const seen = new Set<string>();
  return live.filter((r) => {
    const here =
      (r.messageId !== null && args.threadRootId === r.messageId) ||
      (threadOf.get(r.messageId ?? '') ?? null) === args.threadRootId;
    // One run per agent: its newest that needs the person here.
    if (!here || seen.has(r.agentId)) return false;
    seen.add(r.agentId);
    return true;
  });
}

/**
 * The person the run waits on answered where it was asked (RA-DS62): the run no longer needs them. Signed by that
 * person, hidden from the log (their message is in the room). `answered: false` when the run moved meanwhile. The
 * caller (the message's dispatch hook) then wakes the agent on the run — a run turn with its checkout and tools, their
 * message as its request — instead of a chat turn.
 */
export const answerRun = defineCommand({
  name: 'run_answered',
  schema: z.object({ runId: RunId, messageId: MessageId }),
  async apply(tx, ctx, input): Promise<{ answered: boolean }> {
    if (ctx.actor.kind !== 'person') throw forbidden('Only a person answers a run.');
    const [row] = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id) throw new ApiError('not_found', 'Run not found.');
    if (row.status !== 'live' || !row.attention || row.askedById !== ctx.actor.id) return { answered: false };
    await tx.update(runs).set({ attention: null, updatedAt: ctx.now }).where(eq(runs.id, row.id));
    const event = await ctx.emit({
      type: 'run.answered',
      kind: 'Code',
      text: null,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, messageId: input.messageId },
    });
    await publishRun(ctx, row.id, event.id);
    return { answered: true };
  },
});
