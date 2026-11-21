/**
 * Which actions a message offers (docs/decisions/essentials-messages.md AP-440): the hover toolbar and the message menu
 * read the same list, from core's rules (`canEditMessage`, `canDeleteMessage`, `canPinMessage`; CT-173, CT-174) and
 * what the connected Whombat can do (`messages.edit`, `messages.pins`). Pure, so the rules are tested once.
 */
import {
  canDeleteMessage,
  canEditMessage,
  canPinMessage,
  isDeletedMessage,
  type Message,
  type MessageViewer,
  type Principal,
  plainMessageText,
} from '@whombat/core';

export type MessageAction = 'reply' | 'react' | 'edit' | 'pin' | 'unpin' | 'delete';

export interface MessageActionContext {
  viewer: MessageViewer | undefined;
  /** `thread`: in the thread pane, where every message already is in a thread (no “Reply in thread”). */
  place: 'room' | 'thread';
}

/** The viewer as core's rules take it: the person, or an agent. */
export function messageViewer(me: Principal | undefined): MessageViewer | undefined {
  if (!me) return undefined;
  return me.kind === 'person' ? { id: me.id, kind: 'person' } : { id: me.id, kind: 'agent' };
}

/**
 * The actions for one message, in menu order. A message still being sent has none; a tombstone has none (its thread
 * link stays). “Reply in thread” is on every top-level message, so a thread can start anywhere (item 11).
 */
export function messageActions(
  m: Pick<Message, 'id' | 'authorId' | 'card' | 'threadRootId' | 'deletedAt' | 'pinnedAt' | 'jobResult'>,
  { viewer, place }: MessageActionContext,
): MessageAction[] {
  if (m.id.startsWith('msg_local-') || isDeletedMessage(m)) return [];
  const out: MessageAction[] = [];
  if (place === 'room' && m.threadRootId === null) out.push('reply');
  out.push('react');
  // A job's result is T3 Code's report, which T3 Code rewrites: nobody edits it here.
  if (canEditMessage(m, viewer) && !m.jobResult) out.push('edit');
  if (canPinMessage(m, viewer)) out.push(m.pinnedAt ? 'unpin' : 'pin');
  if (canDeleteMessage(m, viewer)) out.push('delete');
  return out;
}

/**
 * The message the ↑ key edits from an empty composer: the viewer's newest one they may edit, among messages in view
 * (a message still being sent is skipped).
 */
export function lastEditable(messages: readonly Message[], ctx: MessageActionContext): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m.authorId !== ctx.viewer?.id) continue;
    if (messageActions(m, ctx).includes('edit')) return m;
  }
  return undefined;
}

/** The start of a message's words for the delete dialog, on one line. */
export function messageExcerpt(text: string, max = 160): string {
  const plain = plainMessageText(text).replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/**
 * What the delete dialog says (AP-442, AP-553): where it goes from, and that a thread's replies go with it; the agent's
 * message names the agent.
 */
export function deleteMessageText(
  m: Pick<Message, 'authorId' | 'replyCount'>,
  viewerId: string | undefined,
  authorName: string,
  where: string,
): string {
  const own = m.authorId === viewerId;
  const replies =
    m.replyCount > 0 ? `, with its ${m.replyCount === 1 ? 'reply' : `${m.replyCount} replies`}` : '';
  const gone = where ? `It’s removed from ${where}${replies}.` : `It’s removed${replies}.`;
  const who = own ? '' : `You’re removing ${authorName}’s message. `;
  return `${who}${gone}`;
}
