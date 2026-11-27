import { type FaceState, LIVE_BUST_MIN_SIZE } from '@whombat/avatars/motion';
import {
  agentFaceBackground,
  continuesMessage,
  isAutomationPrincipal,
  isSettledRoot,
  shownUnreadFrom,
  type ThreadStage,
  type ThreadStageFlags,
  type ThreadWork,
  threadStage,
  type WorkLine,
  withoutSettled,
} from '@whombat/client';
import {
  type AgentFace,
  isDeletedMessage,
  type Message,
  type Principal,
  type Reaction,
  shortNameOf,
  typingLabel,
} from '@whombat/core';
import { type MouseEvent, memo, type ReactNode, useCallback, useMemo } from 'react';
import { cx } from '../../components/cx';
import { LiveAgentFace } from '../agent/LiveAgentFace';
import styles from './MessageList.module.css';
import { MessageRow } from './MessageRow';
import {
  foldMessages,
  groupByDay,
  isFailedTurn,
  newestAgentFace,
  replyFaceState,
  sameWorkLine,
} from './model';
import { useTicker } from './useRoom';

export interface MessageListProps {
  messages: readonly Message[];
  lookup: (id: string) => Principal | undefined;
  timeZone: string;
  now: Date | number;
  /**
   * The card slot for a message (`<MessageCard>`), or nothing. `inside`: the messages that show inside this run
   * (AP-732); the list leaves them out as rows. Keep it stable (`useCallback`): rows are memoized (WX-01).
   */
  renderCard?: (message: Message, inside?: readonly Message[]) => ReactNode;
  onReact?: (message: Message, reaction: Reaction) => void;
  threadHref?: (message: Message) => string;
  onOpenThread?: (messageId: string) => void;
  /** Under a message's row (quick replies); null where there is nothing, so the row isn't rendered again (WX-01). */
  renderAfter?: (message: Message) => ReactNode;
  /** A message's menu (“Make a plan”); see `MessageRow.onMenu`. */
  onMenu?: (event: MouseEvent<HTMLElement>, message: Message) => void;
  /** Id of the message whose menu is open. */
  menuOpenId?: string | null;
  /** "Banjo is thinking" lines (or what it does, AP-734), newest last. */
  typing?: readonly (string | TypingLine)[];
  /** Shown above the messages when the conversation has none yet (the DM empty state). */
  empty?: ReactNode;
  /** Top of the list: "Load earlier messages" while older history exists. */
  before?: ReactNode;
  /** Under the newest message, above the typing lines (the #general welcome, AP-99). */
  after?: ReactNode;
  /** “Reply in thread” on every message (AP-443). */
  onReplyInThread?: (messageId: string) => void;
  /** Id of the message whose reaction picker is open. */
  pickerOpenId?: string | null;
  /** The inline editor for the message being edited, else null (AP-441). */
  renderEditor?: (message: Message) => ReactNode;
  /** Work in a message's thread for its reply row (`threadWork`, AP-735). */
  threadWork?: (rootId: string) => ThreadWork | null;
  /** The first message the viewer hadn't read when the room opened: the “New” divider goes above it (WX-07). */
  unreadFrom?: string | null;
  /** After a typing line's words: Stop on an agent's thinking turn (WX-10). */
  typingAction?: (line: TypingLine) => ReactNode;
  /** `chat`: a task chat with Whombat (mock 3; one-whombat-shell.md AP-1260): centred 880px column, 22px rhythm. */
  look?: 'room' | 'chat';
  /** The viewer: their own messages show their face but no name in a chat (`look="chat"`). */
  meId?: string | null;
  /**
   * A threaded room (Chat, Feedback; chat-channel.md AP-2404): every top-level message is its own row with its face and
   * name (no runs), the day dividers always, the open thread's root marked (`selectedId`) and a root's subject chip.
   */
  threaded?: {
    selectedId: string | null;
    chip?: (message: Message) => ReactNode;
    /** Settling threads (chat-settle.md AP-6150, AP-6251): settled ones are in Settled, and which roots offer Settle. */
    settle?: ListSettle | null;
    /** The thread has something new for the person: a dot on its reply row (Whombat thread-unread.md). */
    isNew?: ((rootId: string) => boolean) | undefined;
    /** Something in the thread waits for the person: “Waiting for you” and Answer under its first message. */
    waiting?: ((rootId: string) => boolean) | undefined;
    /** Answer: the card that waits (keep it stable: rows are memoized). */
    onAnswer?: ((message: Message) => void) | undefined;
    /**
     * The thread's own flags but settled (`ChatThread.working`, `handedOver`; `waiting` comes from `waiting`): where it
     * stands on its reply row. A settled root says so from its message.
     */
    flags?: ((rootId: string) => ThreadStageFlags) | undefined;
    /** The assistant's name, for “Neo is working”. */
    assistant?: string;
    /** What goes on from a thread (a council, a checklist, T3 Code): its line under the reply row. */
    workLine?: ((rootId: string) => WorkLine | null) | undefined;
  } | null;
}

