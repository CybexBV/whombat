/**
 * Website feedback in a room with the agent (docs/decisions/less-is-more.md LM-01, LM-F01…; contracts CT-383;
 * chat-channel.md CHT-03; one-agent.md OA-16). An integration's reports go to the person's **Feedback room**: one
 * `dm` row with the task key `feedback`, titled “Feedback” and never retitled, where every integration posts (each
 * report is a thread). The integration's `channel_id` names it. Before Chat each integration had its own task chat
 * (“Website feedback · <name>”, key `fb-<id>`, `feedbackChatKey`); those still read as destinations.
 */
import { conversationLabel, type FeedbackIntegrationChat, feedbackChatTitle, newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { FEEDBACK_ROOM_KEY, FEEDBACK_ROOM_TITLE, feedbackRoomId, isFeedbackRoom } from '../chats/rooms';
import type { ApplyContext } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { conversations } from '../db/schema/index';
import { publishConversation } from '../domain/members';
import { postMessage } from '../domain/messages';
import { ensurePersonalDm } from '../domain/personal-dm';
import { agentContext } from '../guides/place';
import { conflict } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow, type PrincipalRow } from '../read/principals';

/** The most characters of a conversation slug (`Conversation.slug`). */
const SLUG_MAX = 120;

/** What refuses a chat for someone without an assistant (as `start_chat` says it). */
export const NO_ASSISTANT_TEXT = 'This Whombat’s agent isn’t ready yet. Try again in a moment.';

/** The task key of an integration's chat from before the Feedback room: one per integration. */
export function feedbackChatKey(integrationId: string): string {
  return `fb-${integrationId.replace(/^fbi_/, '')}`;
}

/**
 * Whether a conversation is where this integration's reports may go in the assistant shell: a Feedback room, or its
 * own chat from before Chat (a task chat with its key).
 */
export function isFeedbackChat(
  row: Pick<ConversationRow, 'kind' | 'taskKey'>,
  integrationId: string,
): boolean {
  return isFeedbackRoom(row) || (row.kind === 'dm' && row.taskKey === feedbackChatKey(integrationId));
}

/**
 * Where an integration's reports go, if they can: a channel of this burrow, or a Feedback room (its own chat from before
 * Chat) while its assistant is still active (a retired assistant's chats are closed, EP-05). Null otherwise (gone, a DM,
 * a branch room, someone else's task chat).
 */
export async function destinationOf(
  db: Db | Tx,
  burrowId: string,
  conversationId: string,
  integrationId: string,
): Promise<ConversationRow | null> {
  const row = await loadConversationRow(db, conversationId);
  if (!row || row.burrowId !== burrowId) return null;
  if (!isFeedbackChat(row, integrationId) || !row.dmAgentId) return null;
  const agent = await loadPrincipalRow(db, row.dmAgentId);
  return agent ? row : null;
}

/** How the audit log and the assessor's texts name a destination: “#reports”, or the chat's title. */
export function destinationLabel(row: ConversationRow): string {
  return row.kind === 'dm' && row.taskKey !== null ? (row.chatTitle ?? row.title) : conversationLabel(row);
}

/** The agent a person talks to (one-agent.md OA-01): the burrow's one agent, or null before it exists. */
export async function activeAssistantOf(
  db: Db | Tx,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
): Promise<PrincipalRow | null> {
  return (await loadAgentRow(db, person.burrowId)) ?? null;
}

/**
 * The person's Feedback room with their assistant (CHT-03), made when missing (in the caller's commit): titled
 * “Feedback”, already named, so nobody retitles it; both are members; a signed `chat.started` (`room: feedback`),
 * published like any new chat. The person's Chat (the default DM) exists too (PA-06). Refused while the person has no
 * active assistant.
 */
