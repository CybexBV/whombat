/**
 * Who may read an attachment's bytes, decided on every request (docs/decisions/bp-attachments.md BP-A05,
 * BP-A08):
 * - the person or the agent: any file on a message of the burrow, or saved straight into one of its conversations' Files
 *   (no message, files-space.md FS-01) — every conversation is the person's — or its uploader while it is not sent yet;
 * - a person's photo (no conversation, no message; docs/decisions/person-avatars.md PVA-06): anyone in its burrow while it
 *   is the photo of someone there (a replaced or removed photo's row is deleted at once);
 * - a repository's icon (no conversation, no message; docs/decisions/chat-inbox.md): anyone in its burrow while it is
 *   the icon kept for one of the burrow's repositories, a private repository's too, as nobody outside the burrow reads it;
 * - an agent in a dispatch: attachments on the messages the dispatch shows it — the trigger, the window of
 *   recent top-level messages and the thread — of its own conversation. Answer-mode
 *   (search) dispatches get none: their answer goes to someone else. A website visitor's screenshots (a Whombat
 *   Feedback report's root message) only reach the report's assessment and an approved handoff (FB-F3-12). An
 *   outsiders' turn is shown only its request and its thread, never the room's window (its room is usually the
 *   person's Chat or Feedback room); one of an automation run (incoming mail, a tracker report) only the files the
 *   server handed over from what started its run (`outsidersFileIds`), never one the person or anyone else added to
 *   its thread. Besides those, the files in its conversation's Files (FS-08; `dispatchFileRows`), not in an
 *   assessment, a search answer or an outsiders' turn: they are the person's files.
 * Everything else is “not found”, so nobody can probe for ids.
 */
import type { AttachmentRef } from '@whombat/core';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { stepTurnFileIds } from '../automations/handed-files';
import type { Db } from '../db/client';
import { attachments, events, feedbackReports, messages, principals, repoIcons } from '../db/schema/index';
import { outsidersTurn } from '../runtime/person';
import { isBurrowAvatar } from './avatars';
import type { AttachmentRow } from './service';
import { type FileRow, fileRow, listFileRows } from './space';

type DispatchLike = {
  id: string;
  agentId: string;
  burrowId: string;
  conversationId: string;
  messageId: string | null;
  threadRootId: string | null;
  search: unknown;
  trigger?: string;
  /** The person the turn is for; null: an outsiders' turn (`runtime/person.ts`). */
  onBehalfOfAccountId: string | null;
};

/** The attachment if `viewerId` may read it now, else null (answer 404). */
export async function readableAttachment(
  db: Db,
  burrowId: string,
  viewerId: string,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!row || row.burrowId !== burrowId || row.state !== 'ready') return null;
  if (row.conversationId === null && !row.messageId)
    return (await viewerInBurrow(db, burrowId, viewerId)) &&
      ((await isBurrowAvatar(db, burrowId, row.id)) || (await isRepoIcon(db, burrowId, row.id)))
      ? row
      : null;
  // Saved straight into Files (files-space.md FS-01): the burrow's, as its conversation is.
  if (!row.messageId && row.filedAt && row.conversationId)
    return (await viewerInBurrow(db, burrowId, viewerId)) ? row : null;
  if (!row.messageId) return row.uploadedById === viewerId ? row : null;
  const [message] = await db
    .select({ conversationId: messages.conversationId, burrowId: messages.burrowId })
    .from(messages)
    .where(eq(messages.id, row.messageId));
  if (!message || message.burrowId !== burrowId) return null;
  return (await viewerInBurrow(db, burrowId, viewerId)) ? row : null;
}

/** Whether the attachment is the icon kept for one of the burrow's repositories. */
async function isRepoIcon(db: Db, burrowId: string, attachmentId: string): Promise<boolean> {
  const [hit] = await db
    .select({ one: sql<number>`1` })
    .from(repoIcons)
    .where(and(eq(repoIcons.burrowId, burrowId), eq(repoIcons.attachmentId, attachmentId)))
    .limit(1);
  return Boolean(hit);
}

/** The viewer is the person or the agent of the burrow. */
async function viewerInBurrow(db: Db, burrowId: string, viewerId: string): Promise<boolean> {
  const [viewer] = await db
    .select({ burrowId: principals.burrowId })
    .from(principals)
    .where(eq(principals.id, viewerId));
  return !!viewer && viewer.burrowId === burrowId;
}

/** Ids of the messages a dispatch shows its agent (see `buildDispatchContext`). */
async function dispatchMessageIds(db: Db, row: DispatchLike, windowSize: number): Promise<string[]> {
  // A feedback assessment (docs/decisions/feedback.md FB-21) uses only the report's own screenshots: the files on
  // its root message, never files posted in its thread or elsewhere in the channel.
  if (row.trigger === 'feedback') return row.threadRootId ? [row.threadRootId] : [];
  const ids = new Set<string>();
  if (row.messageId) ids.add(row.messageId);
  // An outsiders' turn gets no window of the room (`runtime/context.ts`), so none of its files either.
  const window = outsidersTurn(row)
    ? []
    : await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, row.conversationId), isNull(messages.threadRootId)))
        .orderBy(desc(messages.createdAt), desc(messages.ord))
        .limit(windowSize);
  for (const m of window) ids.add(m.id);
  if (row.threadRootId) {
    const [root] = await db
      .select({ id: messages.id, threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, row.threadRootId));
    const rootId = root?.threadRootId ?? root?.id;
    if (rootId) {
      const thread = await db
        .select({ id: messages.id })
        .from(messages)
        .where(or(eq(messages.id, rootId), eq(messages.threadRootId, rootId)));
      for (const m of thread) ids.add(m.id);
    }
  }
  return [...ids];
}