/** A room that settles its threads: settled ones leave the room for Settled; open ones offer “Settle thread”. */
export interface ListSettle {
  /** The root may settle now (open, nobody works on it, it waits for nobody). */
  settleable: (rootId: string) => boolean;
  /** Keep it stable: rows are memoized (WX-01). */
  onSettle: (message: Message) => void;
}

/** Day divider: `Today · Wednesday 23 September` between two hairlines. */
export function DayDivider({ label }: { label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot carry the day label
    <div className={styles.divider} role="separator" aria-label={label}>
      <span className={styles.line} />
      <span className={styles.dayLabel}>{label}</span>
      <span className={styles.line} />
    </div>
  );
}

/** The copy of the unread divider (WX-07). */
export const UNREAD_DIVIDER = 'New';

/**
 * Where the viewer stopped reading (WX-07): the day divider's hairlines and mono label in the bad tone (`New`), the
 * colour chat apps use for it. It stays where it was while the room is open.
 */
export function UnreadDivider() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot carry the label
    <div
      className={cx(styles.divider, styles.unread)}
      role="separator"
      aria-label="New messages"
      data-unread-divider=""
    >
      <span className={styles.line} />
      <span className={styles.dayLabel}>{UNREAD_DIVIDER}</span>
    </div>
  );
}

/**
 * One typing line: what shows (`Banjo · Editing Layout.astro · 1m 12s`, AP-734), and what a screen reader hears —
 * without the ticking clock, so the status isn't announced every second. `at`: a line that ticks, read again once a
 * second by the line itself (WX-01: the clock re-renders the line, not the room).
 */
export interface TypingLine {
  key: string;
  label: string;
  spoken?: string;
  /** The agent's face on the line, and what it shows: thinking, at work, looking at the person. None for others. */
  face?: AgentFace;
  state?: FaceState;
  at?: (nowMs: number) => { label: string; spoken?: string; state?: FaceState };
  /** The agent a thinking line is about. */
  principalId?: string;
  /** Its turn (`typing.dispatchId`, contracts 0.55): what Stop cancels (WX-10). */
  dispatchId?: string;
}

/** A typing line from a plain label (“Banjo is thinking”) or a `TypingLine`. */
export function typingLine(line: string | TypingLine): TypingLine {
  return typeof line === 'string' ? { key: line, label: line } : line;
}

/** Where a thinking line stands: a room's 40px avatars, a task chat's faces on a disc, a thread's 32px avatars. */
export type TypingLook = 'room' | 'chat' | 'thread';

/**
 * "{Agent} is thinking" (or what it does, AP-734) with three 5px dots (opacity 1, .6, .3) that pulse while it shows.
 * With `at` the line keeps its own one-second clock (WX-01). With the agent's `face` the line starts where the agent's
 * next message will: its live face in the avatars' column, then the dots and the words (docs/decisions/face-motion.md).
 */
export function TypingIndicator({
  label,
  spoken,
  at,
  face,
  state,
  look = 'room',
  className,
  children,
}: {
  label: string;
  /** What the status says to a screen reader, when it differs from the label (no ticking clock). */
  spoken?: string;
  at?: TypingLine['at'];
  face?: AgentFace | undefined;
  state?: FaceState | undefined;
  look?: TypingLook;
  className?: string | undefined;
  /** After the words: the Stop button (WX-10). */
  children?: ReactNode;
}) {
  const nowMs = useTicker(!!at);
  const shown = at ? at(nowMs) : { label, spoken, state };
  const words = (
    <>
      <span className={styles.dots} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </span>
      {shown.spoken && shown.spoken !== shown.label ? (
        <>
          <span aria-hidden="true">{shown.label}</span>
          <span className={styles.srOnly}>{shown.spoken}</span>
        </>
      ) : (
        shown.label
      )}
      {children}
    </>
  );
  if (!face)
    return (
      <div className={cx(styles.typing, className)} role="status">
        {words}
      </div>
    );
  return (
    <div
      className={cx(styles.typingRow, look !== 'room' && styles.typingNear, className)}
      role="status"
      data-typing-face=""
    >
      <TypingFace face={face} state={shown.state ?? state ?? 'thinking'} look={look} />
      <div className={styles.typingWords}>{words}</div>
    </div>
  );
}

/**
 * The thinking line's face, at the smallest size a face blinks, eases from one look to the next and plays its gesture,
 * so the person sees it think and work: a task chat's head on its face's tint, elsewhere the bust like a room's avatar.
 */
