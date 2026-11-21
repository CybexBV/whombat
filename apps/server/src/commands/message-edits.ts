/**
 * Editing, deleting and pinning messages (docs/decisions/essentials-conversations.md EC-02…EC-16; contracts CT-173,
 * CT-174). Every write is a command with a signed event that names ids only — never the words.
 *
 * - Edit (`edit_message`, the person, their own messages, not cards): new text, `editedAt`; mentions and `@channel` /
 *   `@here` are read again; an agent newly mentioned is woken once (unless it was woken by this message already), a
 *   person newly mentioned is told once; search, link previews and agents' memory follow the new words.
 * - Delete (`delete_message`, the person: their own and the agent's, one-person.md OP-S07): a message is removed (`message.deleted`),
 *   a thread's first message with the whole thread (EC-04b), unless work still lives there (`cardsWithWork`, EC-04c).
 *   Its files' bytes go when nothing else uses them; its search document, inbox rows and the agent's sessions that saw it go
 *   too. A reply removed updates its thread's counts; a tombstone left without replies goes.
 * - Pin (`pin_message`, the person in the conversation): at most `PINS_MAX` per conversation.
 */
import {
  addedMentions,
  canDeleteMessage,
  canEditMessage,
  canonicalizeMentions,
  canPinMessage,
  conversationLabel,
  type DispatchTrigger,
  MESSAGE_TOO_LONG,
  MessageId,
  MessageTextInput,
  messageTextFits,
  PINS_MAX,
  resolveMentions,
  type StoredCard,
  topics,
} from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  approvals,
  attachments,
  conversations,
  dispatches,
  feedbackReports,
  messages,
  plans,
  principals,
  reactions,
  runs,
  searchDocuments,
} from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { linkOfMessage } from '../domain/links';
import {
  dropMessageNotifications,
  forgetStaleContext,
  refreshMessageNotifications,
} from '../domain/message-edits';
import { notifyForMessage } from '../domain/message-notify';
import { mentionTargets, publishUnread, unreadKey, wouldWakeAgent } from '../domain/messages';
import { indexMessage } from '../domain/search-index';
import { publishFilesChanged } from '../files/space-commands';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { previewUrls } from '../previews/extract';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadMessages, type MessageRow } from '../read/messages';

/**
 * A failed turn's retry card stays while it is in the conversation (EC-04, R1); in a thread it goes with the thread.
 * Every other card stays only while its work is going on (`cardsWithWork`, EC-04c).
 */
const RETRY_CARD: StoredCard['kind'] = 'turn_failed';

/**
 * A report is still being worked on: its assessment queued, running or paused, its status “In progress”, or a
 * request for development waiting for its yes. Otherwise its message is deleted like any other (EC-04a); the report
 * itself stays in Feedback.
 */
async function reportHoldsWork(tx: Tx, reportId: string): Promise<boolean> {
  const [report] = await tx
    .select({
      status: feedbackReports.status,
      assessmentState: feedbackReports.assessmentState,
      handoffApprovalId: feedbackReports.handoffApprovalId,
    })
    .from(feedbackReports)
    .where(eq(feedbackReports.id, reportId));
  if (!report) return false;
  if (['queued', 'running', 'paused'].includes(report.assessmentState)) return true;
  if (report.status === 'in_progress') return true;
  if (!report.handoffApprovalId) return false;
  const [approval] = await tx
    .select({ state: approvals.state })
    .from(approvals)
    .where(eq(approvals.id, report.handoffApprovalId));
  return approval?.state === 'pending';
}

const viewerOf = (ctx: ApplyContext) => ({
  id: ctx.actor.id,
  kind: ctx.actor.kind,
});

/** The message (of this burrow) and its conversation (404 otherwise). */
async function messageInReach(ctx: ApplyContext, messageId: string, lock = false) {
  const query = ctx.tx.select().from(messages).where(eq(messages.id, messageId));
  const [row] = lock ? await query.for('update') : await query;
  if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Message');
  const conversation = await loadConversationRow(ctx.tx, row.conversationId);
  if (!conversation) throw notFound('Message');
  return { row, conversation };
}

async function publishMessage(ctx: ApplyContext, row: MessageRow, eventId: string | null) {
  const [message] = await loadMessages(ctx.tx, [row], null);
  if (message)
    ctx.publish(topics.conversation(row.conversationId), { type: 'message.updated', message }, { eventId });
  return message;
}

