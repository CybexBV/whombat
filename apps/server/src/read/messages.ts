/** Messages as clients see them: stored card references resolved to live objects, reactions aggregated. */

import {
  type AgentScheduleView,
  type Attachment,
  CARD_KINDS,
  type ChatSubject,
  type Message,
  type MessageCard,
  type Reaction,
  type StoredCard,
  type ThreadSettle,
} from '@whombat/core';
import { asc, eq, gt, inArray, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { automationPlanCards } from '../automations/plan-store';
import { threadSettleOf } from '../chats/settle-rules';
import { messageSubjectOf } from '../chats/view';
import { withMessageConnectionDetail } from '../connections/approvals';
import type { Db } from '../db/client';
import {
  approvals as approvalsTable,
  attachments,
  feedbackIntegrations,
  feedbackReports,
  messages,
  plans as plansTable,
  principals,
  reactions,
  runs as runsTable,
} from '../db/schema/index';
import { loadAssessmentCards, loadReportCards } from '../feedback/cards';
import { toAttachment } from '../files/service';
import { messageFileInFiles } from '../files/space';
import { iso, isoOrNull } from '../lib/time';
import { lookPlanCards } from '../looks/research';
import { scheduleCardsFor } from '../schedules/store';
import { featureRequestCards } from '../trackers/feature-views';
import { groupRows } from './group';
import { loadApprovals, loadPlans, loadRunsByIds } from './work';

export type MessageRow = typeof messages.$inferSelect;

/**
 * A cleared Chat or Feedback room's top level (chat-clear.md CHC-03, `conversations.room_cleared_at`): only messages
 * after the clear, every one when it never was. `messagePage` and the turn's window read it; threads never do.
 */
export function afterClear(clearedAt: Date | null | undefined): SQL | undefined {
  return clearedAt ? gt(messages.createdAt, clearedAt) : undefined;
}

/**
 * Dispatch selection needs text, time and whether a card resolves, not its live object graph. Keep the stored row
 * for the eventual read: re-reading selected rows after assembly could change their text (and budget) or lose a
 * deleted message. These candidates are server-only; only `hydrateMessageCandidates` returns client messages.
 */
export interface MessageCandidate extends Pick<Message, 'id' | 'text' | 'createdAt' | 'threadRootId'> {
  hasCard: boolean;
  source: MessageRow;
}

export type ContextMessage = Message | MessageCandidate;

/**
 * Card presence must match `loadMessages`: a dangling live reference costs nothing, an unfinished assessment has
 * no card, and skill/schedule cards keep their wrapper even when the viewer cannot read their detail. Read only
 * ids/booleans here, never plans' steps, runs' files, approvals' detail or reports' visitor/assessment content.
 */
export async function messageCandidates(db: Db, rows: readonly MessageRow[]): Promise<MessageCandidate[]> {
  const cards = rows.flatMap((r) => (r.card ? [r.card] : []));
  const planIds = [...new Set(cards.flatMap((c) => (c.kind === 'plan' ? [c.planId] : [])))];
  const runIds = [...new Set(cards.flatMap((c) => (c.kind === 'run' ? [c.runId] : [])))];
  const approvalIds = [...new Set(cards.flatMap((c) => (c.kind === 'approval' ? [c.approvalId] : [])))];
  const reportIds = [
    ...new Set(cards.flatMap((c) => (c.kind === 'report' || c.kind === 'assessment' ? [c.reportId] : []))),
  ];
  const [plans, runs, approvals, reports] = await Promise.all([
    planIds.length
      ? db.select({ id: plansTable.id }).from(plansTable).where(inArray(plansTable.id, planIds))
      : [],
    runIds.length ? db.select({ id: runsTable.id }).from(runsTable).where(inArray(runsTable.id, runIds)) : [],
    approvalIds.length
      ? db
          .select({ id: approvalsTable.id })
          .from(approvalsTable)
          .where(inArray(approvalsTable.id, approvalIds))
      : [],
    reportIds.length
      ? db
          .select({
            id: feedbackReports.id,
            report: sql<boolean>`${feedbackIntegrations.id} is not null`,
            assessment: sql<boolean>`${feedbackReports.assessmentState} = 'done'
              and ${feedbackReports.assessment} is not null and ${feedbackReports.assessment} <> 'null'::jsonb
              and ${feedbackReports.conclusion} is not null and ${feedbackReports.conclusion} <> 'null'::jsonb`,
          })
          .from(feedbackReports)
          .leftJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
          .where(inArray(feedbackReports.id, reportIds))
      : [],
  ]);
  const present = new Set([
    ...plans.map((r) => `plan:${r.id}`),
    ...runs.map((r) => `run:${r.id}`),
    ...approvals.map((r) => `approval:${r.id}`),
    ...reports.flatMap((r) => [
      ...(r.report ? [`report:${r.id}`] : []),
      ...(r.assessment ? [`assessment:${r.id}`] : []),
    ]),
  ]);
  const hasCard = (card: StoredCard | null): boolean => {
    if (!card) return false;
    switch (card.kind) {
      case 'plan':
        return present.has(`plan:${card.planId}`);
      case 'run':
        return present.has(`run:${card.runId}`);
      case 'approval':
        return present.has(`approval:${card.approvalId}`);
      case 'report':
      case 'assessment':
        return present.has(`${card.kind}:${card.reportId}`);
      default:
        return true;
    }
  };
  return rows.map((source) => ({
    id: source.id,
    text: source.text,
    createdAt: iso(source.createdAt),
    threadRootId: source.threadRootId,
    hasCard: hasCard(source.card),
    source,
  }));
}

/**
 * Resolve only the selected candidates, in their original order, using all the usual viewer-specific rules.
 * Keep an absent card absent: an incomplete/dangling reference resolving after selection must not add unbudgeted
 * content. Present references still resolve live (and may disappear); never snapshot viewer-sensitive detail.
 */
export async function hydrateMessageCandidates(
  db: Db,
  selected: readonly ContextMessage[],
  viewerId: string | null,
): Promise<Message[]> {
  const rows = selected.flatMap((m) =>
    'source' in m ? [m.hasCard ? m.source : { ...m.source, card: null }] : [],
  );
  const loaded = await loadMessages(db, rows, viewerId);
  let next = 0;
  return selected.map((m) => ('source' in m ? (loaded[next++] as Message) : m));
}

/** Aggregates reaction rows into pills in first-reacted order; `mine` relative to the viewer. */
export function aggregateReactions(
  rows: readonly { value: string; principalId: string }[],
  viewerId: string | null,
): Reaction[] {
  const byValue = new Map<string, string[]>();
  for (const r of rows) {
    const list = byValue.get(r.value) ?? [];
    list.push(r.principalId);
    byValue.set(r.value, list);
  }
  return [...byValue].map(([value, principalIds]) => ({
    value,
    count: principalIds.length,
    mine: viewerId !== null && principalIds.includes(viewerId),
    principalIds,
  }));
}

/** Re-renders viewer-relative fields of a message for another viewer. */
export function personalizeMessage(message: Message, viewerId: string | null): Message {
  return {
    ...message,
    reactions: message.reactions.map((r) => ({
      ...r,
      mine: viewerId !== null && r.principalIds.includes(viewerId),
    })),
  };
}

export async function loadMessages(
  db: Db,
  rows: readonly MessageRow[],
  viewerId: string | null,
): Promise<Message[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const cards = rows.map((r) => r.card).filter((c): c is StoredCard => !!c);
  const planIds = cards.flatMap((c) => (c.kind === 'plan' ? [c.planId] : []));
  const runIds = cards.flatMap((c) => (c.kind === 'run' ? [c.runId] : []));
  const approvalIds = cards.flatMap((c) => (c.kind === 'approval' ? [c.approvalId] : []));
  const reportIds = cards.flatMap((c) => (c.kind === 'report' ? [c.reportId] : []));
  const assessedIds = cards.flatMap((c) => (c.kind === 'assessment' ? [c.reportId] : []));
  const scheduleIds = cards.flatMap((c) => (c.kind === 'schedule' ? [c.scheduleId] : []));
  const automationPlanIds = cards.flatMap((c) => (c.kind === 'automation_plan' ? [c.planId] : []));
  const lookPlanIds = cards.flatMap((c) => (c.kind === 'look_plan' ? [c.researchId] : []));
  const featureRequestIds = cards.flatMap((c) => (c.kind === 'feature_request' ? [c.requestId] : []));
  const attachmentIds = rows.flatMap((r) => r.attachmentIds);
  const [
    plans,
    runs,
    approvals,
    reports,
    assessments,
    schedules,
    automationPlanViews,
    lookPlanViews,
    featureRequestViews,
    reactionRows,
    attachmentRows,
  ] = await Promise.all([
    loadPlans(db, planIds),
    loadRunsByIds(db, runIds),
    loadApprovals(db, approvalIds),
    loadReportCards(db, reportIds),
    loadAssessmentCards(db, assessedIds),
    // A frame built for nobody leaves the schedule out: it is filled in at delivery (`realtime/fill.ts`).
    viewerId ? scheduleCardsFor(db, scheduleIds) : new Map<string, AgentScheduleView>(),
    // A plan's card is the same for everyone (one person), so it resolves in frames too (automation-chat.md).
    automationPlanCards(db, automationPlanIds),
    // A thing's plan reads the same for everyone too (handle-it.md).
    lookPlanCards(db, lookPlanIds),
    // So does a feature request (report-trackers.md TA-44).
    featureRequestCards(db, featureRequestIds),
    db
      .select({
        messageId: reactions.messageId,
        value: reactions.value,
        principalId: reactions.principalId,
      })
      .from(reactions)
      .where(inArray(reactions.messageId, ids))
      .orderBy(asc(reactions.createdAt)),
    // With the uploader's kind: a person's file is in Files by itself, an agent's once saved (files-space.md FS-14).
    attachmentIds.length
      ? db
          .select({ attachment: attachments, uploaderKind: principals.kind })
          .from(attachments)
          .leftJoin(principals, eq(principals.id, attachments.uploadedById))
          .where(inArray(attachments.id, attachmentIds))
      : Promise.resolve([] as { attachment: typeof attachments.$inferSelect; uploaderKind: string | null }[]),
  ]);

  const resolveCard = (card: StoredCard | null): MessageCard | null => {
    // A kind this release doesn't make any more (the morning and evening brief's) leaves the message's own text.
    if (!card || !(CARD_KINDS as readonly string[]).includes(card.kind)) return null;
    switch (card.kind) {
      case 'plan': {
        const plan = plans.get(card.planId);
        return plan ? { kind: 'plan', plan } : null;
      }
      case 'run': {
        const run = runs.get(card.runId);
        return run ? { kind: 'run', run } : null;
      }
      case 'approval': {
        const approval = approvals.get(card.approvalId);
        return approval ? { kind: 'approval', approval } : null;
      }
      case 'report':
        return reports.get(card.reportId) ?? null;
      case 'assessment':
        return assessments.get(card.reportId) ?? null;
      // A schedule card (resourceful-agents.md RA-30, RA-DC15) resolves per viewer too: the prompt only for people in
      // the room, `canChange` theirs; in frames built for nobody in particular the hub resolves it per recipient.
      case 'schedule':
        return {
          kind: 'schedule',
          scheduleId: card.scheduleId,
          ...(card.runId ? { runId: card.runId } : {}),
          schedule: schedules.get(card.scheduleId) ?? null,
        };
      case 'automation_plan':
        return {
          kind: 'automation_plan',
          planId: card.planId,
          plan: automationPlanViews.get(card.planId) ?? null,
        };
      case 'look_plan':
        return {
          kind: 'look_plan',
          researchId: card.researchId,
          plan: lookPlanViews.get(card.researchId) ?? null,
        };
      case 'feature_request':
        return {
          kind: 'feature_request',
          requestId: card.requestId,
          request: featureRequestViews.get(card.requestId) ?? null,
        };
      default:
        return card;
    }
  };

  // Only uploads whose bytes are stored (docs/decisions/bp-attachments.md), and only on the message they belong to:
  // an id copied into another message's list never shows there (docs/decisions/bp-automations.md BP-C25). Inside
  // the send that claims it, an upload is still the author's own, unsent one for this room (linked in the same
  // transaction, after the message row exists).
  const attachmentById = new Map(
    attachmentRows.filter((r) => r.attachment.state === 'ready').map((r) => [r.attachment.id, r]),
  );
  const reactionsByMessage = groupRows(reactionRows, (r) => r.messageId);
  const ownedBy = (a: (typeof attachmentRows)[number]['attachment'], row: MessageRow) =>
    a.messageId === row.id ||
    (a.messageId === null && a.uploadedById === row.authorId && a.conversationId === row.conversationId);
  const attachmentsOf = (row: MessageRow): Attachment[] =>
    row.attachmentIds.flatMap((id) => {
      const found = attachmentById.get(id);
      if (!found || !ownedBy(found.attachment, row)) return [];
      return [toAttachment(found.attachment, messageFileInFiles(found.attachment, found.uploaderKind))];
    });

  const loaded: Message[] = rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    authorId: row.authorId,
    createdAt: iso(row.createdAt),
    editedAt: isoOrNull(row.editedAt),
    text: row.text,
    mentions: row.mentions,
    card: resolveCard(row.card),
    suggestions: row.suggestions,
    more: row.more ?? null,
    attachments: attachmentsOf(row),
    reactions: aggregateReactions(reactionsByMessage.get(row.id) ?? [], viewerId),
    threadRootId: row.threadRootId,
    replyCount: row.replyCount,
    lastReplyAt: isoOrNull(row.lastReplyAt),
    threadParticipantIds: row.threadParticipantIds,
    clientId: row.clientId,
    ...(row.provenance ? { provenance: row.provenance } : {}),
    // 0.26 (docs/decisions/essentials-conversations.md): only when set, so older answers read as before.
    ...(row.deletedAt ? { deletedAt: iso(row.deletedAt) } : {}),
    ...(row.pinnedAt ? { pinnedAt: iso(row.pinnedAt), pinnedById: row.pinnedById ?? null } : {}),
    ...(row.previews?.length && !row.deletedAt ? { previews: row.previews } : {}),
    // What a thread in Chat is about, on its first message (chat-channel.md CHT-05, CT-440); absent otherwise.
    ...subjectField(row),
    // What answered an assistant's reply in Chat (chat-runtime.md CR-07, CT-460); absent otherwise.
    ...(row.ranOn && !row.deletedAt ? { ranOn: row.ranOn } : {}),
    // What the Vault took from it (vault-self-serve.md VS-07, VS-11; CT-783); absent when nothing, as before.
    ...(row.vaultSaved?.length && !row.deletedAt ? { vaultSaved: row.vaultSaved } : {}),
    // A settled thread's first message in Chat or Feedback, which the room folds; absent while it is open.
    ...settledField(row),
    // Its card moved to the thread's end (card-moves.md CM-07): a link to it under the words left here.
    ...(row.movedCard && !row.deletedAt ? { movedCard: row.movedCard } : {}),
    // The card as it was here when the person talked under it (card-moves.md): folded, read-only.
    ...(row.earlierCard && !row.deletedAt ? { earlierCard: resolveCard(row.earlierCard) } : {}),
    // The result of a job handed to T3 Code: the apps lay its text out as T3 Code's report; absent otherwise.
    ...(row.jobResult && !row.deletedAt ? { jobResult: row.jobResult } : {}),
  }));
  // A `connection_call` approval card carries its arguments for its deciders only (connections-catalog.md CX-21).
  return withMessageConnectionDetail(db, loaded, viewerId);
}

