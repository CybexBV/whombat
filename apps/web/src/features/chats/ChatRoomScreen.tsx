import { useRouterState } from '@tanstack/react-router';
import { WhombatAvatar } from '@whombat/avatars/react';
import {
  agentFaceOf,
  CHAT_WORDS,
  INBOX_WORDS,
  type InboxFilter,
  inboxCounts,
  inboxFiltered,
  inboxRows,
  nextRootAfter,
  type InboxRow as Row,
  rowStep,
  SETTLE_WORDS,
} from '@whombat/client';
import {
  useChatRooms,
  useChatThreads,
  useHandoffs,
  useTheAgent,
  useThreadUnread,
} from '@whombat/client/react';
import { type ChatRoom, shortNameOf } from '@whombat/core';
import { ArrowLeft, Check, ChevronRight, SquarePen } from 'lucide-react';
import { type MouseEvent, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalAppServices } from '../../app/providers';
import { useSearchUpdate } from '../../app/routing/navigation';
import type { RoomSearch } from '../../app/routing/search';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { NotificationsOffer } from '../../push/NotificationsOffer';
import { AppLink } from '../files/AppLink';
import { RoomStatus } from '../messaging/ConversationRoom';
import roomStyles from '../messaging/ConversationRoom.module.css';
import { requestCardFocus } from '../messaging/replyFocus';
import { useFileDrop } from '../messaging/useFileDrop';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { useStableCallback } from '../messaging/useStableCallback';
import { useThreadWork } from '../messaging/useThreadWork';
import styles from './ChatRoomScreen.module.css';
import { InboxRow } from './InboxRow';
import { setInboxOrder, useInboxSplit } from './inboxNav';
import { useTopRuntime } from './runtime/useChatRuntimeTool';
import { useInboxComposer } from './useInboxComposer';
import { useSettle } from './useSettle';
import { useThreadMarks } from './useThreadMarks';

export interface ChatRoomScreenProps {
  burrow: string;
  /** `chat` (`/chat`) or `feedback` (`/feedback`). */
  room: ChatRoom;
}

/** Two rows that read the same. */
function sameRow(a: Row, b: Row): boolean {
  return (Object.keys(b) as (keyof Row)[]).every((k) => a[k] === b[k]);
}

/** How close to the list's end the next page is asked for. */
const MORE_WITHIN_PX = 240;

/** What the New chat button and its page are called: “New chat”, and “New thread” in Feedback. */
function newChatTitle(room: ChatRoom): string {
  return room === 'chat' ? CHAT_WORDS.newChat : CHAT_WORDS.newThread;
}

/**
 * Chat and the Feedback room as an inbox (Whombat chat-inbox.md CIB-01…CIB-11; app chat-inbox-web.md): one row per open
 * thread (its icon, title and up to two lines of the newest reply), newest activity first, with filters (All, Unread,
 * Waiting) and Settled at their end, Settle and Mark as unread on each row. The list has no message box: one round New
 * chat button floats over its lower right corner and opens the room's new chat (`?new=1`), the assistant's face, what
 * it is for and the box. On a wide screen the open thread (`?thread=`, the shell's pane) sits beside the list, and
 * the new chat while no thread is open; narrower, either takes the list's place with its back link. The head keeps
 * Feedback (from Chat, with its count).
 */