/* Edit ------------------------------------------------------------------------------------------ */

export const editMessage = defineCommand({
  name: 'edit_message',
  schema: z.object({ messageId: MessageId, text: MessageTextInput }),
  async apply(tx, ctx, input) {
    const { row, conversation } = await messageInReach(ctx, input.messageId, true);
    if (row.deletedAt) throw notFound('Message');
    if (ctx.actor.kind !== 'person') throw forbidden('Agents don’t edit messages.');
    if (row.card) throw badRequest('Cards can’t be edited.');
    if (!canEditMessage({ authorId: row.authorId, card: null, deletedAt: null }, viewerOf(ctx)))
      throw forbidden('You can only edit your own messages.');
    const targets = await mentionTargets(ctx, ctx.burrow.id);
    // Stored canonical, like a send (messaging.md MS-C02): `@dusty` is kept as `@Dusty`, so changing only a mention's
    // letter case is no edit.
    const text = canonicalizeMentions(input.text.trim(), targets);
    if (!text && row.attachmentIds.length === 0) throw badRequest('Say something first.');
    if (!messageTextFits(text)) throw badRequest(MESSAGE_TOO_LONG);
    if (text === row.text) {
      const [same] = await loadMessages(tx, [row], ctx.actor.id);
      if (!same) throw notFound('Message');
      return { message: same, eventId: null as string | null };
    }

    const mentions = resolveMentions(text, targets).filter((m) => m !== ctx.actor.id);
    const added = addedMentions(row.mentions, mentions);
    // Previews of links still in the text stay; new links are fetched after the commit.
    const links = new Set(previewUrls(text));
    const previews = (row.previews ?? []).filter((p) => links.has(p.url));
    // A lapsed licence refuses a person's edit that would wake an agent, as it refuses such a send (LC-10).
    const wakes = targets.filter((t) => t.kind === 'agent' && added.includes(t.id)).map((t) => t.id);
    if (ctx.services.licence.lapsed && wakes.length && (await wouldWakeAgent(ctx, conversation, text)))
      ctx.services.licence.assertNotLapsed();

    const [updated] = await tx
      .update(messages)
      .set({
        text,
        mentions,
        previews: previews.length ? previews : null,
        editedAt: ctx.now,
      })
      .where(eq(messages.id, row.id))
      .returning();
    if (!updated) throw notFound('Message');
    const link = await linkOfMessage(tx, conversation, row.id, row.threadRootId);
    const event = await ctx.emit({
      type: 'message.edited',
      kind: 'Messages',
      text: null,
      where: conversationLabel(conversation),
      ref: link,
      payload: {
        messageId: row.id,
        conversationId: conversation.id,
        threadRootId: row.threadRootId,
        addedMentions: added,
      },
    });
    const message = await publishMessage(ctx, updated, event.id);
    if (!message) throw notFound('Message');
    await refreshMessageNotifications(tx, row.id, text);
    await forgetStaleContext(ctx, {
      conversationId: conversation.id,
      createdAt: row.createdAt,
    });

    const services = ctx.services;
    const burrow = { id: ctx.burrow.id, slug: ctx.burrow.slug };
    const actorId = ctx.actor.id;
    const at = ctx.now;
    ctx.after(async () => {
      await indexMessage(services.db, row.id);
      if (row.threadRootId) await indexMessage(services.db, row.threadRootId);
    });
    ctx.after(async () => services.linkPreviews.schedule(row.id));
    // A newly mentioned agent is woken once, like a send; never twice for the same message (CT-173). Agents are never
    // in a direct conversation, and only members are woken (enqueueDispatches), so a mention there wakes nobody.
    if (wakes.length)
      ctx.after(async () => {
        const woken = await services.db
          .select({ agentId: dispatches.agentId })
          .from(dispatches)
          .where(and(eq(dispatches.messageId, row.id), inArray(dispatches.agentId, wakes)));
        const already = new Set(woken.map((w) => w.agentId));
        const requests = wakes
          .filter((id) => !already.has(id))
          .map((agentId) => ({ agentId, trigger: 'mention' as DispatchTrigger }));
        if (requests.length === 0) return;
        await enqueueDispatches(services, {
          burrowId: burrow.id,
          causedById: actorId,
          conversationId: conversation.id,
          messageId: row.id,
          threadRootId: row.threadRootId,
          requests,
          at,
        });
      });
    // A person the edit newly mentions is told once, as for a send (the notification service's rules, EP-11).
    if (added.length)
      ctx.background('message notifications', () =>
        notifyForMessage(services, { burrow, messageId: row.id, addedMentions: added }),
      );
    return { message, eventId: event.id as string | null };
  },
});

