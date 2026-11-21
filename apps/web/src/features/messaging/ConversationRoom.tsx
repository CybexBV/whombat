import { composerMentionTargets, SETTLE_WORDS, type ThreadWork, type WorkLine } from '@whombat/client';
import { isOptimisticMessage } from '@whombat/client/query';
import { useTheAgent } from '@whombat/client/react';
import {
  type ChatRuntime,
  type ConversationDetail,
  type ConversationKind,
  canAskForMore,
  conversationLinkPreviewsOn,
  type Message,
  type Principal,
  type Reaction,
  replySuggestions,
  suggestionMessage,
} from '@whombat/core';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOptionalAppServices } from '../../app/providers';
import { useSearchUpdate } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { SkeletonRows } from '../../components/ListState';
import { MessageCard } from '../cards';
import { CardLookContext } from '../cards/cardLook';
import { RanOnMarkedProvider } from '../chats/runtime/RanOn';
import { CreatePlanModal, type CreatePlanSource } from '../plans';
import { useComposerPrompts } from '../prompts/useComposerPrompts';
import { useSaveAsPrompt } from '../prompts/useSaveAsPrompt';
import { Composer } from './Composer';
import styles from './ConversationRoom.module.css';
import { DeliveryState } from './DeliveryState';
import { draftKey, readDraft, useDraft } from './drafts';
import { MessageList } from './MessageList';
import { LinkPreviewsShown, MessageEditor } from './MessageParts';
import { MoreDetail } from './MoreDetail';
import { useMessageUrl } from './messageLink';
import { leaveConversation, usePendingDeletes } from './pendingDeletes';
import { QuickReplies } from './QuickReplies';
import { CARD_BUTTON, requestCardFocus, requestReplyFocus } from './replyFocus';
import { useTypingStop } from './StopTurnButton';
import { unreadStart } from './unreadDivider';
import { useFileDrop } from './useFileDrop';
import { useMessageActions } from './useMessageActions';
import { useBurrowContext, useNow, useRoomMessages, useSend, useTypingLines } from './useRoom';
import { useSkillCommands } from './useSkillCommands';
import { useStableCallback } from './useStableCallback';
import { useThreadWork } from './useThreadWork';
import { useUploads } from './useUploads';

/** Unsent drafts survive switching conversations and reloads (WX-05, `drafts.ts`). */
export { clearDrafts } from './drafts';

/** The pill over the newest messages when they arrive below the reader (WX-07). */
export const NEW_MESSAGES_PILL = 'New messages ↓';

export interface ConversationRoomProps {
  burrow: string;
  detail: ConversationDetail;
  /** `data-screen` of the section (`dm`, `branch`). */
  screen: string;
  /** The person's own room with the agent (`dm`: Chat, Feedback, a task chat) or a branch room. */
  kind: ConversationKind;
  header: ReactNode;
  /** Branch room tabs, under the header. */
  tabs?: ReactNode;
  /** Replaces the message list (the branch room's Files changed tab); the composer stays. */
  body?: ReactNode;
  /** "Message #billing-v2", "Comment on PR #482", "Message Dusty". */
  placeholder: string;
  /** What the room is called (“Chat”, `feat/invoice-pdf`): its list's label and a plan's place. */
  label: string;
  /** Shown when the conversation has no messages; `fill` puts text in the composer (DM suggestions). */
  renderEmpty?: (fill: (text: string) => void) => ReactNode;
  /** Under the newest message (the #general welcome, AP-99). */
  footer?: ReactNode;
  /** Id of the scrolling body (the branch room tabs point at it with `aria-controls`). */
  scrollId?: string;
  /** In place of the composer: an archived channel's line (AP-472). */
  readOnly?: ReactNode;
  /** False: no composer at all (the branch room's file view, which takes the whole room, AP-666). */
  composer?: boolean;
  /** Who the `@` list offers (default: everyone in the Whombat, AP-462). */
  mentionables?: readonly Principal[];
  /** The composer's hint beside the tools (default: the mock's “Agents act when you mention them”). */
  composerHint?: string;
  /** A note under the composer for the draft as typed (a direct conversation's `DIRECT_AGENTS_HINT`, AP-462). */
  draftNote?: (draft: string) => string | null;
  /**
   * `chat`: a task chat with Whombat (mock 3; one-whombat-shell.md AP-1260) — the centred 880px column, 34px faces, one
   * message per author run, and the one-row composer with a round send button.
   */
  look?: 'room' | 'chat';
  /** Chat and Feedback: a room where every top-level message is a thread (`ThreadedRoom`, chat-channel.md AP-2404). */
  threaded?: ThreadedRoom;
}

