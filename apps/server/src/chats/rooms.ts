/**
 * The person's two rooms with the agent (docs/decisions/chat-channel.md CHT-01…CHT-03; one-agent.md OA-04; one-person.md
 * OP-S72): **Chat**, the default DM (`task_key IS NULL`), and **Feedback**, a `dm` row with the task key `feedback`,
 * titled “Feedback” and never retitled. Both are threaded: the person's top-level message opens a thread and the agent
 * answers in it. A task chat (any other key, from before Chat) stays flat. The person's turns read them; an outsiders'
 * turn never does (OP-17).
 */
import { CHAT_ROOMS, type ChatRoom } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { conversations } from '../db/schema/index';
import type { ConversationRow } from '../read/conversations';

export { CHAT_ROOMS, type ChatRoom };

/** The Feedback room's task key (`conversations_task_idx`). */
export const FEEDBACK_ROOM_KEY = 'feedback';

/** The Feedback room's title on every screen (CHT-03). */
export const FEEDBACK_ROOM_TITLE = 'Feedback';

type RoomRow = Pick<ConversationRow, 'kind' | 'taskKey' | 'dmAgentId' | 'dmPersonId'>;

/** Which of the two rooms a DM row would be by its key alone: null for anything else. */
export function roomByKey(row: Pick<ConversationRow, 'kind' | 'taskKey'>): ChatRoom | null {
  if (row.kind !== 'dm') return null;
  if (row.taskKey === null) return 'chat';
  return row.taskKey === FEEDBACK_ROOM_KEY ? 'feedback' : null;
}

/** Whether a conversation row is the person's Feedback room. */
export function isFeedbackRoom(row: Pick<ConversationRow, 'kind' | 'taskKey'>): boolean {
  return roomByKey(row) === 'feedback';
}

/** Which of the person's rooms a conversation is, or null: their Chat or Feedback room with the agent. */
export function chatRoomOf(row: RoomRow): ChatRoom | null {
  if (!row.dmAgentId || !row.dmPersonId) return null;
  return roomByKey(row);
}

/**
 * Whether the person's top-level message here opens a thread the agent answers in (CHT-02, channel-threads.md CH-01):
 * their Chat or Feedback room.
 */
export function threadedRoom(row: RoomRow): boolean {
  return chatRoomOf(row) !== null;
}

/**
 * Whether a turn for `person` may read a conversation (OP-S72): the person's own room with the agent only in the
 * person's turns (`person` null: an outsiders' turn, OP-17); every other room of the burrow.
 */
export function readsRoom(
  conversation: Pick<ConversationRow, 'kind' | 'dmPersonId'>,
  person: { id: string } | null,
): boolean {
  if (conversation.kind !== 'dm' || !conversation.dmPersonId) return true;
  return person?.id === conversation.dmPersonId;
}

/** The person's Feedback room, if it exists. */
export async function feedbackRoomId(db: Db | Tx, agentId: string, personId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.kind, 'dm'),
        eq(conversations.dmAgentId, agentId),
        eq(conversations.dmPersonId, personId),
        eq(conversations.taskKey, FEEDBACK_ROOM_KEY),
      ),
    );
  return row?.id ?? null;
}