/* Delete ---------------------------------------------------------------------------------------- */

/**
 * Removes messages' files (rows now, bytes after the commit when nothing else uses them). A file that was saved straight
 * into Files before it was sent, and is still in Files, stays there without its message (files-space.md FS-06, FS-D01).
 * Returns whether the conversation's Files changed.
 */
async function dropFiles(ctx: ApplyContext, messageIds: readonly string[]): Promise<boolean> {
  if (messageIds.length === 0) return false;
  const kept = await ctx.tx
    .update(attachments)
    .set({ messageId: null })
    .where(
      and(
        inArray(attachments.messageId, [...messageIds]),
        isNotNull(attachments.filedAt),
        isNull(attachments.filesRemovedAt),
      ),
    )
    .returning({ id: attachments.id });
  const gone = await ctx.tx
    .delete(attachments)
    .where(inArray(attachments.messageId, [...messageIds]))
    .returning({
      blobKey: attachments.blobKey,
      state: attachments.state,
      filesRemovedAt: attachments.filesRemovedAt,
    });
  const changed = gone.some((g) => g.state === 'ready' && g.filesRemovedAt === null) || kept.length > 0;
  const keys = [...new Set(gone.map((g) => g.blobKey).filter((k): k is string => !!k))];
  if (keys.length === 0) return changed;
  const files = ctx.services.files;
  ctx.after(async () => {
    for (const key of keys) await files.removeIfUnused(key);
  });
  return changed;
}

/** A thread root's counters from the replies it has left. */
async function recountThread(tx: Tx, rootId: string) {
  const replies = await tx
    .select({ authorId: messages.authorId, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.threadRootId, rootId))
    .orderBy(messages.createdAt, messages.ord);
  const participants: string[] = [];
  for (const r of replies) {
    const i = participants.indexOf(r.authorId);
    if (i >= 0) participants.splice(i, 1);
    participants.push(r.authorId);
  }
  const [root] = await tx
    .update(messages)
    .set({
      replyCount: replies.length,
      lastReplyAt: replies.at(-1)?.createdAt ?? null,
      threadParticipantIds: participants.slice(-3),
    })
    .where(eq(messages.id, rootId))
    .returning();
  return root;
}

/** Deletes one message row for good (its reactions first: they reference it). */
async function removeRow(ctx: ApplyContext, row: MessageRow) {
  await ctx.tx.delete(reactions).where(eq(reactions.messageId, row.id));
  await ctx.tx.delete(searchDocuments).where(eq(searchDocuments.id, row.id));
  await ctx.tx.delete(messages).where(eq(messages.id, row.id));
}

/**
 * Deleting a thread's first message removes the whole thread (EC-04b), unless work still lives in it: a reply's card
 * for work that is still going on (`cardsWithWork`; a failed turn's retry goes with the thread), an agent's turn queued or running there, or
 * — for anyone but the person — a reply of the person's.
 */
async function assertThreadRemovable(ctx: ApplyContext, root: MessageRow, replies: readonly MessageRow[]) {
  const tx = ctx.tx;
  if ((await cardsWithWork(tx, replies)).size)
    throw conflict('This thread holds work in progress, so it stays.');
  const ids = [root.id, ...replies.map((r) => r.id)];
  const [busy] = await tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        inArray(dispatches.state, ['queued', 'claimed', 'running']),
        or(eq(dispatches.threadRootId, root.id), inArray(dispatches.messageId, ids)),
      ),
    )
    .limit(1);
  if (busy) throw conflict('An agent is still working in this thread, so it stays.');
  if (ctx.actor.kind === 'person') return;
  const others = [...new Set(replies.map((r) => r.authorId).filter((id) => id !== ctx.actor.id))];
  if (others.length === 0) return;
  const [person] = await tx
    .select({ id: principals.id })
    .from(principals)
    .where(and(inArray(principals.id, others), eq(principals.kind, 'person')))
    .limit(1);
  if (person) throw forbidden('You replied in this thread, so only you can remove it.');
}

