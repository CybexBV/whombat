import {
  appPath,
  attachmentsBesideCard,
  earlierCardLine,
  earlierCardText,
  isJobResult,
  JOB_RESULT_WORDS,
  MOVED_CARD_WORDS,
  movedCardLink,
  ranOnSwitches,
  rootTitle,
  textFoldsIntoCard,
  wordsUnderCard,
} from '@whombat/client';
import {
  formatClock,
  formatReplies,
  isDeletedMessage,
  type Message,
  type Principal,
  type Receipt,
  threadContext,
} from '@whombat/core';
import { ArrowDown, ArrowLeft, ChevronDown } from 'lucide-react';
import { Fragment, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { currentLocale } from '../../i18n/provider';
import { INBOX_WORDS } from '../../i18n/shared';
import { CardStillContext } from '../cards/cardLook';
import { RanOnDivider, RanOnMark, RanOnNotes, ranOnTitle } from '../chats/runtime/RanOn';
import { Composer, type ComposerAttachment, type ComposerPrompts } from './Composer';
import roomStyles from './ConversationRoom.module.css';
import { T3Mark } from './Handoff';
import { JobResultBody } from './JobResult';
import { MessageAttachments } from './MessageAttachments';
import { SKIP_ROWS_FROM, TypingIndicator, type TypingLine, typingLine } from './MessageList';
import listStyles from './MessageList.module.css';
import {
  DeletedAvatar,
  DeletedText,
  EditedLabel,
  LinkPreviews,
  MessageToolbar,
  PinnedMarker,
  ReactionPills,
  VaultSavedLines,
} from './MessageParts';
import { MessageText } from './MessageRow';
import rowStyles from './MessageRow.module.css';
import type { SkillCommand } from './model';
import { foldMessages } from './model';
import { PrincipalAvatar } from './PrincipalAvatar';
import { CARD_BUTTON } from './replyFocus';
import styles from './ThreadView.module.css';
import { useFileDrop } from './useFileDrop';
import { SCROLL_TO_END, useThreadScroll } from './useThreadScroll';

const NO_PRINCIPALS: readonly Principal[] = [];

/** The thread pane's expand button (lucide Maximize2) and, in focus mode, its collapse button (Minimize2). */
export const THREAD_EXPAND_LABEL = 'Open thread full width';
export const THREAD_COLLAPSE_LABEL = 'Show thread beside the conversation';

/** “Back to #general”, “Back to Banjo”, “Back to feat/invoice-pdf”: where the thread lives (its `where`). */
/**
 * Whether a thread message shows its card: replies do; the root's card isn't repeated in the pane, except a report's —
 * the thread is where the whole report is read (docs/decisions/report-rows.md RR-07).
 */
/**
 * Under the words a council's or checklist's card left when it moved to the thread's end (card-moves.md CM-07): a quiet
 * link to where the card is now, so “Tick what you want” doesn't point at nothing.
 */
function MovedCardLink({
  message,
  messages,
  onGo,
}: {
  message: Message;
  messages: readonly Message[];
  onGo: (id: string) => void;
}) {
  const link = movedCardLink(message, messages);
  if (!link) return null;
  return (
    <button type="button" className={styles.movedLink} onClick={() => onGo(link.targetId)} data-moved-card="">
      {link.label}
      <Icon icon={ArrowDown} size={13} />
    </button>
  );
}

/**
 * Where the person talked about a council's or Tasks card that has since moved on (card-moves.md): the card as it
 * was here, folded into one line (“Tasks · earlier version · 5 tasks”) that opens it read-only and inert, and the link to
 * the newest. Only the newest card has buttons.
 */
function EarlierCard({
  message,
  messages,
  onGo,
  renderCard,
}: {
  message: Message;
  messages: readonly Message[];
  onGo: (id: string) => void;
  renderCard?: (message: Message, inside?: readonly Message[]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const line = earlierCardLine(message, messages);
  const link = movedCardLink(message, messages);
  if (!line || !message.earlierCard) return null;
  return (
    <div className={styles.earlier} data-earlier-card="">
      <div className={styles.earlierLine}>
        <button
          type="button"
          className={styles.earlierToggle}
          aria-expanded={open}
          aria-label={`${line}. ${open ? MOVED_CARD_WORDS.hide : MOVED_CARD_WORDS.show}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon
            icon={ChevronDown}
            size={14}
            className={cx(styles.earlierChevron, open && styles.earlierOpen)}
          />
          {line}
        </button>
        {link && (
          <button
            type="button"
            className={styles.movedLink}
            onClick={() => onGo(link.targetId)}
            aria-label={`${MOVED_CARD_WORDS.newest}: ${link.label}`}
            data-moved-card=""
          >
            {MOVED_CARD_WORDS.newest}
            <Icon icon={ArrowDown} size={13} />
          </button>
        )}
      </div>
      {/* The drawn copy is inert, so screen readers hear it in words instead. */}
      {open && <p className={styles.srOnly}>{earlierCardText(message)}</p>}
      {open && (
        <div inert data-earlier-open="">
          <CardStillContext.Provider value={true}>
            {renderCard?.({ ...message, card: message.earlierCard, attachments: [], suggestions: [] })}
          </CardStillContext.Provider>
        </div>
      )}
    </div>
  );
}

function showsCard(m: Pick<Message, 'card'>, index: number, rootCard = false): boolean {
  if (!m.card) return false;
  return index > 0 || rootCard || m.card.kind === 'report';
}

/** Above the first message that was new when the thread opened (Whombat chat-inbox.md CIB-04). */
function NewLine() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot carry the label
    <div className={styles.newLine} role="separator" aria-label={INBOX_WORDS.newLine} data-new-line="">
      {INBOX_WORDS.newLine}
    </div>
  );
}

export function threadBackLabel(where: string): string {
  return `Back to ${where}`;
}

export interface ThreadViewProps {
  /** Root first, then replies (oldest first). */
  messages: readonly Message[];
  /** "#billing-v2" */
  where: string;
  /** "PDF libraries" */
  topic: string | null;
  lookup: (id: string) => Principal | undefined;
  timeZone: string;
  onClose: () => void;
  /**
   * Cards other than receipts (`<MessageCard>`); the root's card is not repeated in the pane, but for a report's
   * (docs/decisions/report-rows.md RR-07). `inside`: the replies that show inside this run (AP-732), which the pane
   * leaves out as rows.
   */
  renderCard?: (message: Message, inside?: readonly Message[]) => ReactNode;
  /** Under a message (quick replies). */
  renderAfter?: (message: Message) => ReactNode;
  /** "Banjo is thinking" lines (or what it does, AP-734). */
  typing?: readonly (string | TypingLine)[];
  /** Before the typing lines: what the agent handed to T3 Code from here (t3code-handoff.md AP-6613). */
  handoffs?: ReactNode;
  /** How many lines `handoffs` shows: the thread stays at its end as they come and go. */
  handoffCount?: number;
  /** Reply box: the composer's reply variant (WX-04). `onSend` gets the trimmed text (empty with files only). */
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => void;
  /** `+ file`, paste and drop in the thread (WX-04); null: uploads unavailable. */
  onPickFiles?: ((files: File[]) => void) | null;
  attachments?: readonly ComposerAttachment[];
  onRemoveAttachment?: (localId: string) => void;
  onRetryAttachment?: (localId: string) => void;
  /** What `/` offers in the thread: the agent's skills (SL-09). */
  skills?: readonly SkillCommand[];
  /** The person's prompts above them, in a Chat thread (prompts-web.md). */
  prompts?: ComposerPrompts | null;
  /** Placeholder of the reply box (the mock's “Reply in thread”). */
  replyPlaceholder?: string;
  /** Who `@Name` can mean in the reply box, for its case (AP-607). */
  mentionables?: readonly Principal[];
  viewerId?: string;
  /**
   * A chat with the assistant (Chat, Feedback, a task chat): the viewer's own messages show their face but no name, as in
   * the room (docs/decisions/chat-threads-cards.md).
   */
  plainOwn?: boolean;
  notice?: ReactNode;
  onNavigate?: (href: string) => void;
  /** A message's menu (“Make a plan”, AP-87): its “More actions” button and right-click, as in the room. */
  onMenu?: (event: MouseEvent<HTMLElement>, message: Message) => void;
  /** Id of the message whose menu is open. */
  menuOpenId?: string | null;
  /** Shown instead of messages (loading, not found). */
  status?: ReactNode;
  /**
   * `pane` (400px, beside the conversation) or `focus` (full width instead of it, with “← Back to #general”;
   * docs/decisions/ui-improvements.md AP-304). Replies, cards and the reply box are the same in both.
   */
  layout?: 'pane' | 'focus';
  /** Switches the layout (the expand / collapse buttons and the back link); without it there are none. */
  onFocusChange?: (focus: boolean) => void;
  /** The split view's address, for the back link (a real link: it opens in a new tab too). */
  splitHref?: string;
  /** Whether the expand / collapse button shows (with `onFocusChange`); a Chat thread has only the back link (AP-2415). */
  collapsible?: boolean;
  /** Toggles the viewer's reaction on a message (its pills; AP-444). */
  onReact?: (message: Message, value: string) => void;
  /** Id of the message whose reaction picker is open. */
  pickerOpenId?: string | null;
  /** The inline editor for the message being edited, else null (AP-441). */
  renderEditor?: (message: Message) => ReactNode;
  /** ↑ in the empty reply box edits the viewer's newest reply here; true when it did. */
  onEditLast?: () => boolean;
  /** Focus the reply box when this changes (after an edit is saved or cancelled). */
  replyFocusKey?: unknown;
  /** Between the root and the replies: “Load earlier replies” while earlier ones exist (WX-11). */
  earlier?: ReactNode;
  /** Ids of the replies a link points at (`#msg_…`): scrolled to and highlighted when the thread opens (WX-06). */
  target?: string | null;
  /** After a typing line's words: Stop on an agent's thinking turn (WX-10). */
  typingAction?: (line: TypingLine) => ReactNode;
  /**
   * In the head after “Thread”, in place of where it lives (a Chat thread's subject chip; chat-channel.md AP-2409).
   * Undefined: “#general · PDF libraries” as before.
   */
  headExtra?: ReactNode;
  /** “4 replies” on a hairline between the first message and the replies (a Chat thread, the mock's `.sep`). */
  repliesLine?: boolean;
  /** Where a Chat or Feedback thread stands (“Waiting for you”), after the replies in its head; null: nothing. */
  stageWord?: string | null;
  /** The whole head instead of “Thread” and its buttons (a thing page's Ask pane, AP-2412). */
  header?: ReactNode;
  /** What answers in a Chat thread (chat-runtime.md AP-2690): the button in the reply box; null: none. */
  runtimeTool?: ReactNode;
  /** The burrow, for the reply box's voice typing (docs/decisions/dictation.md); none without it. */
  burrow?: string;
  /** In the head before the close button: a Chat thread's “Settle” (chat-settle.md AP-6150). */
  headAction?: ReactNode;
  /** Between the head and the messages: the stage track of a job handed to T3 Code, a settled thread's Open again. */
  stateLine?: ReactNode;
  /** Under the reply box: “A reply opens it again.” on a settled thread (AP-6154). */
  replyHint?: ReactNode;
  /** Opened by Answer: the newest card with a button to press gets focus, scrolled into view, once it shows. */
  focusCard?: boolean;
  /**
   * A room's thread (Chat, Feedback): its one way out, a link back to where it was opened from (“← Chat”, “← Inbox”).
   * Its head is then that link, the subject chip (`headExtra`), the question once the first message has scrolled out of
   * view, the number of replies and `headAction`; no close button.
   */
  back?: ThreadBack | null;
  /** The first message that was new when the thread opened: the “New” line goes above it (Whombat chat-inbox.md). */
  newFrom?: string | null;
  /**
   * The first message's card shows here too (Chat and Feedback, whose list shows no cards; elsewhere the room shows
   * it above the thread).
   */
  rootCard?: boolean;
}

export interface ThreadBack {
  /** “Chat”, “Inbox”, “Home Assistant”. */
  label: string;
  /** Its address, so the link opens in a new tab too. */
  href: string;
  onBack: () => void;
}

/**
 * Thread pane contents (README "Thread pane", 400px): "Thread" + context, 32px avatars, receipts
 * blocks, and a reply box. The pane frame (`SidePane`) comes from the shell.
 */
export function ThreadView({
  messages,
  where,
  topic,
  lookup,
  timeZone,
  onClose,
  renderCard,
  renderAfter,
  typing = [],
  handoffs = null,
  handoffCount = 0,
  draft,
  onDraftChange,
  onSend,
  onPickFiles = null,
  attachments = [],
  onRemoveAttachment,
  onRetryAttachment,
  skills = [],
  prompts = null,
  replyPlaceholder = 'Reply in thread',
  notice,
  onNavigate,
  status,
  onMenu,
  menuOpenId = null,
  layout = 'pane',
  onFocusChange,
  splitHref,
  collapsible = true,
  onReact,
  pickerOpenId = null,
  renderEditor,
  onEditLast,
  replyFocusKey,
  earlier,
  target = null,
  typingAction,
  mentionables = NO_PRINCIPALS,
  viewerId,
  plainOwn = false,
  headExtra,
  repliesLine = false,
  stageWord = null,
  header,
  runtimeTool = null,
  burrow,
  headAction,
  stateLine,
  replyHint,
  focusCard = false,
  back = null,
  newFrom = null,
  rootCard = false,
}: ThreadViewProps) {
  const focus = layout === 'focus';
  const replies = Math.max(messages[0]?.replyCount ?? 0, messages.length - 1);
  const listRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  // Replies fold into the runs among the replies only.
  const folded = useMemo(() => {
    const { visible, inside } = foldMessages(messages.slice(1));
    const shown = new Set(visible.map((m) => m.id));
    return {
      inside,
      hidden: new Set(
        messages
          .slice(1)
          .filter((m) => !shown.has(m.id))
          .map((m) => m.id),
      ),
    };
  }, [messages]);
  // The “New” line above the first new message, or the first one drawn after it when it is folded into a run.
  const newAt = useMemo(() => {
    if (!newFrom) return null;
    const from = messages.findIndex((m) => m.id === newFrom);
    if (from < 0) return null;
    return messages.slice(from).find((m) => !folded.hidden.has(m.id))?.id ?? null;
  }, [newFrom, messages, folded]);
  // While an agent thinks here, the face beside its newest message thinks too (a 32px live face changes pose only),
  // unless its thinking line shows the agent's own face.
  const thinkingFace = useMemo(() => {
    const thinkers = new Set(
      typing
        .map(typingLine)
        .filter((line) => !line.face)
        .map((line) => line.principalId)
        .filter(Boolean),
    );
    if (!thinkers.size) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && thinkers.has(m.authorId) && !folded.hidden.has(m.id) && !isDeletedMessage(m)) return m.id;
    }
    return null;
  }, [typing, messages, folded]);
  // Before a reply that ran on something else than the previous one, a quiet divider (chat-runtime.md CR-07, AP-2696).
  const switches = useMemo(() => ranOnSwitches(messages.slice(1)), [messages]);
  // A long thread lets off-screen replies skip their layout and paint (WX-02).
  const skipRows = messages.length >= SKIP_ROWS_FROM;
  // Files dropped on the pane attach to the reply (WX-04).
  const drop = useFileDrop(onPickFiles);

  // A thread opens at its latest reply (AP-676; the mock opened at the root), or at the reply a link points at (WX-06),
  // and stays at the end while its replies settle; further up, “Scroll to the end” (thread-scroll.md).
  const scroll = useThreadScroll(listRef, {
    rootId: messages[0]?.id ?? null,
    count,
    newest: messages.at(-1)?.id ?? null,
    typing: typing.length + handoffCount,
    target,
    newestMine: !!viewerId && messages.at(-1)?.authorId === viewerId,
  });

  // A room thread's head says its question once the first message has scrolled out of view.
  const [titleShown, setTitleShown] = useState(false);
  const rootId = messages[0]?.id;
  const roomHead = !!back;
  useEffect(() => {
    const list = listRef.current;
    if (!roomHead || !rootId || !list || typeof IntersectionObserver === 'undefined') return;
    const root = list.querySelector(`[data-message-id="${CSS.escape(rootId)}"]`);
    if (!root) return;
    const observer = new IntersectionObserver(([entry]) => setTitleShown(!entry?.isIntersecting), {
      root: list,
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [roomHead, rootId]);

  // Answer under a question that waits opened this thread: its card's first button once the card has drawn, or the
  // reply box when the question is the words of a message and not a card.
  const cardFocused = useRef(false);
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!focusCard || cardFocused.current || !count || !list) return;
    let tries = 0;
    let timer = 0;
    const find = () => {
      const cards = [...list.querySelectorAll<HTMLElement>('[data-thread-card]')].reverse();
      const button = cards.map((card) => card.querySelector<HTMLElement>(CARD_BUTTON)).find(Boolean);
      if (button) {
        cardFocused.current = true;
        button.scrollIntoView({ block: 'center' });
        button.focus({ preventScroll: true });
        return;
      }
      if (cards.length || ++tries >= 5) {
        cardFocused.current = true;
        paneRef.current?.querySelector<HTMLElement>('[data-composer] textarea')?.focus();
        return;
      }
      timer = window.setTimeout(find, 100);
    };
    timer = window.setTimeout(find, 50);
    return () => window.clearTimeout(timer);
  }, [focusCard, count]);

  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || href.startsWith('http') || event.metaKey || event.ctrlKey || event.button !== 0)
      return;
    event.preventDefault();
    onNavigate(href);
  };

  const receipt = (r: Receipt) => {
    const content = (
      <>
        <span className={styles.receiptNumber}>{r.n}</span>
        <span className={styles.receiptText}>
          <span className={styles.receiptSource}>{r.source}</span>
          <span className={styles.receiptDetail}>{r.detail}</span>
        </span>
      </>
    );
    if (!r.link) {
      return (
        <div key={r.n} className={styles.receipt}>
          {content}
        </div>
      );
    }
    const href = appPath(r.link);
    const external = r.link.type === 'external';
    return (
      <a
        key={r.n}
        href={href}
        className={styles.receipt}
        onClick={follow(href)}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {content}
      </a>
    );
  };

  return (
    <div
      ref={paneRef}
      className={cx(styles.pane, focus && styles.focus)}
      data-screen="thread"
      data-layout={layout}
      {...drop.handlers}
    >
      {drop.dragging && (
        <div className={roomStyles.dropZone} aria-hidden="true">
          <p>Drop files to attach them</p>
        </div>
      )}
      {header ??
        (back ? (
          <RoomThreadHead
            back={back}
            question={messages[0] ? rootTitle(messages[0]) : ''}
            replies={status ? 0 : replies}
            stageWord={status ? null : stageWord}
            subject={headExtra}
            action={headAction}
            titleShown={titleShown}
          />
        ) : null) ?? (
          <div className={styles.header}>
            <div className={styles.heading}>
              {focus && where && (
                <a
                  href={splitHref}
                  className={styles.back}
                  onClick={(event) => {
                    if (
                      !onFocusChange ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.button !== 0
                    )
                      return;
                    event.preventDefault();
                    onFocusChange(false);
                  }}
                >
                  ← {threadBackLabel(where)}
                </a>
              )}
              {headExtra !== undefined ? (
                <div className={styles.titleRow}>
                  <h2 className={styles.title}>Thread</h2>
                  {headExtra}
                </div>
              ) : (
                <>
                  <h2 className={styles.title}>Thread</h2>
                  {focus
                    ? topic && <span className={styles.context}>{topic}</span>
                    : where && <span className={styles.context}>{threadContext(where, topic)}</span>}
                </>
              )}
            </div>
            <div className={styles.actions}>
              {headAction}
              {/* One button that swaps its icon and label, so keyboard focus stays on it across the switch. */}
              {onFocusChange && collapsible && (
                <IconButton
                  label={focus ? THREAD_COLLAPSE_LABEL : THREAD_EXPAND_LABEL}
                  onClick={() => onFocusChange(!focus)}
                  data-thread-expand=""
                >
                  <Icon name={focus ? 'collapse' : 'expand'} size={16} />
                </IconButton>
              )}
              <IconButton label="Close thread" onClick={onClose}>
                <Icon name="close" size={16} />
              </IconButton>
            </div>
          </div>
        )}
      {stateLine}
      <div className={styles.listArea}>
        <div ref={listRef} className={styles.list} onScroll={scroll.onScroll} data-thread-scroll="">
          {status ??
            messages.map((m, i) => {
              // What a run did shows inside the run (AP-732), not as a reply of its own.
              if (folded.hidden.has(m.id)) return null;
              const author = lookup(m.authorId);
              // A job's result is T3 Code's report: its face and name, its parts laid out (`JobResultBody`).
              const result = !!burrow && isJobResult(m);
              const name = result ? JOB_RESULT_WORDS.author : (author?.name ?? 'Someone');
              // The viewer's own message: their face and the time, no name (docs/decisions/chat-threads-cards.md).
              const self = plainOwn && !!viewerId && m.authorId === viewerId;
              const clock = formatClock(m.createdAt, timeZone);
              const pending = m.id.startsWith('msg_local-');
              // A deleted root kept for its replies (CT-173): no author, no actions.
              const deleted = isDeletedMessage(m);
              const live = !pending && !deleted;
              const editor = renderEditor?.(m) ?? null;
              const menu = onMenu && live ? onMenu : undefined;
              const toolbar = !editor && !!menu;
              const row = (
                // Off-screen replies skip layout and paint (WX-02), in the room's slot.
                <div
                  key={m.clientId ? `c-${m.clientId}` : m.id}
                  className={cx(listStyles.slot, skipRows && listStyles.skip)}
                  data-row-slot=""
                >
                  <article
                    className={cx(styles.row, toolbar && rowStyles.withMenu)}
                    aria-label={
                      deleted
                        ? `Deleted message, ${clock}`
                        : self
                          ? `Your message, ${clock}`
                          : `${name}, ${clock}`
                    }
                    data-message-row=""
                    data-message-id={m.id}
                    data-self={(self && !deleted) || undefined}
                    onContextMenu={
                      menu && !editor
                        ? (event) => {
                            if ((event.target as HTMLElement).closest('a, input, textarea')) return;
                            menu(event, m);
                          }
                        : undefined
                    }
                  >
                    {toolbar && (
                      <MessageToolbar
                        name={name}
                        self={self}
                        onMenu={menu ? (event) => menu(event, m) : undefined}
                        menuOpen={menuOpenId === m.id}
                        pickerOpen={pickerOpenId === m.id}
                      />
                    )}
                    <div className={styles.avatar}>
                      {deleted ? (
                        <DeletedAvatar size={32} />
                      ) : result ? (
                        <span role="img" aria-label={JOB_RESULT_WORDS.author} className={styles.markFace}>
                          <T3Mark size={32} />
                        </span>
                      ) : (
                        <PrincipalAvatar
                          principal={author}
                          size={32}
                          state={m.id === thinkingFace ? 'thinking' : null}
                        />
                      )}
                    </div>
                    <div className={styles.content}>
                      {deleted ? (
                        <DeletedText />
                      ) : (
                        <>
                          <div className={styles.meta} data-message-meta="">
                            {!self && <span className={styles.name}>{name}</span>}
                            <time className={styles.time} dateTime={m.createdAt} title={ranOnTitle(m)}>
                              {clock}
                            </time>
                            <RanOnMark message={m} changed={switches.has(m.id)} />
                            {m.editedAt && <EditedLabel at={m.editedAt} timeZone={timeZone} />}
                            {m.pinnedAt && (
                              <PinnedMarker by={m.pinnedById ? lookup(m.pinnedById) : undefined} />
                            )}
                          </div>
                          {editor ??
                            (result ? (
                              <JobResultBody burrow={burrow ?? ''} message={m} timeZone={timeZone} />
                            ) : (
                              m.text &&
                              !(showsCard(m, i, rootCard) && textFoldsIntoCard(m.text, m.card)) && (
                                <MessageText text={m.text} className={styles.body} />
                              )
                            ))}
                          {!editor && <VaultSavedLines message={m} />}
                          {!editor &&
                            (m.earlierCard ? (
                              <EarlierCard
                                message={m}
                                messages={messages}
                                onGo={scroll.toMessage}
                                renderCard={renderCard}
                              />
                            ) : (
                              <MovedCardLink message={m} messages={messages} onGo={scroll.toMessage} />
                            ))}
                          {m.card?.kind === 'answer' ? (
                            <div className={styles.receipts}>{m.card.receipts.map(receipt)}</div>
                          ) : showsCard(m, i, rootCard) ? (
                            <div className={styles.cardSlot} data-thread-card="">
                              {renderCard?.(m, folded.inside.get(m.id))}
                            </div>
                          ) : null}
                          {/* A council's thoughts and conclusion read as the message's own words, under its card. */}
                          {!editor && showsCard(m, i, rootCard) && wordsUnderCard(m.card) && (
                            <MessageText text={wordsUnderCard(m.card) as string} className={styles.body} />
                          )}
                          <MessageAttachments
                            attachments={
                              showsCard(m, i, rootCard)
                                ? attachmentsBesideCard(m.attachments, m.card)
                                : m.attachments
                            }
                            conversationId={m.conversationId}
                          />
                          <LinkPreviews previews={m.previews} />
                          <ReactionPills
                            reactions={m.reactions}
                            lookup={lookup}
                            onToggle={onReact ? (r) => onReact(m, r.value) : undefined}
                          />
                          <RanOnNotes message={m} />
                        </>
                      )}
                      {renderAfter?.(m)}
                    </div>
                  </article>
                </div>
              );
              // “Load earlier replies” right under the root, where the missing replies go (WX-11); a Chat thread says how
              // many replies there are on a hairline first (AP-2409).
              const line =
                i === 0 && repliesLine && replies > 0 ? (
                  <div key="replies-line" className={styles.repliesLine} data-replies-line="">
                    {formatReplies(replies, currentLocale())}
                  </div>
                ) : null;
              const change = switches.get(m.id);
              // Always the same fragment around the row: a divider or line coming or going beside it would otherwise build
              // the row again, and its card, pictures and previews start over at their first size.
              return (
                <Fragment key={row.key}>
                  {m.id === newAt && <NewLine />}
                  {change && <RanOnDivider change={change} />}
                  {row}
                  {i === 0 && line}
                  {i === 0 && earlier}
                </Fragment>
              );
            })}
          {handoffs && <div className={styles.handoffs}>{handoffs}</div>}
          {typing.map(typingLine).map((line) => (
            <TypingIndicator
              key={line.key}
              label={line.label}
              spoken={line.spoken}
              at={line.at}
              face={line.face}
              state={line.state}
              look="thread"
              className={line.face ? undefined : styles.typing}
            >
              {typingAction?.(line)}
            </TypingIndicator>
          ))}
        </div>
        {scroll.away && !status && (
          <button type="button" className={styles.toEnd} onClick={scroll.toEnd} data-thread-to-end="">
            {SCROLL_TO_END}
            <Icon name="toEnd" size={14} />
          </button>
        )}
      </div>
      <div className={styles.replyDock}>
        <Composer
          variant="reply"
          placeholder={replyPlaceholder}
          value={draft}
          onValueChange={onDraftChange}
          onSubmit={onSend}
          mentionables={mentionables}
          viewerId={viewerId}
          onPickFiles={onPickFiles}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment}
          notice={notice}
          focusKey={replyFocusKey}
          burrow={burrow}
          voiceKey={`thread:${messages[0]?.id ?? ''}`}
          skills={skills}
          prompts={prompts}
          onEditLast={onEditLast}
          runtimeTool={runtimeTool}
        />
        {replyHint && <p className={styles.replyHint}>{replyHint}</p>}
      </div>
    </div>
  );
}