export function ChatRoomScreen({ burrow, room }: ChatRoomScreenProps) {
  const rooms = useChatRooms(burrow);
  const ref = rooms[room];
  const conversationId = ref?.id ?? null;
  const { words, agent: assistant } = useTheAgent(burrow);
  const threads = useChatThreads(burrow, room, {
    conversationId: conversationId ?? undefined,
    enabled: !!ref,
    state: 'open',
  });
  const unread = useThreadUnread(burrow, room, !!ref);
  // Clear chats settles what can settle on the server (Whombat chat-inbox.md CIB-13), so the open list is the inbox.
  const listed = threads.threads;
  const search = useRouterState({ select: (s) => s.location.search }) as RoomSearch;
  const updateSearch = useSearchUpdate();
  const openId = search.thread ?? null;
  const fresh = !!search.new;
  const { me, lookup, timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const split = useInboxSplit();
  // What answers the next question (chat-runtime.md CR-01, CR-02): Chat only.
  const top = useTopRuntime(burrow, room === 'chat');
  const resetRuntime = top.reset;
  // Feedback opens from Chat's head (it has no sidebar row of its own), with its unread count.
  const feedback = room === 'chat' ? rooms.feedback : null;
  // Work that still goes on from a thread: the assistant's own turn as it happens (before the list says so), a run,
  // or what it handed to T3 Code. Such a thread shows Working and doesn't settle.
  const handoffs = useHandoffs(burrow, conversationId ?? undefined);
  const liveWork = useThreadWork(burrow, conversationId ?? undefined);
  const busy = useMemo(
    () =>
      new Set([
        ...threads.threads.filter((t) => t.handedOver).map((t) => t.rootId),
        ...handoffs.flatMap((h) => (h.rootId && h.state !== 'ended' ? [h.rootId] : [])),
      ]),
    [threads.threads, handoffs],
  );
  const known = !threads.isLoading && !threads.error;
  const agentId = assistant?.id ?? null;
  // A row that didn't change keeps its object, so its memoized line isn't drawn again on every realtime event.
  const lastRows = useRef(new Map<string, Row>());
  const rows = useMemo(() => {
    const made = inboxRows(listed, unread, {
      me: me?.id,
      agentId,
      agentName: words.name,
      nameOf: (id) => {
        const who = lookup(id);
        return who ? shortNameOf(who) : null;
      },
      now,
      timeZone,
      openRootId: openId,
    });
    const before = lastRows.current;
    const next = new Map<string, Row>();
    const out = made.map((r) => {
      const working = r.working || busy.has(r.rootId) || !!liveWork(r.rootId);
      const settleable = r.settleable && !busy.has(r.rootId) && !working;
      const row = { ...r, working, settleable };
      const was = before.get(r.rootId);
      const kept = was && sameRow(was, row) ? was : row;
      next.set(r.rootId, kept);
      return kept;
    });
    lastRows.current = next;
    return out;
  }, [listed, unread, me?.id, agentId, words.name, lookup, now, timeZone, openId, busy, liveWork]);

  const [filter, setFilter] = useState<InboxFilter>('all');
  const shown = useMemo(() => inboxFiltered(rows, filter), [rows, filter]);
  const counts = useMemo(() => inboxCounts(rows), [rows]);
  // The open thread's own Settle opens the one under it in the list as shown.
  useEffect(
    () =>
      setInboxOrder(
        room,
        shown.map((r) => r.rootId),
      ),
    [room, shown],
  );

  const openTiming = useOptionalAppServices()?.openTiming;
  useEffect(() => {
    if (known) openTiming?.mark('content');
  }, [known, openTiming]);

  const listRef = useRef<HTMLDivElement>(null);
  const focusRow = useCallback((rootId: string | null) => {
    if (!rootId) return;
    // After the list has drawn the change (a settled row leaves it first).
    requestAnimationFrame(() => {
      const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-root-id]') ?? [])].find(
        (el) => el.dataset.rootId === rootId,
      );
      const link = row?.querySelector<HTMLElement>('[data-inbox-row]');
      link?.focus();
      link?.scrollIntoView?.({ block: 'nearest' });
    });
  }, []);

  const openThread = useCallback(
    (rootId: string | null) =>
      void updateSearch((s) => ({
        ...s,
        thread: rootId ?? undefined,
        focus: undefined,
        settled: undefined,
        new: undefined,
        plan: undefined,
        step: undefined,
        plans: undefined,
        pins: undefined,
      })),
    [updateSearch],
  );
  const onOpen = useCallback(
    (row: Row, event: MouseEvent<HTMLAnchorElement>) => {
      // Enter on the row already open beside the list goes into its thread, to the reply box.
      if (row.rootId === openId && event.detail === 0) {
        document.querySelector<HTMLElement>('aside[aria-label="Thread"] [data-composer] textarea')?.focus();
        return;
      }
      // A thread that waits opens at what it waits for when it takes the whole screen (the list stays in reach).
      if (row.waiting && !split) requestCardFocus(row.rootId);
      openThread(row.rootId);
    },
    [openId, split, openThread],
  );

  const { settle } = useSettle(burrow);
  const settleRow = useCallback(
    (row: Row) => {
      const focused = !!document.activeElement?.closest(`[data-root-id="${row.rootId}"]`);
      const next = nextRootAfter(shown, row.rootId);
      settle(room, row.rootId);
      // Settling the open thread opens the next one beside the list, as archiving mail does; narrower, the list shows.
      if (row.rootId === openId) openThread(split ? next : null);
      if (focused || row.rootId === openId) focusRow(next);
    },
    [shown, settle, room, openId, split, openThread, focusRow],
  );
  const marks = useThreadMarks(burrow);
  const markUnread = useCallback(
    (row: Row) => {
      if (!conversationId) return;
      marks.markUnread({ conversationId, rootId: row.rootId });
      // An open thread reads itself: it closes, so the mark stays.
      if (row.rootId === openId) {
        openThread(null);
        focusRow(row.rootId);
      }
    },
    [conversationId, marks, openId, openThread, focusRow],
  );
  const markRead = useCallback(
    (row: Row) => conversationId && marks.markRead({ conversationId, rootId: row.rootId }),
    [conversationId, marks],
  );

  // The New chat button (and N): the room's new chat with the cursor in its box. Beside the list it closes the open
  // thread; narrower it takes the list's place, with its own address so Back returns to the list.
  const [asked, setAsked] = useState(0);
  const startNew = useCallback(() => {
    setAsked((n) => n + 1);
    void updateSearch((s) => ({
      ...s,
      new: 1,
      thread: undefined,
      focus: undefined,
      settled: undefined,
      plan: undefined,
      step: undefined,
      plans: undefined,
      pins: undefined,
    }));
  }, [updateSearch]);

  // J/K (and ↓/↑) move, E settles, U marks as unread (or read), N starts a new chat, while the list or nothing has the
  // focus and no text field does. Beside the list a move opens the thread; narrower it only moves the focus, Enter opens.
  const keys = useRef({
    shown,
    openId,
    split,
    fresh,
    settleRow,
    markUnread,
    markRead,
    openThread,
    focusRow,
    startNew,
  });
  keys.current = {
    shown,
    openId,
    split,
    fresh,
    settleRow,
    markUnread,
    markRead,
    openThread,
    focusRow,
    startNew,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const k = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (!['j', 'k', 'e', 'u', 'n', 'ArrowDown', 'ArrowUp'].includes(k)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const list = listRef.current;
      if (!list || !target) return;
      if (target !== document.body && !list.contains(target)) return;
      if (target.closest('textarea, input, select, [contenteditable="true"], [role="listbox"]')) return;
      const s = keys.current;
      // The new chat in the list's place: the list isn't on screen, so its keys rest.
      if (s.fresh && !s.split) return;
      if (k === 'n') {
        event.preventDefault();
        s.startNew();
        return;
      }
      const current =
        (target.closest<HTMLElement>('[data-root-id]')?.dataset.rootId ?? null) || s.openId || null;
      if (k === 'j' || k === 'k' || k === 'ArrowDown' || k === 'ArrowUp') {
        const step = k === 'j' || k === 'ArrowDown' ? 1 : -1;
        const next = rowStep(s.shown, current, step);
        event.preventDefault();
        if (!next) return;
        if (s.split) s.openThread(next);
        s.focusRow(next);
        return;
      }
      const row = s.shown.find((r) => r.rootId === current);
      if (!row) return;
      event.preventDefault();
      if (k === 'e') {
        if (row.settleable && known) s.settleRow(row);
        return;
      }
      if (!row.markable) return;
      if (row.unread > 0) s.markRead(row);
      else s.markUnread(row);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [known]);

  // The rows' own handlers keep their identity, so a row is drawn again only when it changes.
  const rowOpen = useStableCallback(onOpen);
  const rowSettle = useStableCallback(settleRow);
  const rowUnread = useStableCallback(markUnread);
  const rowRead = useStableCallback((row: Row) => void markRead(row));

  // The next page as the list nears its end.
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (
      threads.hasMore &&
      !threads.loadingMore &&
      el.scrollHeight - el.scrollTop - el.clientHeight < MORE_WITHIN_PX
    )
      threads.loadMore();
  };

  // A question asked here starts its thread, which opens (on the assistant's default again next time, CR-02) in the new
  // chat's place: Back from the thread goes to the list, never to an empty new chat.
  const onStarted = useCallback(
    (rootId: string) => {
      resetRuntime();
      void updateSearch(
        (s) => ({ ...s, thread: rootId, focus: undefined, settled: undefined, new: undefined }),
        { replace: fresh },
      );
    },
    [resetRuntime, updateSearch, fresh],
  );
  const composer = useInboxComposer({
    burrow,
    conversationId,
    prompts: room === 'chat',
    placeholder: words.chatPlaceholder,
    onStarted,
    runtimeTool: top.tool,
    ...(top.runtime ? { runtime: top.runtime } : {}),
    // The cursor goes into the box when the new chat is asked for (the button, N, its address), not when it merely
    // shows beside the list, where the list keeps the keys.
    focusKey: fresh ? asked : undefined,
  });
  // Files dropped anywhere on the room go with the next question: the new chat opens with them in its box.
  const pickFiles = composer.pickFiles;
  const dropFiles = useMemo(
    () =>
      pickFiles
        ? (files: File[]) => {
            pickFiles(files);
            startNew();
          }
        : null,
    [pickFiles, startNew],
  );
  const drop = useFileDrop(dropFiles);

  const title = CHAT_WORDS[room];
  if (!rooms.known)
    return rooms.error ? (
      <RoomStatus screen={room} title={title} message="This couldn’t be opened. Try again." />
    ) : (
      <RoomStatus screen={room} />
    );
  if (!ref) {
    // No Feedback room yet (CHT-03: it exists once a website or an automation sends reports there).
    return (
      <RoomStatus
        screen={room}
        title={title}
        message={room === 'feedback' ? CHAT_WORDS.feedbackEmpty : 'Chat couldn’t be opened. Try again.'}
      />
    );
  }

  const sub = room === 'chat' ? words.chatSub : words.feedbackSub;
  // A room that never had a thread says what it is for; one tidied up says it is all settled.
  const never = known && rows.length === 0 && !threads.settledCount;
  const empty =
    filter === 'unread'
      ? { title: INBOX_WORDS.nothingNew, hint: INBOX_WORDS.nothingNewHint }
      : filter === 'waiting'
        ? { title: INBOX_WORDS.nothingWaits, hint: `${words.name} will put questions here.` }
        : never
          ? { title: null, hint: room === 'chat' ? words.chatEmpty : CHAT_WORDS.feedbackEmpty }
          : { title: INBOX_WORDS.allSettled, hint: INBOX_WORDS.allSettledHint };
  const filters: { key: InboxFilter; label: string; n: number; tone?: 'new' | 'waiting' }[] = [
    { key: 'all', label: INBOX_WORDS.all, n: 0 },
    { key: 'unread', label: INBOX_WORDS.unread, n: counts.unread, tone: 'new' },
    { key: 'waiting', label: INBOX_WORDS.waiting, n: counts.waiting, tone: 'waiting' },
  ];
  // The new chat shows beside the list while no thread is open, and in the list's place when it was asked for.
  const freshShown = split ? !openId : fresh;
  const newTitle = newChatTitle(room);
  const backToList = () => void updateSearch((s) => ({ ...s, new: undefined }));

  return (
    <section
      className={styles.room}
      data-screen={room}
      data-split={split || undefined}
      aria-label={title}
      {...drop.handlers}
    >
      {drop.dragging && (
        <div className={roomStyles.dropZone} aria-hidden="true">
          <p>Drop files to attach them</p>
        </div>
      )}
      <div className={styles.list} ref={listRef} hidden={freshShown && !split}>
        <header className={styles.head}>
          <div className={styles.headRow}>
            <h1>{title}</h1>
            <span className={styles.sub}>{sub}</span>
            <span className={styles.spacer} />
            {feedback ? (
              <AppLink
                href="/feedback"
                className={styles.headButton}
                aria-label={
                  feedback.unread > 0 ? CHAT_WORDS.feedbackUnread(feedback.unread) : CHAT_WORDS.feedback
                }
                data-feedback-button=""
              >
                {CHAT_WORDS.feedback}
                {feedback.unread > 0 ? (
                  <span className={styles.headBadge} aria-hidden="true">
                    {feedback.unread}
                  </span>
                ) : null}
              </AppLink>
            ) : null}
          </div>
          <div className={styles.filterRow}>
            {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as a segmented control */}
            <div className={styles.filters} role="group" aria-label={INBOX_WORDS.show}>
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={styles.filter}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  data-filter={f.key}
                >
                  {f.label}
                  {f.n > 0 ? (
                    <span className={styles.filterCount} data-tone={f.tone}>
                      {f.n}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.settled}
              aria-pressed={!!search.settled}
              onClick={() =>
                void updateSearch((s) => ({
                  ...s,
                  settled: s.settled ? undefined : 1,
                  thread: undefined,
                  focus: undefined,
                  new: undefined,
                }))
              }
              data-settled-button=""
            >
              {SETTLE_WORDS.settled}
              <Icon icon={ChevronRight} size={14} />
            </button>
          </div>
        </header>
        <div className={styles.items} onScroll={onScroll} data-inbox-scroll="">
          {/* Where the browser has never asked, the Chat asks once whether to send notifications. */}
          {room === 'chat' ? <NotificationsOffer burrow={burrow} /> : null}
          {threads.isLoading ? (
            <SkeletonRows count={6} lines={2} className={styles.skeleton} />
          ) : threads.error && !threads.threads.length ? (
            <ErrorNote message="The threads couldn’t be loaded. Try again." onRetry={threads.refetch} />
          ) : shown.length ? (
            <ul className={styles.rows} aria-label="Threads">
              {shown.map((row) => (
                <InboxRow
                  key={row.rootId}
                  burrow={burrow}
                  row={row}
                  selected={row.rootId === openId}
                  canSettle={known && row.settleable}
                  onOpen={rowOpen}
                  onSettle={rowSettle}
                  onMarkUnread={rowUnread}
                  onMarkRead={rowRead}
                />
              ))}
            </ul>
          ) : (
            <div className={styles.empty} data-inbox-empty={filter}>
              {empty.title ? (
                <>
                  <span className={styles.emptyMark} aria-hidden="true">
                    <Icon icon={Check} size={18} />
                  </span>
                  <strong>{empty.title}</strong>
                </>
              ) : null}
              <span>{empty.hint}</span>
            </div>
          )}
          {threads.loadingMore ? <p className={styles.more}>Loading…</p> : null}
        </div>
        {/* After the rows it floats over, so a screen reader and Tab reach it after the list. */}
        <button
          type="button"
          className={styles.newButton}
          aria-label={newTitle}
          aria-pressed={split ? freshShown : undefined}
          title={`${newTitle} (N)`}
          onClick={startNew}
          data-new-chat-button=""
        >
          <Icon icon={SquarePen} size={24} />
        </button>
      </div>
      {freshShown ? (
        <div className={styles.fresh} data-new-chat="">
          <div className={styles.freshHead}>
            {split ? null : (
              <a
                href={`/${room}`}
                className={styles.backLink}
                aria-label={`Back to ${title}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                  event.preventDefault();
                  backToList();
                }}
                data-new-chat-back=""
              >
                <Icon icon={ArrowLeft} size={16} />
                <span>{title}</span>
              </a>
            )}
            <h2>{newTitle}</h2>
          </div>
          <div className={styles.freshBody}>
            <span className={styles.freshFace} aria-hidden="true">
              {assistant ? <WhombatAvatar face={agentFaceOf(assistant)} size={72} crop="head" /> : null}
            </span>
            <p>{words.chatEmpty}</p>
          </div>
          <div className={styles.ask}>{composer.element}</div>
        </div>
      ) : null}
    </section>
  );
}
