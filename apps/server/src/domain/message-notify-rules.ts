/**
 * Who a message notifies, and as what (docs/decisions/essentials-people.md EP-11…EP-13). Pure: `notifyForMessage`
 * (message-notify.ts) loads the facts and hands them here. The per-person rule is core's `notifyReason` (CT-175):
 * the author never; `none` nothing; then a mention, a reply in a thread they're in (when `threadReplies`), and at `all`
 * any other message. There are no channels to broadcast to (one-agent.md OA-04).
 */
import {
  type ConversationKind,
  type NotificationKind,
  type NotifyLevel,
  type NotifyReason,
  notifyReason,
} from '@whombat/core';

/** The message, as the rules see it. */
export interface MessageFacts {
  kind: ConversationKind;
  authorId: string;
  authorKind: 'person' | 'agent';
  /** Principals the message mentions (resolved `@Name`s). */
  mentionIds: readonly string[];
  /** A thread reply (not a thread root or a top-level message). */
  isReply: boolean;
}

/** The person who reads the conversation, with what the rules need of them. */
export interface NotifyRecipient {
  id: string;
  /** Their own level here (`conversations.notify`); null = the kind's default. */
  notify: NotifyLevel | null;
  /** `Preferences.notifications.threadReplies` (default true). */
  threadReplies: boolean;
  /** They wrote the thread's root or a reply in it, or were mentioned in it. */
  inThread: boolean;
}

export interface MessageNotifyOptions {
  /**
   * An edit (contracts `addedMentions`, messages.edit): only these people, newly mentioned by it, are told — once, as a
   * mention; nothing else is sent again (item 8).
   */
  addedMentions?: readonly string[] | null;
  /** Mentioned people get nothing from this message. */
  notifyMentions?: boolean;
  /** The DM's person isn't told about the agent's message (a guide step they clicked for, AG-03). */
  notifyDmPerson?: boolean;
}

export interface PlannedNotification {
  principalId: string;
  kind: NotificationKind;
  reason: NotifyReason;
}

/**
 * The inbox kind for a reason (EP-13): a mention is a `mention`, a thread reply a `reply`. At level `all`: a thread reply
 * is a `reply`, the agent's message an `agent_update`; another person's top-level message makes none (one-agent.md
 * OA-S60: there is no `direct` kind without conversations between people).
 */
export function notificationKindFor(
  reason: NotifyReason,
  facts: Pick<MessageFacts, 'isReply' | 'authorKind'>,
): NotificationKind | null {
  switch (reason) {
    case 'mention':
      return 'mention';
    case 'reply':
      return 'reply';
    case 'all':
      if (facts.isReply) return 'reply';
      return facts.authorKind === 'agent' ? 'agent_update' : null;
  }
}

/** The notifications one message makes, one per person at most, in recipient order. */
export function planMessageNotifications(
  facts: MessageFacts,
  recipients: readonly NotifyRecipient[],
  options: MessageNotifyOptions = {},
): PlannedNotification[] {
  const out: PlannedNotification[] = [];
  const added = options.addedMentions ? new Set(options.addedMentions) : null;
  for (const r of recipients) {
    if (r.id === facts.authorId) continue;
    const mentioned = facts.mentionIds.includes(r.id);
    if (options.notifyMentions === false && mentioned) continue;
    let reason: NotifyReason | null;
    if (added) {
      // An edit tells only the people it newly mentions, and only as a mention (their level still applies).
      if (!added.has(r.id) || !mentioned) continue;
      reason = notifyReason({
        kind: facts.kind,
        notify: r.notify,
        recipientId: r.id,
        authorId: facts.authorId,
        mentionIds: [r.id],
      });
      if (reason !== 'mention') continue;
    } else {
      reason = notifyReason({
        kind: facts.kind,
        notify: r.notify,
        recipientId: r.id,
        authorId: facts.authorId,
        mentionIds: facts.mentionIds,
        inThread: facts.isReply && r.inThread,
        threadReplies: r.threadReplies,
      });
    }
    if (!reason) continue;
    if (options.notifyDmPerson === false && facts.kind === 'dm' && reason === 'all') continue;
    const kind = notificationKindFor(reason, facts);
    if (kind) out.push({ principalId: r.id, reason, kind });
  }
  return out;
}