/**
 * A room thread's head (docs/decisions/ui-refresh-chat.md): “← Chat” (where it was opened from), the subject chip, the
 * question as its title once the first message is out of view, the number of replies and Settle. The title is the pane's
 * heading all along, so the pane focuses it and a screen reader says the question.
 */
function RoomThreadHead({
  back,
  question,
  replies,
  stageWord,
  subject,
  action,
  titleShown,
}: {
  back: ThreadBack;
  question: string;
  replies: number;
  stageWord: string | null;
  subject: ReactNode;
  action: ReactNode;
  titleShown: boolean;
}) {
  return (
    <div className={cx(styles.header, styles.roomHead)} data-title-shown={titleShown || undefined}>
      <a
        href={back.href}
        className={styles.backLink}
        aria-label={threadBackLabel(back.label)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          back.onBack();
        }}
        data-thread-back=""
      >
        <Icon icon={ArrowLeft} size={16} />
        <span>{back.label}</span>
      </a>
      {subject}
      <h2 className={styles.roomTitle}>{question || 'Thread'}</h2>
      {replies > 0 || stageWord ? (
        <span className={styles.count}>
          <span aria-hidden="true">
            {[replies > 0 ? formatReplies(replies, currentLocale()) : null, stageWord]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {stageWord && <span className={styles.srOnly}>{stageWord}</span>}
        </span>
      ) : null}
      {action}
    </div>
  );
}
