/**
 * Task chats (one-whombat.md ONE-06; app one-whombat-shell.md AP-1270): the sidebar's “Conversations” and a chat's
 * header. Every chat with Whombat is listed newest first; the default chat (where approval cards and Vault asks land)
 * shows only while it has something unread or is open, so the list is the person's tasks. Pure; web and phone share it.
 */
import type { ChatSummary, Conversation, ThingSummary } from '@whombat/core';
import { formatClock } from '@whombat/core/text';
import { doneWhen } from './time';

export interface ChatRow {
  id: string;
  title: string;
  href: string;
  unread: number;
  selected: boolean;
  /** 600 when selected or unread. */
  bold: boolean;
  default: boolean;
}

/** The sidebar caps its list here; the rest are a search away. */
export const SIDEBAR_CHATS_MAX = 12;

function lastAtOf(c: Pick<ChatSummary, 'lastAt'>): number {
  return c.lastAt ? Date.parse(c.lastAt) : 0;
}

/** The rows of “Conversations”: archived ones left out, the default chat only when unread or open, newest first. */
export function chatRows(
  chats: readonly ChatSummary[],
  selectedId?: string | null,
  max = SIDEBAR_CHATS_MAX,
): ChatRow[] {
  return chats
    .filter((c) => !c.archivedAt && (!c.default || c.unread > 0 || c.id === selectedId))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => lastAtOf(b.c) - lastAtOf(a.c) || a.i - b.i)
    .slice(0, max)
    .map(({ c }) => {
      const selected = c.id === selectedId;
      return {
        id: c.id,
        title: c.title,
        href: `/chats/${c.id}`,
        unread: c.unread,
        selected,
        bold: selected || c.unread > 0,
        default: c.default,
      };
    });
}

/**
 * The default chat's title in a list of chats (Home's Chats, All chats; app home-redesign.md AP-2207): “Your chat with
 * Neo”, where its own title is the assistant's bare name.
 */
export function defaultChatTitle(assistantName: string): string {
  return `Your chat with ${assistantName}`;
}

export interface AllChatRow {
  id: string;
  title: string;
  href: string;
  /** Its last message's time: the clock today, the weekday this week, else the date; empty before any message. */
  when: string;
  /** Its last message's words, when the server sends them. */
  lastText: string | null;
  unread: number;
}

/**
 * All chats (`/chats`, Home's “All chats”; app home-redesign.md AP-2215): every chat with the assistant that isn't
 * archived, newest first, the default one too (as “Your chat with Neo”).
 */
export function allChatRows(
  chats: readonly ChatSummary[],
  now: Date | number,
  timeZone: string,
  assistantName?: string | null,
): AllChatRow[] {
  return chats
    .filter((c) => !c.archivedAt)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => lastAtOf(b.c) - lastAtOf(a.c) || a.i - b.i)
    .map(({ c }) => ({
      id: c.id,
      title: c.default ? defaultChatTitle(assistantName?.trim() || c.title) : c.title,
      href: `/chats/${c.id}`,
      when: c.lastAt ? doneWhen(c.lastAt, now, timeZone) : '',
      lastText: c.lastText?.trim() || null,
      unread: c.unread,
    }));
}

/** The chat's title: its own, else the conversation's (the default chat: Whombat's name). */
export function chatTitle(conversation: Pick<Conversation, 'chat' | 'title'>): string {
  return conversation.chat?.title ?? conversation.title;
}

/**
 * The line under a chat's title: when it started and what it is about. “Started 13:20 · about pve-02”.
 */
export function chatSubline(
  conversation: Pick<Conversation, 'chat' | 'createdAt'>,
  timeZone: string,
): string {
  const started = `Started ${formatClock(conversation.createdAt, timeZone)}`;
  const subject = conversation.chat?.subject;
  return subject ? `${started} · about ${subject.name}` : started;
}

/**
 * The badge beside a chat's title: “Learning a new device” while the chat is about a device Whombat is still learning
 * (its thing is `learning`).
 */
export function chatBadge(
  conversation: Pick<Conversation, 'chat'>,
  things: readonly Pick<ThingSummary, 'id' | 'kind' | 'status'>[] | undefined,
): string | null {
  const subject = conversation.chat?.subject;
  if (subject?.kind !== 'device') return null;
  const thing = things?.find((t) => t.kind === 'device' && t.id === `device:${subject.id}`);
  return thing?.status === 'learning' ? 'Learning a new device' : null;
}

/**
 * The chats list with one chat renamed, archived or brought back (the server's answer, applied at once). A chat whose
 * `archivedAt` is null is not archived (any more); only one that doesn't say keeps what the list had.
 */
export function withChat(
  chats: readonly ChatSummary[],
  conversation: Pick<Conversation, 'id' | 'chat' | 'title'>,
): ChatSummary[] {
  const archivedAt = conversation.chat?.archivedAt;
  return chats.map((c) =>
    c.id === conversation.id
      ? {
          ...c,
          title: conversation.chat?.title ?? c.title,
          archivedAt: archivedAt === undefined ? (c.archivedAt ?? null) : archivedAt,
        }
      : c,
  );
}
