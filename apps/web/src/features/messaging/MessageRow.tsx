import { WhombatAvatar } from '@whombat/avatars/react';
import {
  ANSWERING_T3_CODE,
  agentFaceBackground,
  agentFaceOf,
  attachmentsBesideCard,
  CHAT_WORDS,
  isAutomationPrincipal,
  lastReplyLabel,
  SETTLE_WORDS,
  T3_CODE_NAME,
  THREAD_NEW_LABEL,
  THREAD_STAGE_WORDS,
  type ThreadStage,
  type ThreadWork,
  textFoldsIntoCard,
  threadRowLabel,
  threadStageWord,
  type WorkLine as WorkLineData,
  wordsUnderCard,
} from '@whombat/client';
import {
  formatClock,
  formatReplies,
  isDeletedMessage,
  type Message,
  type Principal,
  type Reaction,
  shortNameOf,
} from '@whombat/core';
import { ArrowUpRight, Check, ChevronRight, Workflow } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { RanOnNotes, ranOnTitle } from '../chats/runtime/RanOn';
import { HandoffMinutes, T3Mark } from './Handoff';
import { MessageAttachments } from './MessageAttachments';
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
import styles from './MessageRow.module.css';
import { PersonAvatar } from './PersonAvatar';
import { PrincipalAvatar } from './PrincipalAvatar';
import { RichText } from './RichText';
import { WorkLine } from './WorkLine';

export interface MessageRowProps {
  message: Message;
  author: Principal | undefined;
  /** Principals by id, for the thread link's stacked heads. */
  lookup: (id: string) => Principal | undefined;
  timeZone: string;
  now: Date | number;
  /** The card slot (`<MessageCard>`); rendered between the text and the reactions, as in the mock. */
  card?: ReactNode;
  /** Toggle the viewer's reaction. */
  onReact?: (reaction: Reaction) => void;
  /** Href of the thread pane for this message (`?thread=<id>`). */
  threadHref?: string;
  onOpenThread?: (messageId: string) => void;
  /** Under everything else: the quick replies on an agent's newest message. */
  after?: ReactNode;
  /**
   * Opens the message's menu (“Make a plan”, WS-09) from its “More actions” button or a right-click; the button
   * shows on hover and focus, so the row looks as in the mock.
   */
  onMenu?: (event: MouseEvent<HTMLElement>, message: Message) => void;
  /** This row's menu is open (the button stays visible). */
  menuOpen?: boolean;
  /** “Reply in thread” in the toolbar: opens the thread pane on this message, even without replies (AP-443). */
  onReplyInThread?: ((messageId: string) => void) | undefined;
  /** The reaction picker is open for this row. */
  pickerOpen?: boolean;
  /** The inline editor, in place of the text while the viewer edits this message (AP-441). */
  editor?: ReactNode;
  /** Work in this message's thread (`threadWork`, AP-735): shown in its reply row. */
  work?: ThreadWork | null;
  /**
   * `chat`: a task chat with the person's assistant (mock 3; one-whombat-shell.md AP-1260) — 34px faces (the agent's
   * drawing on its face's tint, assistant-name-web.md AP-1506), 15px names without a role badge, 15.5px text.
   */
  look?: 'room' | 'chat';
  /** The same author's message just before, moments ago (chat look): no face and no name line, as one message. */
  continued?: boolean;
  /**
   * A threaded room's row (Chat, Feedback; chat-channel.md AP-2404): people by their whole name (the mock's “John
   * Doe”), as in a channel.
   */
  threaded?: boolean;
  /** Its thread is open beside the room: the row is marked (the mock's `.msg.sel`). */
  selected?: boolean;
  /** After the text, on the same line where it fits: what the thread is about (its subject chip, AP-2405). */
  chip?: ReactNode;
  /**
   * Settles this thread (Chat, Feedback; chat-settle.md AP-6150): “Settle thread” first in the toolbar, while
   * `settleable` (open, and the assistant neither works on it nor waits for an answer). Keep it stable (WX-01).
   */
  onSettle?: (message: Message) => void;
  settleable?: boolean;
  /** A settled thread still in its room (the open thread's root): “Settled” after the time (AP-6251). */
  settledTag?: boolean;
  /** Its thread has something the viewer hasn't read: a dot in the gutter on its reply row (Whombat thread-unread.md). */
  threadNew?: boolean;
  /**
   * Something in its thread waits for the person (Chat, Feedback): one “Waiting for you” chip and Answer under it, which
   * goes to the card that waits (docs/decisions/ui-refresh-chat.md).
   */
  waiting?: boolean;
  onAnswer?: ((message: Message) => void) | undefined;
  /**
   * Where the thread stands, from its own flags (Chat, Feedback; `threadStage`): its mark and word on the reply row
   * (“Neo is working”, “Handed over”, “Settled”); “Waiting for you” is the chip above it (`waiting`).
   */
  stage?: ThreadStage | null;
  /** The assistant's name, for “Neo is working”. */
  assistant?: string | undefined;
  /**
   * What goes on from its thread (`threadWorkLine`): a council, a checklist or T3 Code, under the reply row in place of
   * “Handed over”.
   */
  workLine?: WorkLineData | null;
  /** The viewer's own message: their face and the time, no name (docs/decisions/chat-threads-cards.md). */
  self?: boolean;
}