export const deleteMessage = defineCommand({
  name: 'delete_message',
  schema: z.object({ messageId: MessageId }),
  async apply(tx, ctx, input) {
    const { row, conversation } = await messageInReach(ctx, input.messageId, true);
    if (ctx.actor.kind !== 'person') throw forbidden('Agents don’t delete messages.');
    const isRoot = row.threadRootId === null;
    // A first message kept as a tombstone for its replies (before EC-04b) is removed with them now; any other
    // tombstone is deleting twice (a retry), which answers with the tombstone that is there.
    const legacyTombstone = row.deletedAt !== null && isRoot && row.replyCount > 0;
    if (row.deletedAt && !legacyTombstone) {
      const [tomb] = await loadMessages(tx, [row], ctx.actor.id);
      return { messageId: row.id, message: tomb ?? null, eventId: null as string | null };
    }
    if (!canDeleteMessage({ authorId: row.authorId, deletedAt: null }, viewerOf(ctx)))
      throw forbidden('You can only delete your own messages.');
    if (row.card && (row.card.kind === RETRY_CARD || (await cardsWithWork(tx, [row])).size))
      throw conflict('This message holds work in progress, so it stays.');

    const moderation = row.authorId !== ctx.actor.id;
    const replies =
      isRoot && row.replyCount > 0
        ? await tx.select().from(messages).where(eq(messages.threadRootId, row.id)).for('update')
        : [];
    if (replies.length) await assertThreadRemovable(ctx, row, replies);
    const where = conversationLabel(conversation);
    const removed: string[] = [];
    const changed: MessageRow[] = [];
    const filesChanged = await dropFiles(ctx, [row.id, ...replies.map((r) => r.id)]);
    // The whole thread: its replies, then the first message.
    for (const reply of replies) {
      await removeRow(ctx, reply);
      removed.push(reply.id);
    }
    await removeRow(ctx, row);
    removed.push(row.id);
    if (row.threadRootId) {
      const root = await recountThread(tx, row.threadRootId);
      // A deleted root kept only for its replies (before EC-04b) goes with its last one.
      if (root?.deletedAt && root.replyCount === 0) {
        await removeRow(ctx, root);
        removed.push(root.id);
      } else if (root) changed.push(root);
    }
    await dropMessageNotifications(tx, [row.id, ...removed]);
    await forgetStaleContext(ctx, {
      conversationId: conversation.id,
      createdAt: row.createdAt,
    });
    const event = await ctx.emit({
      type: 'message.deleted',
      kind: 'Messages',
      text: null,
      where,
      aboutId: row.authorId,
      payload: {
        messageId: row.id,
        conversationId: conversation.id,
        threadRootId: row.threadRootId,
        removed: true,
        replies: replies.length,
        moderation,
      },
    });
    for (const id of removed)
      ctx.publish(
        topics.conversation(conversation.id),
        { type: 'message.deleted', conversationId: conversation.id, messageId: id },
        { eventId: event.id },
      );
    for (const m of changed) await publishMessage(ctx, m, event.id);
    // Its files left the conversation's Files (files-space.md FS-06).
    if (filesChanged) await publishFilesChanged(ctx, conversation.id, { eventId: event.id });
    const services = ctx.services;
    // The thread root's search document follows its reply count (THREAD / MESSAGE); unread badges follow a removal, a
    // reply's too: Chat and Feedback count their threads with something new, and that may have been the only new reply.
    const root = row.threadRootId;
    if (root && !removed.includes(root)) ctx.after(async () => indexMessage(services.db, root));
    ctx.background(
      'unread badges',
      () => publishUnread(services, conversation.burrowId, conversation.id, null),
      unreadKey(conversation.id),
    );
    return { messageId: row.id, message: null, eventId: event.id as string | null };
  },
});

/* Clear ----------------------------------------------------------------------------------------- */

/** Run statuses whose work isn't over: the run card keeps its thread when a channel is cleared. */
const UNFINISHED_RUNS = ['live', 'paused'] as const;
/** Plan step states that still have work to come (anything but done or cancelled). */
const FINISHED_STEPS: readonly string[] = ['done', 'cancelled'];

/**
 * The messages whose card stands for work that is still going on (essentials-conversations.md EC-04c; channel-clear.md
 * CC-02): a run live or paused, an approval waiting for its decision, a plan with steps to go, a skill proposal
 * waiting, a guide still open, a report being worked on. Finished work's cards can go; the work itself stays in Work,
 * Approvals and Feedback.
 */
