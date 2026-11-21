/**
 * What the agent says while a council or a T3 Code checklist runs: a reply of its own under the card, kept in the
 * thread in order. The card's own line under it is Whombat's short status, which may change; the agent's words never
 * replace each other, so the person can read back what happened (docs/decisions/council.md).
 */
import type { ApplyContext } from '../commit/types';
import { loadConversationRow } from '../read/conversations';
import { postMessage } from './messages';

/**
 * Posts the agent's words in the card's thread. `tell`: the person hears of it (inbox and push) — a milestone such as
 * the end; progress along the way only shows in the thread as new.
 */
export async function postUnderCard(
  ctx: ApplyContext,
  card: { messageId: string | null; conversationId: string; threadRootId?: string | null },
  text: string,
  tell: boolean,
): Promise<string | null> {
  const words = text.trim();
  if (!card.messageId || !words) return null;
  const conversation = await loadConversationRow(ctx.tx, card.conversationId);
  if (!conversation) return null;
  const posted = await postMessage(ctx, {
    conversation,
    text: words,
    // The card's thread: its message may have moved on to the thread's end since (card-move.ts).
    threadRootId: card.threadRootId ?? card.messageId,
    // The agent's own words wake nobody, the agent least of all.
    dispatch: false,
    notify: tell,
    notifyMentions: false,
  });
  return posted.id;
}
