/**
 * Chat and Feedback (Whombat chat-channel.md CHT-01…CHT-11; contracts 0.93.0 CT-440…CT-446; app chat-channel.md
 * AP-2400…): the person's two rooms with their assistant, which shell draws them, their names and the links into them.
 * Pure; web and phone share it.
 */
import {
  type ChatRoom,
  type ChatSummary,
  CONNECTIONS_HREF,
  chatSummaryRoom,
  chatThreadHref,
  DASHBOARD_HREF,
  type Message,
  parseChatHref,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { CHAT_AREA_WORDS } from '../i18n/messages/chatWork/chat';

/**
 * What every screen calls the places (CHT-01, CHT-03, CHT-11; AP-2401), in a locale (English when none). The
 * `dashboard` place is called Overview (sidebar-tabs.md): it holds the servers and the connections, so “Connections”
 * keeps meaning only what is connected.
 */
export function chatWords(locale?: string | null) {
  const w = clientTree(locale, CHAT_AREA_WORDS).rooms;
  return {
    chat: w.chat,
    feedback: w.feedback,
    /** Chat's head's way to Feedback, with its unread count, for a screen reader. */
    feedbackUnread: (n: number) => interpolate(w.feedbackUnread, { n }),
    dashboard: w.dashboard,
    newThread: w.newThread,
    /** Chat's button and page for a new question where two pages show (app iphone-duo.md AP-6300). */
    newChat: w.newChat,
    /** A thread's reply box (the mock's “Reply…”). */
    reply: w.reply,
    /** A Chat thread's reply box on the web, where the composer names who answers. */
    replyTo: (name: string) => interpolate(w.replyTo, { name }),
    /** Chat's head while there is a file to see (files-space.md FS-07). */
    files: w.files,
    /** Under a message whose question still waits for the person, and the button that goes to it. */
    waiting: w.waiting,
    answer: w.answer,
    /** The Feedback room before its first report. */
    feedbackEmpty: w.feedbackEmpty,
  };
}

/** What every screen calls the places, in English. */
export const CHAT_WORDS = chatWords();

/** One of the rooms as the shell reads it from `chats.list`: its conversation, its unread count. */
export interface ChatRoomRef {
  room: ChatRoom;
  /** The conversation (`cnv_…`). */
  id: string;
  title: string;
  unread: number;
  lastAt: string | null;
}

export interface ChatRooms {
  /** The person's Chat (their default DM); null until `chats.list` has answered. */
  chat: ChatRoomRef | null;
  /** Their Feedback room once one of their integrations or automations points at it (CHT-03); else null. */
  feedback: ChatRoomRef | null;
}

/**
 * The Chat and the Feedback room among the chats list's rows (`ChatSummary.room`, CT-441; `chatSummaryRoom` reads an
 * older server's default chat as the Chat). Archived rows are left out; task chats are not rooms.
 */
export function chatRoomsOf(chats: readonly ChatSummary[] | undefined, locale?: string | null): ChatRooms {
  const words = locale ? chatWords(locale) : CHAT_WORDS;
  const find = (room: ChatRoom): ChatRoomRef | null => {
    const s = chats?.find((c) => !c.archivedAt && chatSummaryRoom(c) === room);
    return s ? { room, id: s.id, title: words[room], unread: s.unread, lastAt: s.lastAt ?? null } : null;
  };
  return { chat: find('chat'), feedback: find('feedback') };
}

/** Which room a conversation is (`chat`, `feedback`), or null for anything else. */
export function roomOfConversation(
  rooms: ChatRooms,
  conversationId: string | null | undefined,
): ChatRoom | null {
  if (!conversationId) return null;
  if (rooms.chat?.id === conversationId) return 'chat';
  if (rooms.feedback?.id === conversationId) return 'feedback';
  return null;
}

/** Where a `chats.start` answer opens (CHT-06, CHT-21; AP-2406): its new thread beside Chat (`/chat?thread=<root>`). */
export function startedChatPath(started: {
  conversation: { id: string };
  message: Pick<Message, 'id' | 'threadRootId'>;
}): string {
  return chatThreadHref('chat', started.message.threadRootId ?? started.message.id);
}

/**
 * An old task-chat address in the Chat shell (`/chats`, `/chats/<id>`; CHT-21, AP-2403): the Feedback room's id opens
 * `/feedback`, anything else `/chat`. `thread` (a `?thread=` it carried) stays on it.
 */
export function chatRedirectPath(rooms: ChatRooms, id: string | null, thread?: string | null): string {
  const room: ChatRoom = id && rooms.feedback?.id === id ? 'feedback' : 'chat';
  return thread ? chatThreadHref(room, thread) : room === 'feedback' ? '/feedback' : '/chat';
}

/** Where the Chat shell's places are (AP-2401): `/chat`, `/feedback`, `/connections` (`/dashboard` before, AP-2501). */
export const CHAT_SHELL_PATHS = {
  chat: '/chat',
  feedback: '/feedback',
  dashboard: CONNECTIONS_HREF,
} as const;

/**
 * A link of the Chat shell (`/chat`, `/feedback`, `/connections`, with or without `?thread=`), for the phone's link
 * routing and the web's: what it opens, or null for any other path (AP-2404). `/dashboard`, in older messages, opens
 * Connections too (AP-2501).
 */
export type ChatShellLink = { place: 'room'; room: ChatRoom; thread: string | null } | { place: 'dashboard' };

export function parseChatShellLink(href: string): ChatShellLink | null {
  const room = parseChatHref(href);
  if (room) return { place: 'room', room: room.room, thread: room.thread };
  const path = href.split(/[?#]/)[0]?.replace(/(.)\/$/, '$1');
  return path === CONNECTIONS_HREF || path === DASHBOARD_HREF ? { place: 'dashboard' } : null;
}
