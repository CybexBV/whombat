/**
 * Chat on the phone (Whombat chat-channel.md CHT-01…CHT-11, CHT-22; chat-channel.md AP-2450…): the person's private,
 * threaded room with the agent and the Feedback room beside it. Every top-level message is a thread; sending one
 * opens it. The rooms, their threads, the links and the words shared with the web are `@whombat/client`'s
 * (`useChatRooms`, `useChatThreads`, `threadRows`, `startedChatPath`, `CHAT_WORDS`, `agentWords`); what is here is
 * the phone's own. Pure; the screens are `screens/ChatRoomScreen.tsx`, `screens/SettledScreen.tsx` and the thread's
 * `screens/ThreadScreen.tsx`.
 */
import {
  type AgentWords,
  type ChatRooms,
  startedChatPath,
  type ThreadRow,
  type ThreadStage,
  threadStage,
} from '@whombat/client';
import { type Message, type Principal, parseChatHref } from '@whombat/core';
import type { ThreadWorkView } from './working';

/** The phone's words beside `CHAT_WORDS` and the agent's (`chatPlaceholder`, `chatEmpty`, `lookingIntoIt`). */
export const CHAT_COPY = {
  failed: 'Chat didn’t load.',
  feedbackFailed: 'Feedback didn’t load.',
  settledFailed: 'The settled threads didn’t load.',
  /** The ask sheet's button (“Ask about pve-02”): it starts a thread in Chat. */
  askButton: 'Ask',
  /** Under a thread's first message while the agent works on it: the mock's phone line (its face says who). */
  working: 'Looking into it',
} as const;

/**
 * Where a room's thread stands for its replies row (docs/decisions/chat-threads-cards.md), from its flags: the threads
 * list's `waiting`, `working` and `handedOver`, the root's `settled`. The assistant's own turn there now and work
 * handed to T3 Code count as the flags they are, which the list says a moment later.
 */
export function roomStage(
  flags: { waiting: boolean; working: boolean; handedOver: boolean; settled: Message['settled'] },
  work: ThreadWorkView | null,
): ThreadStage | null {
  return threadStage({
    waiting: flags.waiting,
    working: flags.working || (!!work && !work.by && work.tone === 'live'),
    handedOver: flags.handedOver || work?.by === 't3code',
    settled: flags.settled,
  });
}

/**
 * The Chat tab's badge (AP-2452): what is unread in Chat and in Feedback, which is reached from Chat's header (its own
 * badge says how much of it is Feedback's).
 */
export function chatTabCount(rooms: ChatRooms): number {
  return (rooms.chat?.unread ?? 0) + (rooms.feedback?.unread ?? 0);
}

/** What `chats.start` answers, as much as opening it needs. */
export interface StartedChat {
  conversation: { id: string; title: string; chat?: { title: string } | null | undefined };
  message: Pick<Message, 'id' | 'threadRootId'>;
}

/**
 * The screen a started chat opens (CHT-06, AP-2455), from the shared `startedChatPath`: the new thread in Chat, its
 * “‹ …” naming where it was started; the chat itself when the answer names no thread.
 */
export function startedChatRoute(
  started: StartedChat,
  back: string,
):
  | { name: 'Thread'; params: { messageId: string; back: string } }
  | { name: 'Chat'; params: { conversationId: string; title: string; back: string } } {
  const thread = parseChatHref(startedChatPath(started))?.thread;
  if (thread) return { name: 'Thread', params: { messageId: thread, back } };
  const { conversation } = started;
  return {
    name: 'Chat',
    params: { conversationId: conversation.id, title: conversation.chat?.title || conversation.title, back },
  };
}

/**
 * The thread a Chat link names (`/chat?thread=msg_…`, a hand-over's answer), its “‹ …” naming where it was opened from;
 * null for any other link or none.
 */
export function threadRoute(
  href: string | null | undefined,
  back: string,
): { name: 'Thread'; params: { messageId: string; back: string } } | null {
  const thread = href ? parseChatHref(href)?.thread : null;
  return thread ? { name: 'Thread', params: { messageId: thread, back } } : null;
}

/** `threadWork`'s words while an agent only thinks in a thread. */
const THINKING = 'is thinking';

/**
 * The reply row's work in a room (CHT-02, AP-2458): while the agent thinks in a thread, the mock's “Looking into it”
 * (its face says who; TalkBack hears `lookingIntoIt`, “Neo is looking into it”), also when only the server says it
 * works on the thread (`ChatThread.working`, a turn started before the app was open); a run's progress or a question
 * for the person keeps its own words.
 */
export function roomWork(
  work: ThreadWorkView | null,
  working: boolean,
  agent: Principal | undefined,
  w: AgentWords,
): ThreadWorkView | null {
  const thinking = (base: Pick<ThreadWorkView, 'agent' | 'name'>): ThreadWorkView => ({
    ...base,
    text: THINKING,
    progress: null,
    tone: 'live',
    line: CHAT_COPY.working,
    spoken: w.lookingIntoIt,
  });
  if (work && !work.by) return work.text === THINKING && work.progress === null ? thinking(work) : work;
  // Its own turn there comes before what it handed to T3 Code (t3code-handoff.md AP-6612).
  return working ? thinking({ agent, name: w.Name }) : work;
}

/** A row of the phone's Settled list (CHT-07, AP-2454, AP-6252), from the shared `threadRows`. */
export interface PhoneThreadRow {
  rootId: string;
  /** The first line of the thread's first message. */
  title: string;
  /** “Looking into it”; “4 replies · Last reply 2 min ago”; “Neo · 07:00” for one nobody answered yet. */
  line: string;
  subject: ThreadRow['subject'];
  /** What TalkBack hears for the row. */
  label: string;
}

export function phoneThreadRows(
  rows: readonly ThreadRow[],
  people: { name: (id: string) => string },
  w: AgentWords,
): PhoneThreadRow[] {
  return rows.map((r) => {
    const title = r.text || '…';
    const said = r.replies ? `${r.replies} · ${r.when}` : `${people.name(r.authorId)} · ${r.when}`;
    return {
      rootId: r.rootId,
      title,
      line: r.working ? CHAT_COPY.working : said,
      subject: r.subject,
      label: [title, r.subject ? `about ${r.subject.name}` : null, r.working ? w.lookingIntoIt : said]
        .filter(Boolean)
        .join(', '),
    };
  });
}
