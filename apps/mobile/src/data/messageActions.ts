/**
 * The long-press menu on a message (Whombat essentials items 8, 11, 14; contracts CT-173, CT-174; AP-502…AP-505): the
 * quick reactions, then Settle thread or Open again on a thread's first message in Chat and Feedback (chat-settle.md
 * AP-6157), Reply in thread, Copy text, Copy link (MX-04), Save as prompt on the person's own in their Chat
 * (prompts-phone.md), Edit, Pin / Unpin and Delete, each only where the
 * viewer may and the runtime can (`messages.edit`, `messages.pins`). No Ask: a person's message in their Chat always
 * reaches the agent, and nothing is routed between agents (Whombat one-agent.md OA-07; app one-agent.md AP-4982). Pure:
 * the rules are core's (`canEditMessage`, `canDeleteMessage`, `canPinMessage`), the order and the words are the phone's,
 * and the delete confirmation says what happens.
 */
import { appPath, isJobResult, PROMPT_WORDS, SHARE_TEXT, withBurrow } from '@whombat/client';
import {
  type ConversationLink,
  canDeleteMessage,
  canEditMessage,
  canPinMessage,
  type Message,
  type MessageViewer,
  messageTextFits,
} from '@whombat/core';
import { SETTLE_COPY, type SettleOffer } from './threadSettle';

export type MessageActionKind =
  | 'settle'
  | 'open_again'
  | 'reply_thread'
  | 'copy_text'
  | 'copy_link'
  | 'save_prompt'
  | 'share'
  | 'share_from'
  | 'edit'
  | 'pin'
  | 'unpin'
  | 'delete';

export interface MessageAction {
  kind: MessageActionKind;
  label: string;
  destructive: boolean;
  /** What TalkBack adds after the label. */
  accessibilityHint: string;
  /** Shown, not tappable. */
  disabled?: boolean;
}

export interface MessageMenu {
  /** The quick reactions row and “More reactions”. */
  react: boolean;
  actions: MessageAction[];
}

export interface MessageMenuOptions {
  /** The menu opens inside a thread: the composer already replies there, so no “Reply in thread”. */
  inThread: boolean;
  /**
   * The runtime can edit and delete (`messages.edit`) and pin (`messages.pins`); `link`: the message has a web address
   * to copy (not in the demo world, MX-04).
   */
  features: { edit: boolean; pins: boolean; link?: boolean };
  /** A thread of the person's Chat can be shared by link here (share-links.md). */
  share?: boolean;
  /** The person's own messages in their Chat can be kept as a prompt (prompts-phone.md). */
  savePrompt?: boolean;
  /**
   * What the message's thread offers in a room (`settleOffer`): Settle thread, Open again, or nothing while the assistant
   * works on it or it waits for the person; absent outside Chat and Feedback's top level.
   */
  settle?: (m: Message) => SettleOffer;
}

const ACTIONS: Record<MessageActionKind, Omit<MessageAction, 'kind'>> = {
  settle: { label: SETTLE_COPY.settleThread, destructive: false, accessibilityHint: SETTLE_COPY.settleHint },
  open_again: {
    label: SETTLE_COPY.openAgain,
    destructive: false,
    accessibilityHint: SETTLE_COPY.openAgainHint,
  },
  reply_thread: {
    label: 'Reply in thread',
    destructive: false,
    accessibilityHint: 'Opens the thread on this message',
  },
  copy_text: { label: 'Copy text', destructive: false, accessibilityHint: 'Copies the message’s text' },
  copy_link: {
    label: 'Copy link',
    destructive: false,
    accessibilityHint: 'Copies a link that opens this message',
  },
  save_prompt: {
    label: PROMPT_WORDS.saveFromMessage,
    destructive: false,
    accessibilityHint: 'Keeps its words to use again',
  },
  share: {
    label: SHARE_TEXT.shareMenu,
    destructive: false,
    accessibilityHint: 'Makes a link to a copy of this thread',
  },
  share_from: {
    label: SHARE_TEXT.shareFromMenu,
    destructive: false,
    accessibilityHint: 'Makes a link to a copy of the thread from this message on',
  },
  edit: { label: 'Edit', destructive: false, accessibilityHint: 'Changes the text of your message' },
  pin: { label: 'Pin', destructive: false, accessibilityHint: 'Pins it in this conversation' },
  unpin: { label: 'Unpin', destructive: false, accessibilityHint: 'Takes it off the pinned messages' },
  delete: { label: 'Delete', destructive: true, accessibilityHint: 'Asks first' },
};

/** Messages still on their way (the optimistic copy) have no menu yet. */
export function isSending(m: Pick<Message, 'id'>): boolean {
  return m.id.startsWith('msg_local-');
}