async function cardsWithWork(tx: Tx, rows: readonly MessageRow[]): Promise<Set<string>> {
  const keep = new Set<string>();
  const cards = <K extends StoredCard['kind']>(kind: K) =>
    rows.flatMap((r) =>
      r.card?.kind === kind ? [{ messageId: r.id, card: r.card as Extract<StoredCard, { kind: K }> }] : [],
    );

  const runCards = cards('run').map((c) => ({ messageId: c.messageId, id: c.card.runId }));
  if (runCards.length) {
    const live = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(
            runs.id,
            runCards.map((c) => c.id),
          ),
          inArray(runs.status, [...UNFINISHED_RUNS]),
        ),
      );
    const liveIds = new Set(live.map((r) => r.id));
    for (const c of runCards) if (liveIds.has(c.id)) keep.add(c.messageId);
  }

  const approvalCards = cards('approval').map((c) => ({ messageId: c.messageId, id: c.card.approvalId }));
  if (approvalCards.length) {
    const pending = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          inArray(
            approvals.id,
            approvalCards.map((c) => c.id),
          ),
          eq(approvals.state, 'pending'),
        ),
      );
    const pendingIds = new Set(pending.map((a) => a.id));
    for (const c of approvalCards) if (pendingIds.has(c.id)) keep.add(c.messageId);
  }

  const planCards = cards('plan').map((c) => ({ messageId: c.messageId, id: c.card.planId }));
  if (planCards.length) {
    const found = await tx
      .select({ id: plans.id, steps: plans.steps })
      .from(plans)
      .where(
        inArray(
          plans.id,
          planCards.map((c) => c.id),
        ),
      );
    const open = new Set(
      found.filter((p) => p.steps.some((s) => !FINISHED_STEPS.includes(s.state))).map((p) => p.id),
    );
    for (const c of planCards) if (open.has(c.id)) keep.add(c.messageId);
  }

  // A guide answered or expired (AG-11) takes no action any more.
  for (const c of cards('guide')) if (c.card.state === 'open') keep.add(c.messageId);

  for (const c of [...cards('report'), ...cards('assessment')])
    if (await reportHoldsWork(tx, c.card.reportId)) keep.add(c.messageId);
  return keep;
}

/**
 * The threads of a channel that still hold work in progress, by their first message's id (channel-clear.md CC-02): a
 * card for work that isn't over (`cardsWithWork`), or an agent's turn queued or running there.
 */
async function threadsWithWork(
  tx: Tx,
  conversationId: string,
  rows: readonly MessageRow[],
): Promise<Set<string>> {
  const keep = new Set<string>();
  const rootOf = new Map(rows.map((r) => [r.id, r.threadRootId ?? r.id]));
  for (const id of await cardsWithWork(tx, rows)) keep.add(rootOf.get(id) ?? id);

  // An agent's turn waiting or running here answers in its thread (or under the message that woke it).
  const busy = await tx
    .select({ threadRootId: dispatches.threadRootId, messageId: dispatches.messageId })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.conversationId, conversationId),
        inArray(dispatches.state, ['queued', 'claimed', 'running']),
      ),
    );
  for (const d of busy) {
    if (d.threadRootId) keep.add(d.threadRootId);
    const root = d.messageId ? rootOf.get(d.messageId) : undefined;
    if (root) keep.add(root);
  }
  return keep;
}

/** What `removeMessages` removed from a conversation: the ids, how many stayed, whether its Files changed. */
export interface Removal {
  ids: string[];
  kept: number;
  filesChanged: boolean;
}

/**
 * Removes every message of a conversation at once — replies, files, reactions, pins, search documents and inbox rows
 * with them — except the threads that still hold work in progress (`threadsWithWork`) and the threads `keep` names by
 * their first message (channel-clear.md CC-02, CC-03; chat-channel.md CHT-04). The agent's sessions that saw
 * the removed words are forgotten; the conversation's last activity becomes what is left. In the caller's commit; no
 * event and no frames (`announceRemoval`). Nothing to remove answers `ids: []`.
 */
