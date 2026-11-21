/**
 * Task chat titles and subjects (docs/decisions/one-whombat.md ONE-06; contracts CT-337: `chatTitleFrom`,
 * `chatSubjectLine`, `CHAT_TITLE_MAX`). Pure.
 */
import {
  CHAT_TITLE_MAX,
  type ChatRoom,
  type ChatSubject,
  chatSubjectLine,
  chatThreadSubjectLine,
  chatTitleFrom,
  thingId,
} from '@whombat/core';

export { CHAT_TITLE_MAX, type ChatSubject, chatTitleFrom };

/** Longest stored subject name (`ChatSubject.name`). */
export const CHAT_SUBJECT_NAME_MAX = 120;

/** A title someone gave (a rename, Whombat's better one), as a chat title: one line, at most 60 characters. */
export function clipTitle(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  return one ? chatTitleFrom(one) : 'New chat';
}

/** What the subject's lines tell the agent: what it is about, and the thing's id for `pin_widget` (CP-14) and `watch_checks`. */
function subjectLines(subject: ChatSubject | null, where: 'chat' | 'thread'): string[] {
  if (!subject) return [];
  return [
    where === 'thread' ? chatThreadSubjectLine(subject) : chatSubjectLine(subject),
    `Its page is ${thingId(subject.kind, subject.id)}: pin_widget’s thingId to keep a widget there, watch_checks’s thing for what Whombat watches on it.`,
  ];
}

/**
 * The dispatch context's topic for a task chat: its title and, with a subject, what it is about (for the agent), with
 * the thing's id for `pin_widget` so a widget asked for on its page stays there (connection-pages.md CP-14).
 */
export function chatTopic(title: string | null, subject: ChatSubject | null): string {
  return [title ? `Task chat “${title}”.` : 'Task chat.', ...subjectLines(subject, 'chat')].join(' ');
}

/**
 * The topic of a turn in a person's Chat or Feedback room (docs/decisions/chat-channel.md CHT-05): whose room it is
 * and, in a thread about something, what the thread is about (“Chat with Mara. This thread is about the server
 * pve-02.”). For the agent only.
 */
export function roomTopic(room: ChatRoom, person: string, subject: ChatSubject | null): string {
  const head =
    room === 'chat'
      ? `Chat with ${person}: each of their questions is a thread.`
      : `Feedback with ${person}: each report is a thread.`;
  return [head, ...subjectLines(subject, 'thread')].join(' ');
}
