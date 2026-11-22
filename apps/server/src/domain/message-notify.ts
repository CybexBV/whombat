/**
 * The notifications a message makes (docs/decisions/essentials-people.md EP-11…EP-13): per person and conversation
 * level (`all` / `mentions` / `none`), mentions, replies in threads they're in and the agent's updates in a person's
 * own rooms. Run after the message's commit (`postMessage`, and an edit that adds
 * mentions). The rule itself is pure (`message-notify-rules.ts`); this loads what it needs and hands the rows to
 * `notify` (inbox, realtime, push held back in quiet time).
 *
 * The entry point for other streams: `notifyForMessage(services, {burrow, messageId})` after a post, and
 * `notifyForMessage(services, {burrow, messageId, addedMentions})` after an edit (only the people it newly mentions,
 * once each: every message notification carries the dedup key `msg:<messageId>`).
 */
import {
  conversationLabel,
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferencesOf,
  type Preferences,
  plainMessageText,
} from '@whombat/core';
import { eq, or } from 'drizzle-orm';
import { accounts, messages, principals } from '../db/schema/index';
import { deskReaderOf } from '../desk/talk-mark';
import { isLookThread } from '../looks/threads';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import type { Services } from '../services';
import { linkOfMessage } from './links';
import {
  type MessageNotifyOptions,
  type NotifyRecipient,
  planMessageNotifications,
} from './message-notify-rules';
import { type NotificationDraft, notify } from './notify';
import { threadPushGroup, withoutCodeBlocks } from './push-preview';
import { thePerson } from './the-person';

export type { MessageNotifyOptions } from './message-notify-rules';

export interface NotifyForMessageInput extends MessageNotifyOptions {
  burrow: { id: string; slug: string };
  messageId: string;
  /**
   * A message told again for another reason (a council's card when it needs the person, and when it ended): its own
   * dedup key and time, so it isn't taken for the message's first notice.
   */
  again?: {
    dedupKey: string;
    at: Date;
    /** What the notice says instead of the message's own words (a report updated in place says so). */
    text?: string;
  };
}

/** The dedup key of a message's notifications: one row per person and message, whatever edits follow. */
export function messageDedupKey(messageId: string): string {
  return `msg:${messageId}`;
}

/** Who is in the message's thread: the root's author, every reply's author, and everyone mentioned in it. */
async function threadPeople(services: Services, rootId: string): Promise<Set<string>> {
  const rows = await services.db
    .select({ authorId: messages.authorId, mentions: messages.mentions })
    .from(messages)
    .where(or(eq(messages.id, rootId), eq(messages.threadRootId, rootId)));
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.authorId);
    for (const m of r.mentions) out.add(m);
  }
  return out;
}

/**
 * Notifies the people a message is for (EP-11). Never throws for a message that is gone (deleted before the hook
 * ran): nothing is sent then.
 */
export async function notifyForMessage(services: Services, input: NotifyForMessageInput): Promise<void> {
  const db = services.db;
  const message = await loadMessageRow(db, input.messageId);
  if (!message || message.burrowId !== input.burrow.id) return;
  const conversation = await loadConversationRow(db, message.conversationId);
  if (!conversation) return;
  const [author] = await db
    .select({ kind: principals.kind })
    .from(principals)
    .where(eq(principals.id, message.authorId));
  if (!author) return;

  // The one who can read it: the person, at their level for this conversation; agents have no inbox.
  const person = await thePerson(db, conversation.burrowId);
  if (!person) return;
  // A Chat of someone who was on the box before it was one person's is history: nobody hears about it.
  if (conversation.kind === 'dm' && conversation.dmPersonId && conversation.dmPersonId !== person.id) return;
  const [account] = person.accountId
    ? await db
        .select({ preferences: accounts.preferences })
        .from(accounts)
        .where(eq(accounts.id, person.accountId))
    : [];

  const rootId = message.threadRootId;
  // A look's thread never pushes or lands in the inbox: the look itself tells the person (look-research.md LR-04).
  if (author.kind === 'agent' && rootId && (await isLookThread(db, rootId))) return;
  const inThread = rootId ? await threadPeople(services, rootId) : new Set<string>();
  const recipients: NotifyRecipient[] = [
    {
      id: person.id,
      notify: conversation.notify ?? null,
      threadReplies: prefsOf(account?.preferences).threadReplies,
      inThread: inThread.has(person.id),
    },
  ];
  const planned = planMessageNotifications(
    {
      kind: conversation.kind,
      authorId: message.authorId,
      authorKind: author.kind === 'person' ? 'person' : 'agent',
      mentionIds: message.mentions,
      isReply: rootId !== null,
    },
    recipients,
    input,
  );
  if (planned.length === 0) return;

  // The assistant's answer to a desk question while its person reads the unlocked desk screen: no push (DK-T13).
  const deskReader =
    author.kind === 'agent' && rootId
      ? await deskReaderOf(services, {
          authorKind: 'agent',
          root: (await loadMessageRow(db, rootId)) ?? null,
        })
      : null;
  const link = await linkOfMessage(db, conversation, message.id, rootId);
  // Inbox rows and push show plain text: “**Worth a look**” reads “Worth a look” there (RM-03).
  // A council is told by the words under its card (the go-ahead it asks, its conclusion), not the question above it; a
  // delegation by its summary (delegate.md).
  const said =
    ((message.card?.kind === 'council' || message.card?.kind === 'delegation') && message.card.note) ||
    message.text;
  const text =
    input.again?.text ??
    (plainMessageText(said) || said || (message.attachmentIds.length ? 'Shared a file.' : ''));
  // A push preview never shows code: fenced blocks read “(code)” there (NT-14).
  const previewText = message.outsidersRun
    ? 'There’s an update in your conversation.'
    : (input.again?.text ?? (plainMessageText(withoutCodeBlocks(said)) || text));
  const group = threadPushGroup(conversation.id, rootId);
  const drafts: NotificationDraft[] = planned.map((p) => ({
    burrowId: input.burrow.id,
    burrowSlug: input.burrow.slug,
    principalId: p.principalId,
    kind: p.kind,
    actorId: message.authorId,
    // An agent's message in its DM reads “Direct” (as before); everything else names the conversation.
    where:
      conversation.kind === 'dm' && p.kind === 'agent_update' ? 'Direct' : conversationLabel(conversation),
    text,
    previewText,
    group,
    link,
    createdAt: input.again?.at ?? message.createdAt,
    dedupKey: input.again?.dedupKey ?? messageDedupKey(message.id),
    messageId: message.id,
    ...(p.principalId === deskReader ? { pushHeld: true } : {}),
  }));
  await notify(services, drafts);
}

function prefsOf(preferences: Preferences | null | undefined) {
  return preferences ? notificationPreferencesOf(preferences) : DEFAULT_NOTIFICATION_PREFERENCES;
}