/**
 * A room where every top-level message starts a thread (Chat, Feedback; Whombat chat-channel.md CHT-02; app
 * chat-channel.md AP-2404…AP-2406): each root its own row with its face and whole name, the open thread's root marked, a
 * root's subject chip after its text, “Neo is looking into it” under a root while the assistant works on it, and a
 * top-level message sent opens its thread.
 */
export interface ThreadedRoom {
  /** The root whose thread is open beside the room. */
  selectedId: string | null;
  /** A root's subject chip, or null (keep it stable: rows are memoized). */
  chip: (message: Message) => ReactNode;
  /** The assistant works on this thread as the room's open threads say (`ChatThread.working`), live or not. */
  working: (rootId: string) => boolean;
  /**
   * The thread has something the person hasn't read (Whombat thread-unread.md): a dot on its reply row. Keep it stable
   * while nothing changes: rows are memoized.
   */
  isNew?: (rootId: string) => boolean;
  /**
   * Something in the thread waits for the person (`ChatThread.waiting`: an approval, a question, a sign-in): “Waiting
   * for you” and Answer under its first message. Keep it stable while nothing changes: rows are memoized.
   */
  waiting?: (rootId: string) => boolean;
  /**
   * Work handed over from the thread still goes on (`ChatThread.handedOver`, or a T3 Code thread from it not ended):
   * “Handed over” on its reply row. Keep it stable while nothing changes: rows are memoized.
   */
  handedOver?: (rootId: string) => boolean;
  /**
   * What goes on from a thread (a council, a checklist, T3 Code; `threadWorkLine`): its line under the reply row, in
   * place of “Handed over”. Keep it stable while nothing changes: rows are memoized.
   */
  workLine?: (rootId: string) => WorkLine | null;
  /** Who looks into the threads: the person's assistant. */
  assistantId: string | null;
  /** The assistant's name (the name helper's), for “Neo is working”. */
  assistantName?: string;
  /** A top-level message went through (the server's message): its thread opens. */
  onSent: (message: Message) => void;
  /**
   * What answers in Chat (chat-runtime.md AP-2684, AP-2690): the composer's button, and the choice a top-level message
   * carries (`chatStartRuntime`; undefined: the assistant's own).
   */
  runtimeTool?: ReactNode;
  runtime?: ChatRuntime;
  /**
   * Settling threads (chat-settle.md AP-6150, AP-6251): settled threads leave the room for Settled, an open root that
   * may settle has “Settle thread” first in its toolbar and menu, a settled one “Open again” in its menu.
   */
  settle?: RoomSettle;
}

export interface RoomSettle {
  /** The root may settle now: open, the assistant isn't working on it and nothing in it waits (CHS-03). */
  settleable: (rootId: string) => boolean;
  onSettle: (message: Message) => void;
  onOpenAgain: (message: Message) => void;
}

/** What “is thinking” says under a thread's first message in a threaded room (the mock's words, AP-2405). */
export const LOOKING_INTO_IT = 'is looking into it';

/**
 * A conversation: header, optional tabs, the scrolling message column and the composer. Live through
 * `conv:<id>`; opens with the newest message in view and follows new ones while the reader is at the
 * bottom.
 */
