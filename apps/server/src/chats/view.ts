/**
 * A task chat's contract views (`Conversation.chat`, CT-337) and the turn's topic, from its row. No imports of the read
 * models, so `toConversation` can use it without a cycle.
 */
import type { ChatSubject, ConversationChat } from '@whombat/core';
import type { conversations, messages } from '../db/schema/index';
import { iso } from '../lib/time';
import { chatTopic } from './title';

type ConversationRow = typeof conversations.$inferSelect;

export function chatSubjectOf(
  row: Pick<ConversationRow, 'chatSubjectKind' | 'chatSubjectId' | 'chatSubjectName'>,
): ChatSubject | undefined {
  if (!row.chatSubjectKind || !row.chatSubjectId) return undefined;
  return { kind: row.chatSubjectKind, id: row.chatSubjectId, name: row.chatSubjectName ?? row.chatSubjectId };
}

/** What a thread is about, from its first message (`Message.subject`, chat-channel.md CHT-05); undefined: nothing. */
export function messageSubjectOf(
  row: Pick<typeof messages.$inferSelect, 'subjectKind' | 'subjectId' | 'subjectName'>,
): ChatSubject | undefined {
  if (!row.subjectKind || !row.subjectId) return undefined;
  return { kind: row.subjectKind, id: row.subjectId, name: row.subjectName ?? row.subjectId };
}

/** `Conversation.chat` of a task chat; undefined for every other conversation (the default DM included). */
export function chatOf(row: ConversationRow): ConversationChat | undefined {
  if (row.kind !== 'dm' || row.taskKey === null) return undefined;
  const subject = chatSubjectOf(row);
  return {
    title: (row.chatTitle ?? row.title).slice(0, 60),
    ...(subject ? { subject } : {}),
    ...(row.chatArchivedAt ? { archivedAt: iso(row.chatArchivedAt) } : {}),
  };
}

/** The dispatch context's topic for a task chat (title and subject, for the agent); null for any other conversation. */
export function chatContextTopic(row: ConversationRow): string | null {
  if (row.kind !== 'dm' || row.taskKey === null) return null;
  const subject = chatSubjectOf(row);
  return chatTopic(row.chatTitle, subject ?? null);
}