/**
 * The assistant's face in a task chat (mock 3, `.msg .face`; Whombat assistant-name.md AN-04): its drawing's head, 30px,
 * on a 34px disc of its face's colour at 14%, not clipped (FA-06). The name is printed beside it.
 */
function ChatAgentFace({ agent }: { agent: Extract<Principal, { kind: 'agent' }> }) {
  const face = agentFaceOf(agent);
  return (
    <span className={styles.chatFace} style={{ background: agentFaceBackground(face) }} aria-hidden="true">
      <WhombatAvatar face={face} size={30} crop="head" />
    </span>
  );
}

/** One of a thread link's faces, 24px: a person's avatar (photo or initials), an agent's head on its role's tint. */
function ThreadHead({ principal: p }: { principal: Principal | undefined }) {
  if (p?.kind === 'person')
    return <PersonAvatar avatarUrl={p.avatarUrl} initials={p.initials} tone={p.tone} size={24} />;
  if (p?.kind !== 'agent') return <PrincipalAvatar principal={undefined} size={24} />;
  if (isAutomationPrincipal(p)) return <PrincipalAvatar principal={p} size={24} />;
  return (
    // The small head on a 14% tint of the role colour, not clipped (FA-06, FA-07).
    <span className={styles.threadHead} style={{ background: agentFaceBackground(agentFaceOf(p)) }}>
      <WhombatAvatar face={agentFaceOf(p)} size={20} />
    </span>
  );
}

/** “Last reply 10 hours ago”, whose “Last reply” goes where the row is narrow (“10 hours ago”, “3 Oct”). */
const LAST_REPLY_LEAD = /^Last reply (on )?/;
function LastReply({ label }: { label: string }) {
  const lead = LAST_REPLY_LEAD.exec(label)?.[0] ?? '';
  return (
    <span className={styles.last}>
      {/* The space between stays outside: a line's leading space collapses where the lead is hidden. */}
      {lead ? <span className={styles.lastLead}>{lead.trim()}</span> : null}
      {lead ? ' ' : null}
      {label.slice(lead.length)}
    </span>
  );
}

/**
 * A thread's stage on its reply row: an open ring while the assistant works, the branch arrow once handed over, a tick
 * when settled, each with its word (colour never says it alone). Handed over to T3 Code shows how long it has worked.
 */
function StageWord({
  stage,
  assistant,
  since,
}: {
  stage: Exclude<ThreadStage, 'waiting'>;
  assistant: string;
  since: number | null;
}) {
  return (
    <span className={styles.stage} data-stage={stage}>
      {stage === 'working' ? (
        <span className={styles.stageRing} aria-hidden="true" />
      ) : (
        <Icon icon={stage === 'handedOver' ? ArrowUpRight : Check} size={14} className={styles.stageIcon} />
      )}
      <span className={styles.stageWord}>{threadStageWord(stage, assistant)}</span>
      {stage === 'handedOver' && since != null && <HandoffMinutes since={since} />}
    </span>
  );
}

/** What keeps its own click inside a message, so a click there doesn't open the thread. */
const OWN_CLICK =
  'a, button, input, textarea, select, summary, label, video, audio, [role="button"], [role="link"], ' +
  '[role="menuitem"], [role="checkbox"], [role="switch"], [contenteditable="true"], [data-message-toolbar]';

