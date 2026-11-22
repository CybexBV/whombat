/**
 * What an outsiders' turn sees of what Whombat posted for the person in its thread (docs/decisions/outsiders-turns.md):
 * an approval card only as one line that says the person was asked and what they answered, and what a
 * `connection_actions` step posted — its “Done:” line, a notice about how its calls went — only as one line that says
 * Whombat told the person. Never what the server read from the person's services and connections for them: the names
 * of the ids an action names, paths with their account ids filled in, labels, addresses or the services' answers. The
 * same rule holds for every way such a turn reads its thread: its context and `read_conversation`.
 */
import type { ApprovalState, Message } from '@whombat/core';
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
  return messages.map((m) => {
    if (told.has(m.id)) return asLine(m, OUTSIDERS_ACTIONS_LINE);
    const card = m.card?.kind === 'approval' ? m.card : null;
    if (card) return asLine(m, OUTSIDERS_CARD_LINE[card.approval.state]);
    // A card kept from before it moved (card-moves.md) is never an approval's; one that is reads as the line too.
    if (m.earlierCard?.kind === 'approval') return asLine(m, OUTSIDERS_CARD_LINE[m.earlierCard.approval.state]);
    return m;
  });
}