export async function ensureFeedbackRoom(
  ctx: ApplyContext,
  person: PrincipalRow,
): Promise<{ conversation: ConversationRow; agent: PrincipalRow; created: boolean }> {
  const agent = await activeAssistantOf(ctx.tx, person);
  if (!agent) throw conflict(NO_ASSISTANT_TEXT);
  const existing = await feedbackRoomId(ctx.tx, agent.id, person.id);
  const found = existing ? await loadConversationRow(ctx.tx, existing) : undefined;
  if (found) return { conversation: found, agent, created: false };
  await ensurePersonalDm(ctx, agent, person);
  const id = newId('conversation');
  await ctx.tx.insert(conversations).values({
    id,
    burrowId: ctx.burrow.id,
    kind: 'dm',
    slug: `${agent.handle}--${person.handle}--${FEEDBACK_ROOM_KEY}`.slice(0, SLUG_MAX),
    title: agent.name,
    topic: '',
    dmAgentId: agent.id,
    dmPersonId: person.id,
    taskKey: FEEDBACK_ROOM_KEY,
    chatTitle: FEEDBACK_ROOM_TITLE,
    chatRetitledAt: ctx.now,
    createdAt: ctx.now,
  });
  const event = await ctx.emit({
    type: 'chat.started',
    kind: 'System',
    text: null,
    where: agent.name,
    aboutId: agent.id,
    payload: { conversationId: id, agentId: agent.id, room: 'feedback' },
  });
  await publishConversation(ctx, id, event.id);
  const conversation = await loadConversationRow(ctx.tx, id);
  if (!conversation) throw conflict('The Feedback room couldn’t be made.');
  return { conversation, agent, created: true };
}

/**
 * The chat's title follows the integration's new name while it is still the one Whombat gave it (LM-F11): a title the
 * person chose stays. A signed `chat.renamed`, published like a rename.
 */
export async function retitleFeedbackChat(
  ctx: ApplyContext,
  row: ConversationRow,
  before: { name: string },
  after: { name: string },
): Promise<void> {
  const was = feedbackChatTitle(before.name);
  const title = feedbackChatTitle(after.name);
  if (title === was || row.chatTitle !== was || isFeedbackRoom(row)) return;
  await ctx.tx.update(conversations).set({ chatTitle: title }).where(eq(conversations.id, row.id));
  const event = await ctx.emit({
    type: 'chat.renamed',
    kind: 'System',
    text: null,
    where: title,
    payload: { conversationId: row.id, byFeedback: true },
  });
  await publishConversation(ctx, row.id, event.id);
}

/** A feedback chat that was archived comes back to the person's list (a new report is something to look at). */
export async function reopenFeedbackChat(ctx: ApplyContext, row: ConversationRow): Promise<void> {
  if (row.kind !== 'dm' || !row.chatArchivedAt) return;
  await ctx.tx.update(conversations).set({ chatArchivedAt: null }).where(eq(conversations.id, row.id));
  const event = await ctx.emit({
    type: 'chat.unarchived',
    kind: 'System',
    text: null,
    where: destinationLabel(row),
    payload: { conversationId: row.id, byFeedback: true },
  });
  await publishConversation(ctx, row.id, event.id);
}

/** `FeedbackIntegration.chat` of an integration row: the person's Feedback room and whose it is. */
export async function integrationChatOf(
  db: Db | Tx,
  row: { id: string; channelId: string },
): Promise<FeedbackIntegrationChat | null> {
  const conversation = await loadConversationRow(db, row.channelId);
  if (!conversation || !isFeedbackChat(conversation, row.id)) return null;
  if (!conversation.dmPersonId) return null;
  return { id: conversation.id };
}

/**
 * What the agent says in the Feedback room when an integration starts posting there (LM-F05, CHT-03): where the reports
 * come from (the integration by the name the person gave it) and that it looks at each one. Plain words, no ids
 * (concise-replies.md).
 */
export function chatIntroText(settings: { name: string }): string {
  return `Reports from “${settings.name}” will show up here. I’ll look at each one and tell you what I find.`;
}

/**
 * The agent's line for an integration that starts posting in the room (`chatIntroText`), in the caller's commit. It
 * wakes nobody; `notify` tells the person (not when they just saved the settings themselves).
 */
export async function introduceChat(
  ctx: ApplyContext,
  conversation: ConversationRow,
  agent: PrincipalRow,
  row: { settings: Parameters<typeof chatIntroText>[0] },
  options: { notify: boolean },
): Promise<void> {
  await postMessage(agentContext(ctx, agent), {
    conversation,
    text: chatIntroText(row.settings),
    threadRootId: null,
    mentions: [],
    dispatch: false,
    notifyDmPerson: options.notify,
  });
}