export function ConversationRoom({
  burrow,
  detail,
  screen,
  kind,
  header,
  tabs,
  body,
  placeholder,
  label,
  renderEmpty,
  footer,
  scrollId,
  readOnly,
  composer = true,
  mentionables,
  composerHint,
  draftNote,
  look = 'room',
  threaded,
}: ConversationRoomProps) {
  const conversationId = detail.conversation.id;
  const { lookup, principals, me, timeZone } = useBurrowContext(burrow);
  // Who `@Name` can mean, for its case (AP-607): the active people and the agent.
  const mentionList = useMemo(() => principals.filter((p) => p.kind !== 'system'), [principals]);
  // The edit box corrects `@banjo ` to `@Banjo ` as the composer does (AP-607).
  const mentionTargets = useMemo(() => composerMentionTargets(principals, me?.id), [principals, me?.id]);
  const now = useNow(60_000);
  const room = useRoomMessages(burrow, detail);
  const openTiming = useOptionalAppServices()?.openTiming;
  useEffect(() => {
    if ((screen === 'chat' || screen === 'feedback') && !room.loading && !room.error)
      openTiming?.mark('content');
  }, [screen, room.loading, room.error, openTiming]);
  // A message deleted with Undo waiting is out of the list already (WX-09); leaving the room sends the delete.
  const hidden = usePendingDeletes();
  const messages = useMemo(
    () => (hidden.size ? room.messages.filter((m) => !hidden.has(m.id)) : room.messages),
    [room.messages, hidden],
  );
  useEffect(() => () => leaveConversation(conversationId), [conversationId]);
  const { lines: typing } = useTypingLines(conversationId, null, lookup);
  // Stop after “Neo is thinking”, for whoever may (WX-10).
  const typingAction = useTypingStop(burrow, conversationId, lookup, me);
  // Who works in which thread, for the reply rows (AP-735); in a threaded room the assistant “is looking into it”
  // while it thinks there or the open threads say it works on it (AP-2405).
  const liveWork = useThreadWork(burrow, conversationId);
  const working = threaded?.working;
  const assistantId = threaded?.assistantId ?? null;
  const threadWork = useCallback(
    (rootId: string): ThreadWork | null => {
      const work = liveWork(rootId);
      if (!working) return work;
      if (work?.text === 'is thinking') return { ...work, text: LOOKING_INTO_IT };
      // Its own turn there comes before what it handed to T3 Code (t3code-handoff.md AP-6612).
      if ((work && !work.by) || !assistantId || !working(rootId)) return work;
      return { agentId: assistantId, text: LOOKING_INTO_IT, progress: null, tone: 'live' };
    },
    [liveWork, working, assistantId],
  );
  // `/` offers the agent's skills (SL-09): asked for once a draft starts with `/`; in the person's own rooms at once,
  // since `/ command` shows only when there is something behind it (WX-08). There the agent is addressed without a
  // mention (OA-07).
  const ownRoom = kind === 'dm';
  const { agent } = useTheAgent(burrow);
  const [skillsAsked, setSkillsAsked] = useState(ownRoom);
  const skillState = useSkillCommands(burrow, skillsAsked);
  const skills = skillState.skills;
  const sender = useSend({
    burrow,
    conversationId,
    principals,
    meId: me?.id,
    skills,
    agentId: ownRoom ? (agent?.id ?? null) : null,
    onSent: threaded?.onSent,
  });
  const uploads = useUploads(burrow, conversationId);
  const updateSearch = useSearchUpdate();
  // “Make a plan” from a message's menu (work-supervision WS-09).
  const [planFrom, setPlanFrom] = useState<CreatePlanSource | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [focusKey, setFocusKey] = useState<number | undefined>(undefined);
  // A thread opens full width, in a channel (AP-670), a DM or a task chat too (AP-2415); its collapse button shows it
  // beside the conversation. Chat and Feedback threads are full width without it (the shell's pane, AP-2415).
  const threadFocus = threaded ? undefined : (1 as const);
  const openThread = useStableCallback(
    (id: string) =>
      void updateSearch((s) => ({
        ...s,
        thread: id,
        focus: threadFocus,
        plan: undefined,
        step: undefined,
        plans: undefined,
        pins: undefined,
        settled: undefined,
      })),
  );
  // The person's prompts after `/` and “Save as prompt”, in their Chat only (prompts-web.md). A prompt used here starts
  // a thread, which opens as a sent message's does.
  const promptsHere = screen === 'chat' && ownRoom;
  const onPromptPosted = useStableCallback(({ rootId }: { rootId: string }) => openThread(rootId));
  const offer = useComposerPrompts({
    burrow,
    conversationId: promptsHere ? conversationId : null,
    onPosted: onPromptPosted,
  });
  const saveAsPrompt = useSaveAsPrompt(burrow, me?.id, promptsHere && offer.available);
  const replyInThread = useStableCallback((id: string) => {
    requestReplyFocus(id);
    openThread(id);
  });
  // Answer under a question that waits: its card where it shows in the room, else its thread at the card.
  const answer = useStableCallback((m: Message) => {
    const button = document
      .getElementById(m.id)
      ?.querySelector<HTMLElement>(`[data-message-card] ${CARD_BUTTON}`);
    if (button) {
      button.scrollIntoView({ block: 'center', behavior: 'smooth' });
      button.focus({ preventScroll: true });
      return;
    }
    requestCardFocus(m.id);
    openThread(m.id);
  });
  const threadHref = useCallback(
    (m: Message) => `?thread=${encodeURIComponent(m.id)}${threadFocus ? '&focus=1' : ''}`,
    [threadFocus],
  );
  // The toolbar, the menu, reactions, edit, pin and delete (docs/decisions/essentials-messages.md AP-440…).
  const settle = threaded?.settle;
  const actions = useMessageActions({
    burrow,
    where: label,
    place: 'room',
    onReplyInThread: replyInThread,
    // “Settle thread” or “Open again” first on a thread's first message (AP-6150); none while it works or waits.
    leadItems: (m) => {
      if (!settle || m.threadRootId) return [];
      if (m.settled) return [{ label: SETTLE_WORDS.openAgain, onSelect: () => settle.onOpenAgain(m) }];
      return settle.settleable(m.id)
        ? [{ label: SETTLE_WORDS.settleThread, onSelect: () => settle.onSettle(m) }]
        : [];
    },
    onEditDone: () => setFocusKey(Date.now()),
    linkOf: useMessageUrl(burrow, detail, lookup),
    extraItems: (m) => {
      const save = saveAsPrompt.item(m);
      return [
        {
          label: 'Make a plan',
          onSelect: () => {
            setPlanFrom({ messageId: m.id, text: m.text });
            setPlanOpen(true);
          },
        },
        ...(save ? [save] : []),
      ];
    },
  });

  // The draft is kept per burrow and conversation, across reloads (WX-05).
  const key = draftKey(burrow, conversationId);
  const [draft, setDraft] = useDraft(key);

  const topLevel = useMemo(() => messages.filter((m) => !m.threadRootId), [messages]);

  /* Where reading stopped (WX-07): fixed when the first page arrives, from the read marker the room opened with. */
  const [openedWith] = useState(() => ({ lastReadId: detail.lastReadMessageId, unread: room.unread }));
  const loaded = !room.loading;
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once, when the first page is in
  const unreadFrom = useMemo(
    () =>
      loaded
        ? unreadStart({
            messages: topLevel,
            lastReadId: openedWith.lastReadId,
            viewerId: me?.id,
            hasOlder: room.hasOlder,
            unread: openedWith.unread,
          })
        : null,
    [loaded],
  );

  /* Scrolling ------------------------------------------------------------------------------------ */
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const positioned = useRef(false);
  const firstId = useRef<string | undefined>(undefined);
  const lastId = useRef<string | undefined>(undefined);
  const heightBefore = useRef(0);
  const observedHeight = useRef(0);
  const count = messages.length;
  const oldest = messages[0]?.id;
  const newest = messages.at(-1);
  // The first message that arrived below the reader while they read further up: the pill takes them there (WX-07).
  const [unseen, setUnseen] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new typing line also follows the bottom
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || body) return;
    if (!positioned.current && count > 0) {
      positioned.current = true;
      const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
      const divider = el.querySelector<HTMLElement>('[data-unread-divider]');
      if (target && el.contains(target)) {
        // A message's link (WX-06, AP-445): there, highlighted for a moment.
        target.scrollIntoView({ block: 'center' });
        flash(target);
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      } else if (divider && offsetIn(el, divider) + el.clientHeight < el.scrollHeight - 120) {
        // More unread than fits: open where reading stopped, the rest under the pill (WX-07).
        el.scrollTop = Math.max(0, offsetIn(el, divider) - 24);
        atBottom.current = false;
        if (unreadFrom) setUnseen(unreadFrom);
      } else el.scrollTop = el.scrollHeight;
    } else if (firstId.current && oldest !== firstId.current && heightBefore.current) {
      // Older history was prepended: keep the reader where they were.
      el.scrollTop += el.scrollHeight - heightBefore.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (newest && lastId.current && newest.id !== lastId.current && newest.authorId !== me?.id) {
      // Someone wrote while the reader is further up: the pill says so instead of moving them (WX-07).
      const after = messages.findIndex((m) => m.id === lastId.current);
      const first = messages[after + 1];
      if (first) setUnseen((u) => u ?? first.id);
    }
    firstId.current = oldest;
    lastId.current = newest?.id;
    heightBefore.current = el.scrollHeight;
    observedHeight.current = el.scrollHeight;
  }, [count, oldest, newest?.id, typing.length, body]);

  // Images and text previews load after their message: a reader at the bottom stays there. Judged against
  // the height before the change (a replaced optimistic message can fire a stale scroll event first).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    observedHeight.current = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      // The height the last change left (also set when the room positions itself, so a room opened at the divider or
      // a linked message isn't judged against its empty first frame and pulled to the bottom).
      const wasAtBottom = observedHeight.current - el.scrollTop - el.clientHeight < 120;
      observedHeight.current = el.scrollHeight;
      if (positioned.current && (wasAtBottom || atBottom.current)) {
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    heightBefore.current = el.scrollHeight;
    if (atBottom.current && unseen) setUnseen(null);
  };

  /** The pill: to the first message that came in below (its top near the top), or the bottom when it's close. */
  const toUnseen = () => {
    const el = scrollRef.current;
    if (!el) return;
    const target = unseen ? document.getElementById(unseen) : null;
    const top = target && el.contains(target) ? offsetIn(el, target) - 24 : null;
    const bottom = el.scrollHeight - el.clientHeight;
    el.scrollTo({ top: top !== null && top < bottom ? top : bottom, behavior: 'smooth' });
    setUnseen(null);
  };

  /* Sending -------------------------------------------------------------------------------------- */
  const submit = async (text: string) => {
    const previous = draft;
    const files = uploads.readyIds;
    // What answers a new thread in Chat goes with it (CT-469, AP-2684).
    const route = threaded?.runtime ? { runtime: threaded.runtime } : {};
    setDraft('');
    atBottom.current = true;
    setUnseen(null);
    const ok = await sender.submit(text, files, route);
    // Sent files leave the composer; after a refusal the draft and the files stay for another try.
    if (ok) uploads.clearSent(files);
    else if (!readDraft(key)) setDraft(previous);
  };

  /* Dropping files anywhere on the room attaches them. ------------------------------------------- */
  const drop = useFileDrop(uploads.pick);
  /* Quick replies (RM-05): under the agent's newest message; a tap sends without touching the draft. */
  const quick = replySuggestions(messages, me?.id, (id) => lookup(id)?.kind === 'agent');
  const pick = useStableCallback((text: string) => {
    if (!quick) return;
    const author = lookup(quick.authorId);
    atBottom.current = true;
    void sender.submit(suggestionMessage(text, author?.name ?? '', ownRoom || !author));
  });
  const quickId = quick?.messageId;
  const quickSuggestions = quick?.suggestions;
  // Null for a row with nothing under it, so the memoized row isn't rendered again (WX-01).
  const renderAfter = useCallback(
    (m: Message) => {
      const optimistic = isOptimisticMessage(m);
      const more = canAskForMore(m, lookup(m.authorId), me);
      const replies = quickSuggestions && m.id === quickId;
      if (!optimistic && !more && !replies) return null;
      return (
        <>
          {optimistic && <DeliveryState message={m} onResend={sender.resend} />}
          {more && <MoreDetail burrow={burrow} messageId={m.id} />}
          {replies && <QuickReplies suggestions={quickSuggestions} onPick={pick} disabled={sender.sending} />}
        </>
      );
    },
    [burrow, lookup, me, quickId, quickSuggestions, pick, sender.resend, sender.sending],
  );

  // In Chat a guide card at the top answers into its own thread: the thread opens so the next step is in view.
  const roomThreads = !!threaded;
  const renderCard = useCallback(
    (m: Message, inside?: readonly Message[]) =>
      m.card ? (
        <MessageCard
          burrow={burrow}
          card={m.card}
          messageId={m.id}
          conversationId={m.conversationId}
          nested={inside}
          attachments={m.attachments}
          authorId={m.authorId}
          {...(roomThreads && !m.threadRootId && m.card.kind === 'guide'
            ? { onGuideActed: () => openThread(m.id) }
            : {})}
        />
      ) : null,
    [burrow, roomThreads, openThread],
  );

  const editingId = actions.editingId;
  const editPending = actions.editPending;
  const editError = actions.editError;
  const renderEditor = useCallback(
    (m: Message) =>
      m.id === editingId ? (
        <MessageEditor
          initial={m.text}
          mentionTargets={mentionTargets}
          allowEmpty={m.attachments.length > 0}
          pending={editPending}
          error={editError}
          onSave={(text) => actions.saveEdit(m, text)}
          onCancel={actions.cancelEdit}
        />
      ) : null,
    [editingId, editPending, editError, mentionTargets, actions.saveEdit, actions.cancelEdit],
  );
  const onReact = useStableCallback((m: Message, r: Reaction) => actions.toggleReaction(m, r.value));
  const selectedId = threaded?.selectedId ?? null;
  const chipOf = threaded?.chip;
  const isNew = threaded?.isNew;
  const waiting = threaded?.waiting;
  const handedOver = threaded?.handedOver;
  const assistantName = threaded?.assistantName;
  const workLine = threaded?.workLine;
  // Where each thread stands, from its flags: the assistant works on it while the open threads say so or its own turn
  // there is live (the room's reads see it before the list does).
  const flags = useCallback(
    (rootId: string) => {
      const work = liveWork(rootId);
      return {
        working: !!working?.(rootId) || (!!work && !work.by && work.agentId === assistantId),
        handedOver: !!handedOver?.(rootId) || work?.by === 't3code',
      };
    },
    [liveWork, working, assistantId, handedOver],
  );
  const settleable = settle?.settleable;
  const onSettle = useStableCallback((m: Message) => settle?.onSettle(m));
  const listSettle = useMemo(() => (settleable ? { settleable, onSettle } : null), [settleable, onSettle]);
  const threadedList = useMemo(
    () =>
      chipOf
        ? {
            selectedId,
            chip: chipOf,
            settle: listSettle,
            isNew,
            waiting,
            onAnswer: waiting ? answer : undefined,
            flags,
            workLine,
            ...(assistantName ? { assistant: assistantName } : {}),
          }
        : null,
    [selectedId, chipOf, listSettle, isNew, waiting, answer, flags, assistantName, workLine],
  );
  // `/ command` shows only with skills behind it (there are no other commands; WX-08): it goes once the agent's skills
  // have answered with none, not while they load or when they couldn't be read.
  const commandTool = !skillState.known || skills.length > 0 || !!offer.prompts;

  return (
    // A channel with link previews off hides the cards its messages already have (EC-23; AP-1101).
    <LinkPreviewsShown.Provider value={conversationLinkPreviewsOn(detail.conversation)}>
      <CardLookContext.Provider value={look}>
        <section
          className={styles.room}
          data-screen={screen}
          data-look={look === 'chat' ? 'chat' : undefined}
          aria-label={label}
          {...drop.handlers}
        >
          {drop.dragging && (
            <div className={styles.dropZone} aria-hidden="true">
              <p>Drop files to attach them</p>
            </div>
          )}
          {header}
          {tabs}
          <div className={styles.scrollArea}>
            <div
              ref={scrollRef}
              id={scrollId}
              className={styles.scroll}
              onScroll={onScroll}
              data-conversation-scroll=""
            >
              {body ?? (
                <RanOnMarkedProvider burrow={burrow} enabled={look === 'chat'}>
                  <MessageList
                    messages={messages}
                    lookup={lookup}
                    timeZone={timeZone}
                    now={now}
                    renderCard={renderCard}
                    renderAfter={renderAfter}
                    onReact={onReact}
                    threadHref={threadHref}
                    onOpenThread={openThread}
                    onMenu={actions.onMenu}
                    menuOpenId={actions.menuOpenId}
                    onReplyInThread={replyInThread}
                    pickerOpenId={actions.pickerOpenId}
                    look={look}
                    meId={me?.id ?? null}
                    threaded={threadedList}
                    renderEditor={renderEditor}
                    typing={typing}
                    typingAction={typingAction}
                    threadWork={threadWork}
                    unreadFrom={unreadFrom}
                    after={room.loading ? null : footer}
                    empty={
                      !room.loading && renderEmpty
                        ? renderEmpty((text) => {
                            setDraft(text);
                            setFocusKey(Date.now());
                          })
                        : null
                    }
                    before={
                      room.hasOlder ? (
                        <button
                          type="button"
                          className={styles.older}
                          disabled={room.loadingOlder}
                          onClick={() => void room.loadOlder()}
                        >
                          {room.loadingOlder ? 'Loading…' : 'Load earlier messages'}
                        </button>
                      ) : null
                    }
                  />
                </RanOnMarkedProvider>
              )}
            </div>
            {unseen && !body && (
              <button type="button" className={styles.newPill} onClick={toUnseen} data-new-messages="">
                {NEW_MESSAGES_PILL}
              </button>
            )}
          </div>
          {actions.elements}
          {saveAsPrompt.element}
          <CreatePlanModal
            burrow={burrow}
            conversationId={conversationId}
            open={planOpen}
            onOpenChange={setPlanOpen}
            source={planFrom}
            onCreated={(plan) =>
              void updateSearch((s) => ({
                ...s,
                plan: plan.id,
                step: undefined,
                thread: undefined,
                plans: undefined,
              }))
            }
          />
          {!composer
            ? null
            : (readOnly ?? (
                <Composer
                  placeholder={placeholder}
                  value={draft}
                  onValueChange={(v) => {
                    setDraft(v);
                    if (sender.notice) sender.clearNotice();
                    if (offer.notice) offer.clearNotice();
                    if (!skillsAsked && v.startsWith('/')) setSkillsAsked(true);
                  }}
                  onSubmit={(text) => void submit(text)}
                  mentionables={mentionables ?? mentionList}
                  viewerId={me?.id}
                  commandTool={commandTool}
                  onPickFiles={uploads.pick}
                  attachments={uploads.attachments}
                  onRemoveAttachment={uploads.remove}
                  onRetryAttachment={uploads.retry}
                  notice={sender.notice ?? offer.notice ?? draftNote?.(draft) ?? null}
                  focusKey={focusKey}
                  skills={skills}
                  prompts={offer.prompts}
                  hint={composerHint}
                  onEditLast={() => actions.editLast(messages)}
                  variant={look === 'chat' ? 'chat' : 'composer'}
                  runtimeTool={threaded?.runtimeTool ?? null}
                  burrow={burrow}
                  voiceKey={`room:${conversationId}`}
                />
              ))}
        </section>
      </CardLookContext.Provider>
    </LinkPreviewsShown.Provider>
  );
}