/**
 * A work line that pulses its three dots: an agent thinking, looking into a thread (chat-channel.md AP-2405) or answering
 * T3 Code's question (t3code-handoff.md AP-6612).
 */
const THINKING_WORK = new Set(['is thinking', 'is looking into it', ANSWERING_T3_CODE]);

/** “Banjo is working · 38%” with its bar, “Banjo needs you”, “Banjo is thinking” with dots: work in a thread (AP-735). */
export function ThreadWorkLine({
  work,
  agent,
  alone = false,
}: {
  work: ThreadWork;
  agent: Principal | undefined;
  /** Nothing before it in the row (no replies yet): no hairline. */
  alone?: boolean;
}) {
  const t3 = work.by === 't3code';
  const name = t3 ? T3_CODE_NAME : agent ? shortNameOf(agent) : 'An agent';
  const progress = work.progress === null ? null : Math.max(0, Math.min(100, work.progress));
  return (
    <span
      className={cx(styles.work, alone && styles.workAlone)}
      data-tone={work.tone}
      data-thread-work=""
      data-by={work.by}
    >
      {t3 ? (
        <T3Mark live={work.tone === 'live'} warn={work.tone === 'warn'} />
      ) : (
        <PrincipalAvatar principal={agent} size={18} labelled />
      )}
      <span>
        <span className={styles.workName}>{name}</span> {work.text}
      </span>
      {t3 && work.since != null && <HandoffMinutes since={work.since} />}
      {progress !== null && (
        <span className={styles.workTrack} aria-hidden="true">
          <span className={styles.workBar} style={{ width: `${Math.max(progress, 8)}%` }} />
        </span>
      )}
      {THINKING_WORK.has(work.text) && (
        <span className={listStyles.dots} aria-hidden="true">
          <span className={listStyles.dot} />
          <span className={listStyles.dot} />
          <span className={listStyles.dot} />
        </span>
      )}
    </span>
  );
}

/** Message body: formatted text with `@Name` segments in brand/600 (README "Message row", `RichText`). */
export function MessageText({ text, className }: { text: string; className?: string }) {
  return <RichText text={text} className={className} />;
}

/**
 * One message (README "Message row"): 40px avatar + content, name 15.5/600, role badge for agents,
 * mono time, body 16/1.55 with @mentions, then card, reactions and thread link with 9px gaps.
 */