export async function removeMessages(
  ctx: ApplyContext,
  conversation: ConversationRow,
  keep: ReadonlySet<string> = new Set(),
): Promise<Removal> {
  const tx = ctx.tx;
  const rows = await tx
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt, messages.ord)
    .for('update');
  const working = await threadsWithWork(tx, conversation.id, rows);
  const gone = rows.filter((r) => {
    const root = r.threadRootId ?? r.id;
    return !working.has(root) && !keep.has(root);
  });
  const kept = rows.length - gone.length;
  if (gone.length === 0) return { ids: [], kept, filesChanged: false };

  const ids = gone.map((r) => r.id);
  const filesChanged = await dropFiles(ctx, ids);
  await tx.delete(reactions).where(inArray(reactions.messageId, ids));
  await tx.delete(searchDocuments).where(inArray(searchDocuments.id, ids));
  await tx.delete(messages).where(inArray(messages.id, ids));
  await dropMessageNotifications(tx, ids);
  // The conversation's last activity is what is left of it (nothing: as a new one).
  const [last] = await tx
    .select({ at: sql<Date | null>`max(${messages.createdAt})` })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), isNull(messages.threadRootId)));
  await tx
    .update(conversations)
    .set({ lastMessageAt: last?.at ? new Date(last.at) : null })
    .where(eq(conversations.id, conversation.id));
  // The agent's sessions that may hold the removed words are forgotten and deleted (from the first of them on).
  const first = gone[0] as MessageRow;
  await forgetStaleContext(ctx, {
    conversationId: conversation.id,
    createdAt: first.createdAt,
  });
  return { ids, kept, filesChanged };
}

/**
 * What clients hear of a removal (CC-04): a `message.deleted` per removed message on the conversation topic, as for
 * single deletes, its Files when they changed, then the unread counts. After the signed event that records it.
 */
export async function announceRemoval(
  ctx: ApplyContext,
  conversationId: string,
  removal: Removal,
  eventId: string | null,
): Promise<void> {
  if (removal.ids.length === 0) return;
  for (const id of removal.ids)
    ctx.publish(
      topics.conversation(conversationId),
      { type: 'message.deleted', conversationId, messageId: id },
      { eventId },
    );
  // The removed messages' files left Files; files saved straight into Files stay (files-space.md FS-06).
  if (removal.filesChanged) await publishFilesChanged(ctx, conversationId, { eventId });
  const services = ctx.services;
  ctx.background(
    'unread badges',
    () => publishUnread(services, ctx.burrow.id, conversationId, null),
    unreadKey(conversationId),
  );
}

/* Pin ------------------------------------------------------------------------------------------- */

export const pinMessage = defineCommand({
  name: 'pin_message',
  schema: z.object({ messageId: MessageId, pinned: z.boolean() }),
  async apply(tx, ctx, input) {
    const { row, conversation } = await messageInReach(ctx, input.messageId, true);
    if (ctx.actor.kind !== 'person') throw forbidden('Agents don’t pin messages.');
    if (!canPinMessage({ deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null }, viewerOf(ctx)))
      throw conflict('A deleted message can’t be pinned.');
    const pinned = row.pinnedAt !== null;
    if (pinned === input.pinned) {
      const [same] = await loadMessages(tx, [row], ctx.actor.id);
      if (!same) throw notFound('Message');
      return { message: same };
    }
    if (input.pinned) {
      // Under the burrow lock the pipeline holds: two pins can't both be the 51st.
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.conversationId, conversation.id), isNotNull(messages.pinnedAt)));
      if (n >= PINS_MAX)
        throw conflict(`This conversation has ${PINS_MAX} pinned messages. Unpin one first.`);
    }
    const [updated] = await tx
      .update(messages)
      .set(
        input.pinned ? { pinnedAt: ctx.now, pinnedById: ctx.actor.id } : { pinnedAt: null, pinnedById: null },
      )
      .where(eq(messages.id, row.id))
      .returning();
    if (!updated) throw notFound('Message');
    const event = await ctx.emit({
      type: input.pinned ? 'message.pinned' : 'message.unpinned',
      kind: 'Messages',
      text: null,
      where: conversationLabel(conversation),
      ref: await linkOfMessage(tx, conversation, row.id, row.threadRootId),
      aboutId: row.authorId,
      payload: { messageId: row.id, conversationId: conversation.id },
    });
    const message = await publishMessage(ctx, updated, event.id);
    if (!message) throw notFound('Message');
    return { message };
  },
});

/** Pinned messages of a conversation, newest pin first (at most `PINS_MAX`). */
export async function pinnedMessages(db: Db, conversation: Pick<ConversationRow, 'id'>) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), isNotNull(messages.pinnedAt)))
    .orderBy(desc(messages.pinnedAt), desc(messages.ord))
    .limit(PINS_MAX);
}