function TypingFace({ face, state, look }: { face: AgentFace; state: FaceState; look: TypingLook }) {
  if (look === 'chat')
    return (
      <span
        className={styles.typingDisc}
        style={{ background: agentFaceBackground(face) }}
        aria-hidden="true"
      >
        <LiveAgentFace face={face} size={LIVE_BUST_MIN_SIZE} crop="head" state={state} decorative />
      </span>
    );
  return <LiveAgentFace face={face} size={LIVE_BUST_MIN_SIZE} crop="bust" state={state} decorative />;
}

/** Rows from which a list lets off-screen rows skip their layout and paint (WX-02). */
export const SKIP_ROWS_FROM = 30;

interface ListRowProps {
  /** A long list: off-screen rows skip layout and paint. */
  skip: boolean;
  message: Message;
  inside: readonly Message[] | undefined;
  lookup: (id: string) => Principal | undefined;
  timeZone: string;
  now: Date | number;
  renderCard: MessageListProps['renderCard'];
  onReact: MessageListProps['onReact'];
  threadHref: string | undefined;
  onOpenThread: MessageListProps['onOpenThread'];
  after: ReactNode;
  onMenu: MessageListProps['onMenu'];
  menuOpen: boolean;
  onReplyInThread: MessageListProps['onReplyInThread'];
  pickerOpen: boolean;
  editor: ReactNode;
  work: ThreadWork | null;
  look: 'room' | 'chat';
  continued: boolean;
  threaded: boolean;
  selected: boolean;
  threadNew: boolean;
  waiting: boolean;
  onAnswer: ((message: Message) => void) | undefined;
  stage: ThreadStage | null;
  assistant: string | undefined;
  workLine: WorkLine | null;
  self: boolean;
  chip: ReactNode;
  onSettle: ListSettle['onSettle'] | undefined;
  settleable: boolean;
  settledTag: boolean;
  faceState: FaceState | null;
}

function sameWork(a: ThreadWork | null, b: ThreadWork | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.agentId === b.agentId &&
    a.text === b.text &&
    a.progress === b.progress &&
    a.tone === b.tone &&
    a.by === b.by &&
    a.since === b.since
  );
}

/**
 * One row of the list, memoized (WX-01): it renders again only when its message, its open menu, picker or Ask list, its
 * editor, what shows under it, the work in its thread or what Ask reads change, not when the room does.
 */
const ListRow = memo(
  function ListRow({ skip, message: m, inside, renderCard, onReact, after, editor, ...rest }: ListRowProps) {
    return (
      // `content-visibility: auto` on a slot around the row in a long list (WX-02): off-screen rows skip their work.
      <div className={cx(styles.slot, skip && styles.skip)}>
        <MessageRow
          message={m}
          author={rest.lookup(m.authorId)}
          card={renderCard?.(m, inside)}
          onReact={onReact ? (r) => onReact(m, r) : undefined}
          after={after ?? undefined}
          editor={editor ?? undefined}
          {...rest}
        />
      </div>
    );
  },
  (a, b) => {
    for (const key of Object.keys(a) as (keyof ListRowProps)[]) {
      if (key === 'work') {
        if (!sameWork(a.work, b.work)) return false;
      } else if (key === 'workLine') {
        if (!sameWorkLine(a.workLine, b.workLine)) return false;
      } else if (a[key] !== b[key]) return false;
    }
    return true;
  },
);

/**
 * The message column (max 880px, 28px between rows): day dividers, rows with their cards, reactions and
 * thread links, and the typing indicator.
 */