/** `Message.subject` of a thread's first message (CT-440), when it has one. */
function subjectField(row: MessageRow): { subject?: ChatSubject } {
  const subject = !row.threadRootId && !row.deletedAt ? messageSubjectOf(row) : undefined;
  return subject ? { subject } : {};
}

/** `Message.settled` of a settled thread's first message (docs/decisions/chat-settle.md). */
function settledField(row: MessageRow): { settled?: ThreadSettle } {
  const settled = row.threadRootId ? null : threadSettleOf(row);
  return settled ? { settled } : {};
}

export async function loadMessageRow(db: Db, id: string): Promise<MessageRow | undefined> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row;
}

export async function loadMessage(db: Db, id: string, viewerId: string | null): Promise<Message | undefined> {
  const row = await loadMessageRow(db, id);
  if (!row) return undefined;
  const [message] = await loadMessages(db, [row], viewerId);
  return message;
}

/**
 * SQL: nobody of kind person posted after the question `q` in its place — the same thread (or the top level) after it,
 * or in the question's own thread (agent-status.md AS-03). Three anti-joins, each a range on an index
 * (`messages_top_level_idx` at the top, `messages_thread_idx` in a thread), instead of one scan of the whole
 * conversation per question (server-efficiency.md SV-12). The same rows as
 * `r.conversation_id = q.conversation_id and r.ord > q.ord and (r.thread_root_id is not distinct from q.thread_root_id
 * or r.thread_root_id = q.id)`; a deleted reply still answers.
 */
export function unansweredByPeople(q: {
  id: SQLWrapper;
  conversationId: SQLWrapper;
  threadRootId: SQLWrapper;
  ord: SQLWrapper;
}): SQL {
  const spoke = (place: SQL) =>
    sql`not exists (select 1 from messages r join principals p on p.id = r.author_id
      where ${place} and r.conversation_id = ${q.conversationId} and r.ord > ${q.ord} and p.kind = 'person')`;
  return sql`(${spoke(sql`${q.threadRootId} is null and r.thread_root_id is null`)}
    and ${spoke(sql`r.thread_root_id = ${q.threadRootId}`)}
    and ${spoke(sql`r.thread_root_id = ${q.id}`)})`;
}