export function MessageRow({
  message,
  author,
  lookup,
  timeZone,
  now,
  card,
  onReact,
  threadHref,
  onOpenThread,
  after,
  onMenu,
  menuOpen = false,
  onReplyInThread,
  pickerOpen = false,
  editor,
  work = null,
  look = 'room',
  continued = false,
  threaded = false,
  selected = false,
  chip,
  onSettle,
  settleable = false,
  settledTag = false,
  threadNew = false,
  waiting = false,
  onAnswer,
  stage = null,
  assistant = 'Your assistant',
  workLine = null,
  self = false,
}: MessageRowProps) {
  const chat = look === 'chat';
  // A task chat is between one person and their assistant: the person goes by their first name (mock 3, “John”); a
  // threaded room says the whole name, as a channel does.
  const name =
    (chat && !threaded && author?.kind === 'person' ? shortNameOf(author) : author?.name) ?? 'Someone';
  const openThread = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpenThread || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpenThread(message.id);
  };
  const pending = message.id.startsWith('msg_local-');
  // In Chat and Feedback every message is a thread, so a click on the message opens it as its replies link does.
  // What the message holds (links, buttons, a card's controls) keeps its own click, and selecting text opens nothing.
  const openFromRow =
    threaded && onOpenThread && !pending && !editor
      ? (event: MouseEvent<HTMLElement>) => {
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if ((event.target as Element).closest(OWN_CLICK)) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode))
            return;
          onOpenThread(message.id);
        }
      : undefined;
  // A deleted thread root kept for its replies (CT-173): no author, no actions, the thread link stays.
  const deleted = isDeletedMessage(message);
  const live = !pending && !deleted;
  const menu = onMenu && live ? onMenu : undefined;
  const reply = onReplyInThread && live ? () => onReplyInThread(message.id) : undefined;
  const settle = onSettle && settleable && live ? () => onSettle(message) : undefined;
  const hasToolbar = !editor && !!(menu || reply || settle);
  // A report's row says its header and opens its screenshots with its details (docs/decisions/report-rows.md RR-04,
  // RR-05): the standard header and the files don't show beside it.
  const report = !!card && message.card?.kind === 'report';
  const text = card && textFoldsIntoCard(message.text, message.card) ? '' : message.text;
  const underCard = wordsUnderCard(message.card);
  const clock = formatClock(message.createdAt, timeZone);
  // Chat and Feedback: every first message has its reply row, so each one opens its thread and says where it stands.
  const rootRow = threaded && !message.threadRootId;
  const showsReplies = rootRow ? live || message.replyCount > 0 : message.replyCount > 0 || !!work;
  // The work line says more than “Handed over”: it takes its place. The assistant's own turn and Settled stay.
  const line = rootRow && live && !message.settled ? workLine : null;
  const shownStage =
    rootRow && stage && stage !== 'waiting' && !(line && stage === 'handedOver') ? stage : null;
  const lastReply =
    message.replyCount > 0 && message.lastReplyAt ? lastReplyLabel(message.lastReplyAt, now, timeZone) : null;
  const repliesLabel = rootRow
    ? threadRowLabel({
        replies:
          message.replyCount > 0
            ? [formatReplies(message.replyCount), lastReply].filter(Boolean).join(', ')
            : THREAD_STAGE_WORDS.noReplies,
        unread: threadNew ? THREAD_NEW_LABEL : null,
        stage: rootRow ? (line && stage === 'handedOver' ? null : stage) : null,
        assistant,
        text: [line?.spoken, message.text.length > 120 ? `${message.text.slice(0, 119)}…` : message.text]
          .filter(Boolean)
          .join(', '),
      })
    : undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is the mouse's shortcut; the keyboard opens the thread from its replies link, Reply in thread or the menu
    <article
      id={message.id}
      className={cx(
        styles.row,
        chat && styles.chatRow,
        chat && continued && styles.continued,
        selected && styles.selected,
        pending && styles.pending,
        (hasToolbar || menu) && styles.withMenu,
        openFromRow && styles.opensThread,
      )}
      aria-label={
        deleted ? `Deleted message, ${clock}` : self ? `Your message, ${clock}` : `${name}, ${clock}`
      }
      data-message-row=""
      data-self={self || undefined}
      data-deleted={deleted || undefined}
      data-selected={selected || undefined}
      onClick={openFromRow}
      onContextMenu={
        menu && !editor
          ? (event) => {
              // Links and text inputs keep the browser's own menu.
              if ((event.target as HTMLElement).closest('a, input, textarea')) return;
              menu(event, message);
            }
          : undefined
      }
    >
      {hasToolbar && (
        <MessageToolbar
          name={name}
          self={self}
          onSettle={settle}
          onReplyInThread={reply}
          onMenu={menu ? (event) => menu(event, message) : undefined}
          menuOpen={menuOpen}
          pickerOpen={pickerOpen}
        />
      )}
      <div className={cx(styles.avatar, chat && styles.chatAvatar)}>
        {chat && continued ? null : deleted ? (
          <DeletedAvatar size={chat ? 32 : 40} />
        ) : chat && author?.kind === 'agent' && !isAutomationPrincipal(author) ? (
          <ChatAgentFace agent={author} />
        ) : chat && author?.kind === 'person' ? (
          <PersonAvatar
            avatarUrl={author.avatarUrl}
            initials={author.initials}
            tone={author.tone}
            size={32}
          />
        ) : (
          <PrincipalAvatar principal={author} size={40} crop="bust" />
        )}
      </div>
      <div className={cx(styles.content, chat && styles.chatContent)}>
        {deleted ? (
          <DeletedText />
        ) : (
          <>
            <div className={cx(styles.meta, chat && continued && styles.srOnly)} data-message-meta="">
              {!self && <span className={cx(styles.name, chat && styles.chatName)}>{name}</span>}
              {/* An automation posts as itself (AP-997); the agent has no role to show (one-agent.md AP-4949). */}
              {!chat && author?.kind === 'agent' && isAutomationPrincipal(author) && (
                <span className={styles.automationBadge} data-automation-badge="">
                  <Icon icon={Workflow} size={11} />
                  Automation
                </span>
              )}
              {/* What answered it is the time's hover: a first message has no reply before it to have changed from. */}
              <time className={styles.time} dateTime={message.createdAt} title={ranOnTitle(message)}>
                {clock}
              </time>
              {settledTag && (
                <span className={styles.settledTag} data-settled-tag="">
                  {SETTLE_WORDS.settledTag}
                </span>
              )}
              {message.editedAt && <EditedLabel at={message.editedAt} timeZone={timeZone} />}
              {message.pinnedAt && (
                <PinnedMarker by={message.pinnedById ? lookup(message.pinnedById) : undefined} />
              )}
            </div>
            {editor ??
              (chip && !editor ? (
                // The chip follows the text where the line has room, else on the next line (AP-2405).
                <div className={cx(styles.withChip, chat && styles.chatWithChip)}>
                  {text && <MessageText text={text} className={cx(styles.body, chat && styles.chatBody)} />}
                  {chip}
                </div>
              ) : (
                text && <MessageText text={text} className={cx(styles.body, chat && styles.chatBody)} />
              ))}
            {/* What the Vault took from the text, under it (vault-self-serve.md AP-4007). */}
            {!editor && <VaultSavedLines message={message} />}
            {card && (
              // The seam for `<MessageCard>` (features/cards). `display: contents`: no box, no extra gap
              // while a card renders nothing; visual specs hide `[data-message-card]` to compare rows alone.
              <div className={styles.card} data-message-card="">
                {card}
              </div>
            )}
            {/* A council's thoughts and conclusion read as the message's own words, under its card. */}
            {card && !editor && underCard && (
              <MessageText text={underCard} className={cx(styles.body, chat && styles.chatBody)} />
            )}
            {!report && (
              <MessageAttachments
                attachments={
                  card ? attachmentsBesideCard(message.attachments, message.card) : message.attachments
                }
                conversationId={message.conversationId}
              />
            )}
            <LinkPreviews previews={message.previews} />
            <ReactionPills reactions={message.reactions} lookup={lookup} onToggle={onReact} />
            <RanOnNotes message={message} />
            {waiting && onAnswer && live ? (
              <div className={styles.waiting} data-waiting="">
                <span className={styles.waitingChip}>{CHAT_WORDS.waiting}</span>
                <button type="button" className={styles.answer} onClick={() => onAnswer(message)}>
                  {CHAT_WORDS.answer}
                </button>
              </div>
            ) : null}
          </>
        )}
        {showsReplies && (
          // One full-width row that opens the thread: faces, “3 replies”, “Last reply 10 hours ago” (only the time where
          // the row is narrow, so it stays on one line) and a chevron. In Chat and Feedback it says where the thread
          // stands too, and “No replies yet” before the first reply.
          <a
            href={threadHref ?? `?thread=${message.id}`}
            className={cx(styles.thread, line && styles.withWork)}
            onClick={openThread}
            aria-label={repliesLabel}
            data-thread-link=""
          >
            {message.replyCount > 0 ? (
              <>
                <span className={styles.heads} aria-hidden="true">
                  {message.threadParticipantIds.slice(0, 3).map((id) => (
                    <ThreadHead key={id} principal={lookup(id)} />
                  ))}
                </span>
                <span className={styles.replies}>{formatReplies(message.replyCount)}</span>
                {/* Spaces between the parts keep the link's name readable; a flex row doesn't draw them. */}{' '}
                {lastReply && <LastReply label={lastReply} />}{' '}
              </>
            ) : rootRow ? (
              <span className={styles.noReplies}>{THREAD_STAGE_WORDS.noReplies}</span>
            ) : null}
            {threadNew && (
              <span className={styles.newDot} role="img" aria-label={THREAD_NEW_LABEL} data-thread-new="" />
            )}
            {rootRow
              ? shownStage && (
                  <StageWord
                    stage={shownStage}
                    assistant={assistant}
                    since={work?.by === 't3code' ? (work.since ?? null) : null}
                  />
                )
              : work && (
                  <ThreadWorkLine work={work} agent={lookup(work.agentId)} alone={message.replyCount === 0} />
                )}
            <Icon icon={ChevronRight} size={16} className={styles.chevron} />
            {line && (
              <span className={styles.workSlot}>
                <WorkLine line={line} className={styles.workLine} />
              </span>
            )}
          </a>
        )}
        {after}
      </div>
    </article>
  );
}