export function MessageList({
  messages,
  lookup,
  timeZone,
  now,
  renderCard,
  onReact,
  threadHref,
  onOpenThread,
  renderAfter,
  typing = [],
  empty,
  before,
  after,
  onMenu,
  menuOpenId = null,
  onReplyInThread,
  pickerOpenId = null,
  renderEditor,
  threadWork,
  unreadFrom = null,
  typingAction,
  look = 'room',
  meId = null,
  threaded = null,
}: MessageListProps) {
  const chat = look === 'chat';
  // Settled threads are in Settled, not in the room (AP-6251); the open thread's own root stays, marked.
  const settle = threaded?.settle ?? null;
  const selectedId = threaded?.selectedId ?? null;
  const shown = useMemo(
    () => (settle ? withoutSettled(messages, selectedId) : messages),
    [settle, messages, selectedId],
  );
  const unread = shownUnreadFrom(messages, shown, unreadFrom);
  // What a run did shows inside the run (AP-732): those messages are not rows of their own.
  const folded = useMemo(() => foldMessages(shown), [shown]);
  const days = useMemo(() => groupByDay(folded.visible, now, timeZone), [folded, now, timeZone]);
  const skip = folded.visible.length >= SKIP_ROWS_FROM;
  // One message of a run by the same author shows no face and no name (a plain chat's look).
  const plainChat = chat && !threaded;
  const continued = useCallback(
    (dayMessages: readonly Message[], i: number) => {
      const m = dayMessages[i];
      return plainChat && !!m && m.id !== unread && continuesMessage(dayMessages[i - 1], m);
    },
    [plainChat, unread],
  );
  // In a chat the assistant's face beside its newest message is the live one: thinking or working while it is on the
  // reply, sorry when that reply failed. Every older face stays still.
  const liveFace = useMemo(() => {
    if (!chat) return null;
    const newest = newestAgentFace(
      days,
      (m) => {
        const author = lookup(m.authorId);
        return author?.kind === 'agent' && !isAutomationPrincipal(author) && !isDeletedMessage(m);
      },
      continued,
    );
    if (!newest) return null;
    const agent = lookup(newest.message.authorId);
    // A thinking line with the agent's own face shows its work there; the reply's face above it stays calm.
    const typingNow = typing
      .map(typingLine)
      .find((t) => t.principalId === newest.message.authorId && !t.face);
    const work = threaded
      ? (threadWork?.(newest.rowId) ?? null)
      : typingNow && agent
        ? {
            text: typingNow.label === typingLabel(shortNameOf(agent)) ? 'is thinking' : 'is working',
            tone: 'live' as const,
          }
        : null;
    return { rowId: newest.rowId, state: replyFaceState(work, isFailedTurn(newest.message)) };
  }, [chat, days, lookup, continued, threaded, typing, threadWork]);
  const row = (m: Message, i: number, dayMessages: readonly Message[]) => (
    <ListItem key={m.clientId ? `c-${m.clientId}` : m.id} unread={m.id === unread}>
      <ListRow
        skip={skip}
        message={m}
        inside={folded.inside.get(m.id)}
        lookup={lookup}
        timeZone={timeZone}
        now={now}
        renderCard={renderCard}
        onReact={onReact}
        threadHref={threadHref?.(m)}
        onOpenThread={onOpenThread}
        after={renderAfter?.(m) ?? null}
        onMenu={onMenu}
        menuOpen={menuOpenId === m.id}
        onReplyInThread={onReplyInThread}
        pickerOpen={pickerOpenId === m.id}
        editor={renderEditor?.(m) ?? null}
        work={threadWork?.(m.id) ?? null}
        look={look}
        continued={continued(dayMessages, i)}
        threaded={!!threaded}
        selected={!!threaded && threaded.selectedId === m.id}
        threadNew={!!threaded?.isNew?.(m.id)}
        waiting={!m.threadRootId && !!threaded?.waiting?.(m.id)}
        onAnswer={threaded?.onAnswer}
        stage={
          threaded && !m.threadRootId
            ? threadStage({
                ...threaded.flags?.(m.id),
                waiting: !!threaded.waiting?.(m.id),
                settled: m.settled ?? null,
              })
            : null
        }
        assistant={threaded?.assistant}
        workLine={threaded && !m.threadRootId ? (threaded.workLine?.(m.id) ?? null) : null}
        self={chat && !!meId && m.authorId === meId}
        chip={threaded?.chip?.(m) ?? null}
        onSettle={settle?.onSettle}
        settleable={!!settle && !m.threadRootId && !m.settled && settle.settleable(m.id)}
        settledTag={!!settle && isSettledRoot(m)}
        faceState={liveFace?.rowId === m.id ? liveFace.state : null}
      />
    </ListItem>
  );
  return (
    <div className={cx(styles.list, chat && styles.chatList)}>
      {before}
      {shown.length === 0 && empty}
      {days.map((day) => (
        <section key={day.key} className={cx(styles.day, chat && styles.chatDay)} aria-label={day.label}>
          {/* A chat of one day reads as the mock draws it: no divider (AP-1260); a threaded room always has them. */}
          {!(chat && !threaded && days.length === 1) && <DayDivider label={day.label} />}
          {day.messages.map((m, i) => row(m, i, day.messages))}
        </section>
      ))}
      {after}
      {typing.map(typingLine).map((line) => (
        <TypingIndicator
          key={line.key}
          label={line.label}
          spoken={line.spoken}
          at={line.at}
          face={line.face}
          state={line.state}
          look={chat ? 'chat' : 'room'}
        >
          {typingAction?.(line)}
        </TypingIndicator>
      ))}
    </div>
  );
}

/**
 * A row, with the unread divider above it when reading stopped there (WX-07). The same fragment either way, so the divider
 * coming or going doesn't build the row again.
 */
function ListItem({ unread, children }: { unread: boolean; children: ReactNode }) {
  return (
    <>
      {unread && <UnreadDivider />}
      {children}
    </>
  );
}