/**
 * The report whose screenshots this dispatch may use besides its assessment: the root message of the report an
 * approved development handoff gave this agent (its trigger is the handoff message the signed
 * `feedback.handoff_started` names, for this agent, in that report's thread). Null for every other dispatch.
 */
async function handoffRootId(db: Db, row: DispatchLike): Promise<string | null> {
  if (!row.messageId || !row.threadRootId) return null;
  const [started] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.burrowId, row.burrowId),
        eq(events.type, 'feedback.handoff_started'),
        sql`${events.payload}->>'messageId' = ${row.messageId}`,
      ),
    )
    .limit(1);
  const payload = started?.payload as { reportId?: string; handoffAgentId?: string } | undefined;
  if (!payload?.reportId || payload.handoffAgentId !== row.agentId) return null;
  const [report] = await db
    .select({ rootMessageId: feedbackReports.rootMessageId })
    .from(feedbackReports)
    .where(and(eq(feedbackReports.id, payload.reportId), eq(feedbackReports.burrowId, row.burrowId)));
  return report?.rootMessageId === row.threadRootId ? report.rootMessageId : null;
}

/**
 * Leaves out a website visitor's screenshots (the files on a Whombat Feedback report's root message, FB-F3-12): only
 * the report's assessment (above) and the approved handoff's developer get them, where the prompt marks the report
 * as untrusted data. Any other agent in the channel or thread — a person's “@Dusty thoughts?” — doesn't.
 */
async function withoutVisitorFiles(db: Db, row: DispatchLike, ids: string[]): Promise<string[]> {
  if (row.trigger === 'feedback' || !ids.length) return ids;
  const roots = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(inArray(messages.id, ids), sql`${messages.card}->>'kind' = 'report'`));
  if (!roots.length) return ids;
  const allowed = await handoffRootId(db, row);
  const drop = new Set(roots.map((r) => r.id).filter((id) => id !== allowed));
  return ids.filter((id) => !drop.has(id));
}

/**
 * The only files an outsiders' turn other than a feedback assessment may be shown and use: those the server
 * handed over from what started the automation run whose step queued it (the email's; none for a tracker report).
 * Any other such turn has none. Null for every other dispatch, which the rules above decide alone.
 */
export async function outsidersFileIds(
  db: Db,
  row: Pick<DispatchLike, 'id' | 'trigger' | 'onBehalfOfAccountId'>,
): Promise<ReadonlySet<string> | null> {
  if (!outsidersTurn(row) || row.trigger === 'feedback') return null;
  return new Set(row.trigger === 'automation' ? await stepTurnFileIds(db, row.id) : []);
}

/** The ready attachments a dispatch's agent may use now, oldest message first. */
export async function dispatchAttachmentRows(
  db: Db,
  row: DispatchLike,
  windowSize: number,
): Promise<AttachmentRow[]> {
  if (row.search) return [];
  const only = await outsidersFileIds(db, row);
  if (only?.size === 0) return [];
  const ids = await withoutVisitorFiles(db, row, await dispatchMessageIds(db, row, windowSize));
  if (!ids.length) return [];
  const rows = await db
    .select({ attachment: attachments, createdAt: messages.createdAt, ord: messages.ord })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        inArray(attachments.messageId, ids),
        eq(attachments.state, 'ready'),
        eq(attachments.burrowId, row.burrowId),
        eq(messages.conversationId, row.conversationId),
        ...(only ? [inArray(attachments.id, [...only])] : []),
      ),
    );
  rows.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      Number(a.ord) - Number(b.ord) ||
      a.attachment.id.localeCompare(b.attachment.id),
  );
  return rows.map((r) => r.attachment);
}

/**
 * Whether a dispatch's agent may use its conversation's Files (files-space.md FS-08): not in a search answer (its answer
 * goes to someone else), a feedback assessment (only the report's own screenshots) or any other outsiders' turn (the
 * Files of the person's Chat or Feedback room are the person's files).
 */
export function dispatchSeesFiles(row: DispatchLike): boolean {
  return !row.search && row.trigger !== 'feedback' && !outsidersTurn(row);
}

/** The newest files of the dispatch's conversation's Files the agent may use (FS-08), at most `limit`. */
export async function dispatchFileRows(
  db: Db,
  row: DispatchLike,
  limit: number,
): Promise<{ rows: FileRow[]; more: boolean }> {
  if (!dispatchSeesFiles(row)) return { rows: [], more: false };
  return listFileRows(db, row.conversationId, { limit, forAgents: true });
}

/**
 * One attachment a dispatch's agent may read now (the runner fetch, `read_attachment`): a file on the messages it is
 * shown (BP-A09), else a file of its conversation's Files (FS-08). Re-checked on every call.
 */
export async function dispatchReadableAttachment(
  db: Db,
  row: DispatchLike,
  windowSize: number,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const shown = (await dispatchAttachmentRows(db, row, windowSize)).find((r) => r.id === attachmentId);
  if (shown) return shown;
  if (!dispatchSeesFiles(row)) return null;
  const file = await fileRow(db, attachmentId, true);
  if (
    !file ||
    file.attachment.conversationId !== row.conversationId ||
    file.attachment.burrowId !== row.burrowId
  )
    return null;
  return file.attachment;
}

export function toAttachmentRef(row: AttachmentRow, conversationId: string): AttachmentRef {
  return {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    kind: row.kind,
    sha256: row.sha256 ?? '',
    messageId: row.messageId ?? '',
    conversationId,
    width: row.width ?? null,
    height: row.height ?? null,
  };
}
