/**
 * Where an automation's run posts (docs/decisions/chat-channel.md CHT-09, chat-channel-server.md CHT-S…; one-agent.md
 * OA-04, OA-15): the person talks with the agent in their Chat and their Feedback room, so a run whose room is
 * anything else (a channel, a task chat) posts in its publisher's rooms instead — the Feedback room
 * when its recipe assesses reports or issues (`recipe.job === 'assess'`; made when missing), else their Chat. Decided
 * when the run is made (`createRun`), so published versions stay as they are and every step, notice and later run about
 * the same item read one room. A burrow without its agent and a run already in one of the publisher's rooms keep the
 * room they were given.
 */
import { type AutomationDefinition, recipeOf } from '@whombat/core';
import { chatRoomOf } from '../chats/rooms';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import type { TxSession } from '../commit/types';
import { ensurePersonalDm } from '../domain/personal-dm';
import { ensureFeedbackRoom } from '../feedback/chat';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow, toActor } from '../read/principals';

/** Whether a run of this definition posts in the Feedback room rather than Chat: its recipe assesses. */
export function postsInFeedback(definition: AutomationDefinition): boolean {
  return recipeOf(definition)?.job === 'assess';
}

/**
 * The room a new run posts in: `conversationId` when it is one of the publisher's rooms, else the publisher's Feedback
 * room or Chat (see the module comment). In the caller's transaction;
 * a Feedback room made here is signed by the publisher (`chat.started`), as their own save would.
 */
export async function runRoomOf(
  session: TxSession & { now?: Date },
  args: { definition: AutomationDefinition; publishedById: string; conversationId: string },
): Promise<string> {
  const tx = session.tx;
  const publisher = await loadPrincipalRow(tx, args.publishedById);
  if (publisher?.kind !== 'person' || publisher.burrowId !== session.burrowId) return args.conversationId;
  const agent = await loadAgentRow(tx, session.burrowId);
  if (!agent) return args.conversationId;
  const room = await loadConversationRow(tx, args.conversationId);
  if (room && room.dmPersonId === publisher.id && chatRoomOf(room)) return room.id;
  const burrow = await loadBurrowRow(tx, session.burrowId);
  if (!burrow) return args.conversationId;
  const now = session.now ?? session.services.clock();
  const ctx = applyContext(session, {
    burrow,
    actor: toActor(publisher),
    now,
    at: iso(now),
    decision: null,
    requirement: null,
    approvalId: null,
    onBehalfOf: {},
  });
  if (postsInFeedback(args.definition)) return (await ensureFeedbackRoom(ctx, publisher)).conversation.id;
  return ensurePersonalDm(ctx, agent, publisher);
}