/** The menu for a message, or null when it has none (still sending). */
export function messageMenu(
  m: Message,
  viewer: MessageViewer | undefined,
  options: MessageMenuOptions,
): MessageMenu | null {
  if (isSending(m)) return null;
  const kinds: MessageActionKind[] = [];
  // First, as the web's toolbar has it (AP-6150): a room's thread puts away or comes back.
  const offer = !options.inThread && m.threadRootId === null && !m.deletedAt ? options.settle?.(m) : null;
  if (offer) kinds.push(offer);
  // A thread starts on any top-level message (item 11); a reply is already in one.
  if (!options.inThread && m.threadRootId === null) kinds.push('reply_thread');
  // A tombstone has no text left to copy; its link still opens where it was (MX-04).
  if (!m.deletedAt && m.text.trim()) kinds.push('copy_text');
  if (options.features.link) kinds.push('copy_link');
  if (options.savePrompt && viewer && m.authorId === viewer.id && !m.deletedAt && m.text.trim())
    kinds.push('save_prompt');
  if (options.share && !m.deletedAt) kinds.push(m.threadRootId === null ? 'share' : 'share_from');
  // A job's result is T3 Code's report, which T3 Code writes again: nobody edits it in place (job-result.md).
  if (options.features.edit && canEditMessage(m, viewer) && !isJobResult(m)) kinds.push('edit');
  if (options.features.pins && canPinMessage(m, viewer)) kinds.push(m.pinnedAt ? 'unpin' : 'pin');
  if (options.features.edit && canDeleteMessage(m, viewer)) kinds.push('delete');
  return { react: !m.deletedAt, actions: kinds.map(messageAction) };
}

/**
 * What a thread's first message in Chat or Feedback swipes left to: its menu's Settle thread at the edge, or Open again
 * on a settled one shown in place, with More (the whole menu) beside it; only More while the assistant works on it or
 * it waits for the person. No swipe inside a thread, in a pull request's room or on a message still on its way.
 */
export type MessageSwipe = 'settle' | 'open_again' | 'more' | null;

export function messageSwipe(menu: MessageMenu | null, roomTop: boolean): MessageSwipe {
  if (!roomTop || !menu) return null;
  for (const { kind, disabled } of menu.actions)
    if ((kind === 'settle' || kind === 'open_again') && !disabled) return kind;
  return 'more';
}

/** An action with its words, as every menu on a message or a thread shows it. */
export function messageAction(kind: MessageActionKind): MessageAction {
  return { kind, ...ACTIONS[kind] };
}

/** The viewer as the message rules see them, from the bootstrap's `me`: the person, who may delete any message. */
export function messageViewer(me: { id: string }): MessageViewer {
  return { id: me.id, kind: 'person' };
}

/**
 * Asked before deleting (CT-173, AP-553): the message goes, and a thread's first message takes its replies with it.
 * Deleting the agent's message says whose it is.
 */
export function deleteConfirm(
  m: Pick<Message, 'authorId' | 'replyCount' | 'threadRootId'>,
  viewerId: string,
  authorName: string,
): { title: string; body: string; cta: string } {
  const title = m.authorId === viewerId ? 'Delete this message?' : `Delete ${authorName}’s message?`;
  const body =
    m.threadRootId === null && m.replyCount > 0
      ? 'It’s removed from this conversation, with its replies.'
      : 'It’s removed from this conversation.';
  return { title, body, cta: 'Delete' };
}

/**
 * Whether an edit can be saved: the text changed, fits, and isn't empty — unless the message has files, which may
 * carry it alone (CT-173).
 */
export function canSaveEdit(original: string, draft: string, hasAttachments: boolean): boolean {
  const next = draft.trim();
  if (next === original.trim()) return false;
  if (!next && !hasAttachments) return false;
  return messageTextFits(next);
}

/** Why Save is held back, for the line under the editor (null when it can be saved or nothing was typed yet). */
export function editProblem(original: string, draft: string, hasAttachments: boolean): string | null {
  const next = draft.trim();
  if (!next && !hasAttachments && original.trim()) return 'A message needs some text.';
  if (next && !messageTextFits(next)) return 'That message is too long.';
  return null;
}

/** What a copy says when it worked (MX-04). */
export const COPIED_TEXT = {
  text: 'Copied the text.',
  link: 'Copied the link.',
  code: 'Copied the code.',
} as const;

/**
 * The web path a copied link opens (MX-04, the web's WX-06): the conversation with the message's `#msg_…` fragment, a
 * reply in its thread (`?thread=<root>#<reply>`), for the burrow it is in (`?burrow=`). The phone opens the same link
 * at the message (`appScreenUrlForPath`, MX-03).
 */
export function messageLinkPath(
  m: Pick<Message, 'id' | 'threadRootId'>,
  where: ConversationLink,
  burrow: string,
): string {
  const path = appPath(
    m.threadRootId
      ? { type: 'message', in: where, messageId: m.id, threadRootId: m.threadRootId }
      : { type: 'message', in: where, messageId: m.id },
  );
  // A reply's link names its thread; the fragment names the reply in it.
  return withBurrow(m.threadRootId ? `${path}#${m.id}` : path, burrow);
}
