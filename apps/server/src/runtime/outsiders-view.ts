/**
 * What an outsiders' turn sees of what Whombat posted for the person in its thread (docs/decisions/outsiders-turns.md):
 * a card only as one line that says what kind of card it was — an approval card as one that says the person was asked
 * and what they answered —, and what a `connection_actions` step posted — its “Done:” line, a notice about how its
 * calls went — only as one line that says Whombat told the person. Never what the server read from the person's
 * services and connections for them: the names of the ids an action names, paths with their account ids filled in,
 * labels, addresses or the services' answers, nor what a plan, run, job or other card the person asked for in that
 * thread says. The same rule holds for every way such a turn reads its thread: its context and `read_conversation`.
 */
import type { ApprovalState, Message, MessageCard } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automationRunSteps } from '../db/schema/index';

/** What an outsiders' turn reads of an approval card, by its state. */
export const OUTSIDERS_CARD_LINE: Readonly<Record<ApprovalState, string>> = {
  pending: 'Whombat asked the person for a yes here. They haven’t answered yet.',
  approved: 'Whombat asked the person for a yes here. They said yes.',
  declined: 'Whombat asked the person for a yes here. They said no.',
};

/** What an outsiders' turn reads of what a `connection_actions` step told the person. */
export const OUTSIDERS_ACTIONS_LINE = 'Whombat told the person how the changes they were asked about went.';

/**
 * What each other card is, as an outsiders' turn reads it: one line with only its kind. Every kind is named here, so a
 * new card kind can't reach such a turn whole. A Feedback report's card is the outsider's own report (it starts the
 * assessment's thread, with their screenshots), so it is kept.
 */
const CARD_WORDS: Readonly<Record<Exclude<MessageCard['kind'], 'approval' | 'report'>, string>> = {
  plan: 'a plan',
  research: 'research',
  run: 'a run',
  review: 'a code review',
  commits: 'a list of commits',
  pill: 'a status',
  answer: 'an answer',
  digest: 'a digest',
  guide: 'a step of a guide',
  turn_failed: 'a note that a turn didn’t finish',
  assessment: 'an assessment',
  schedule: 'a scheduled turn',
  deploy: 'a deploy',
  device_skill: 'a device skill',
  task: 'a server task',
  automation_plan: 'a plan for an automation',
  look_plan: 'a plan for something that needs a look',
  feature_request: 'a feature request',
  council: 'a council',
  delegation: 'work handed to T3 Code',
};

/** What an outsiders' turn reads of a message with a card (or a job's result) of `kind`. */
export function outsidersCardLine(kind: keyof typeof CARD_WORDS | 'job_result'): string {
  return `Whombat showed the person a card here: ${kind === 'job_result' ? 'the result of work handed to T3 Code' : CARD_WORDS[kind]}.`;
}

/** `message` as one plain line of Whombat's: nothing of it but who posted it, where and when. */
function asLine<M extends Message>(message: M, text: string): M {
  const {
    card: _card,
    earlierCard: _earlier,
    movedCard: _moved,
    previews: _previews,
    jobResult: _job,
    vaultSaved: _vault,
    more: _more,
    ...kept
  } = message;
  return { ...kept, text, card: null, more: null, suggestions: [], attachments: [] } as unknown as M;
}

/** The ids of `ids` that a `connection_actions` step posted, or that were posted about how it went. */
async function actionsStepMessages(db: Db, ids: readonly string[]): Promise<ReadonlySet<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ messageIds: automationRunSteps.messageIds })
    .from(automationRunSteps)
    .where(
      and(
        eq(automationRunSteps.kind, 'connection_actions'),
        sql`${automationRunSteps.messageIds} && ${sql.param([...ids])}::text[]`,
      ),
    );
  return new Set(rows.flatMap((r) => r.messageIds).filter((id) => ids.includes(id)));
}

/** `messages` as an outsiders' turn may read them (see the module's comment), in the same order. */
export async function forOutsiders<M extends Message>(db: Db, messages: readonly M[]): Promise<M[]> {
  const told = await actionsStepMessages(
    db,
    messages.map((m) => m.id),
  );
  return messages.map((m) => outsidersMessage(m, told.has(m.id)));
}

/** One message as an outsiders' turn reads it; `told`: a `connection_actions` step posted it or it was posted about one. */
export function outsidersMessage<M extends Message>(m: M, told: boolean): M {
  if (told) return asLine(m, OUTSIDERS_ACTIONS_LINE);
  // A card kept from before it moved (card-moves.md) reads as the card it was.
  const card = m.card ?? m.earlierCard ?? null;
  if (card?.kind === 'approval') return asLine(m, OUTSIDERS_CARD_LINE[card.approval.state]);
  if (card && card.kind !== 'report') return asLine(m, outsidersCardLine(card.kind));
  if (m.movedCard) return asLine(m, outsidersCardLine(m.movedCard.kind));
  if (m.jobResult) return asLine(m, outsidersCardLine('job_result'));
  return m;
}