/** Where `child` starts inside the scrolling `el`, in its scroll coordinates. */
function offsetIn(el: HTMLElement, child: HTMLElement): number {
  return child.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/** Highlights a row a link opened, for a moment (the pins pane's highlight, AP-445). */
function flash(el: HTMLElement) {
  el.setAttribute('data-flash', '');
  window.setTimeout(() => el.removeAttribute('data-flash'), 1600);
}

export interface RoomStatusProps {
  screen: string;
  /** Omit while loading: an empty header frame plus skeleton rows shows, so nothing jumps when the room arrives. */
  title?: string;
  message?: string;
  /** Retries the failed request; omitted while loading. */
  onRetry?: () => void;
  /** Another way on than Retry (Join a public channel, AP-465). */
  action?: ReactNode;
}

/** Loading and not-found/error states of a conversation, in the room's own frame (TODO 16.4). */
export function RoomStatus({ screen, title, message, onRetry, action }: RoomStatusProps) {
  return (
    <section className={styles.room} data-screen={screen} aria-busy={title ? undefined : true}>
      {title ? (
        <div className={styles.state}>
          <h1 className={styles.stateTitle}>{title}</h1>
          {message && <p>{message}</p>}
          {action}
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className={styles.statePlaceholder} />
          <SkeletonRows count={6} avatarSize={36} lines={2} className={styles.stateSkeleton} />
        </>
      )}
    </section>
  );
}
