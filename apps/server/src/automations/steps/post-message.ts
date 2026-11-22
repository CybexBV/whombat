import { attachmentUrl, type JsonObject, newId, renderTemplate } from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ApplyContext } from '../../commit/types';
import { attachments, automationRuns, messages } from '../../db/schema/index';
import { postMessage } from '../../domain/messages';
import { linkAttachments } from '../../files/commands';
import { type AttachmentRow, lockBlob } from '../../files/service';
import { loadConversationRow } from '../../read/conversations';
import { outsidersRun } from '../runs';
import type { AutomationRunRow } from '../store';
import { outsidersStepFiles } from './scope';
import { block, updateStep } from './state';
import { placeFor } from './thread';
import type { StepExecution } from './types';

/**
 * Copies of the files that started the run — either from the trigger message in another room or handed over from a
 * matched incoming email — onto the post that starts the run's thread in `to`, so the agent's turns read them with
 * `read_attachment` without touching other rooms or the person's mailbox.
 */
export async function triggerFileCopies(
  ctx: ApplyContext,
  run: AutomationRunRow,
  to: string,
): Promise<AttachmentRow[]> {
  const messageId = run.trigger.messageId;
  if (messageId) {
    const [trigger] = await ctx.tx
      .select({ conversationId: messages.conversationId, attachmentIds: messages.attachmentIds })
      .from(messages)
      .where(eq(messages.id, messageId));
    if (!trigger?.attachmentIds?.length || trigger.conversationId === to) return [];
    return copyAttachments(ctx, run, trigger.attachmentIds.slice(0, 10), to);
  }
  const scope = run.scope as { kind?: unknown; attachmentIds?: unknown } | null;
  if (scope?.kind === 'mail' && Array.isArray(scope.attachmentIds)) {
    const ids = scope.attachmentIds.filter((x): x is string => typeof x === 'string').slice(0, 10);
    if (ids.length > 0) return copyDetachedAttachments(ctx, run, ids, to);
  }
  return [];
}

async function copyDetachedAttachments(
  ctx: ApplyContext,
  run: AutomationRunRow,
  ids: readonly string[],
  to: string,
): Promise<AttachmentRow[]> {
  if (!ids.length) return [];
  const tx = ctx.tx;
  const sources = await tx
    .select()
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, [...new Set(ids)]),
        eq(attachments.burrowId, run.burrowId),
        isNull(attachments.messageId),
        isNull(attachments.conversationId),
        eq(attachments.state, 'ready'),
      ),
    );
  sources.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const rows: AttachmentRow[] = [];
  for (const src of sources) {
    if (!src.blobKey) continue;
    await lockBlob(tx, src.blobKey);
    const id = newId('attachment');
    const [copy] = await tx
      .insert(attachments)
      .values({
        id,
        burrowId: run.burrowId,
        conversationId: to,
        name: src.name,
        declaredType: src.declaredType,
        contentType: src.contentType,
        kind: src.kind,
        size: src.size,
        sha256: src.sha256,
        blobKey: src.blobKey,
        width: src.width,
        height: src.height,
        state: 'ready',
        url: attachmentUrl(ctx.burrow.slug, id),
        uploadedById: ctx.actor.id,
        createdAt: ctx.now,
        uploadedAt: ctx.now,
      })
      .returning();
    if (copy) rows.push(copy);
  }
  return rows;
}

export async function executePostMessage({
  ctx,
  run,
  steps,
  idx,
  scope,
  base,
  step,
}: StepExecution<'post_message'>): Promise<void> {
  const tx = ctx.tx;
  const place = await placeFor(ctx, run, step);
  const conversation = await loadConversationRow(tx, place.conversationId);
  if (!conversation) return block(ctx, run, idx, 'That conversation is gone.');
  const sourceIds = steps
    .filter((s) => step.attachFrom.includes(s.stepId) && !outsidersStepFiles(run, s))
    .flatMap((s) => {
      const ids = (s.output as JsonObject).attachmentIds;
      return Array.isArray(ids) ? ids.filter((a): a is string => typeof a === 'string') : [];
    })
    .slice(0, 10);
  // Files are copied onto the new message (the bytes are shared), never re-used by id (BP-C25).
  const copies = await copyAttachments(ctx, run, sourceIds, conversation.id);
  const attachmentIds = copies.map((r) => r.id);
  const text = renderTemplate(step.text, scope, 4000);
  // Automations post what they are told to; a mention in it wakes nobody (only dispatch_agent does).
  const posted = await postMessage(ctx, {
    conversation,
    text,
    threadRootId: place.threadRootId,
    mentions: [],
    dispatch: false,
    outsidersRun: outsidersRun(run.trigger),
    ...(attachmentIds.length ? { attachmentIds } : {}),
  });
  await linkAttachments(tx, ctx, posted.id, copies);
  if (place.startsThread)
    await tx.update(automationRuns).set({ threadRootId: posted.id }).where(eq(automationRuns.id, run.id));
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'succeeded',
      finishedAt: ctx.now,
      messageIds: [posted.id],
      inputSummary: 'Posted a message',
      output: { messageId: posted.id, text },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  return;
}

/**
 * `attachFrom` (BP-C25): each source file becomes a new attachment of the message about to be posted in `to` — the
 * same bytes, a new row — so a message only ever shows files that are its own. Every room has the same reader (the
 * person), so a file of the burrow may go into any of its rooms.
 */
export async function copyAttachments(
  ctx: ApplyContext,
  run: AutomationRunRow,
  ids: readonly string[],
  to: string,
): Promise<AttachmentRow[]> {
  if (!ids.length) return [];
  const tx = ctx.tx;
  const sources = await tx
    .select({ attachment: attachments })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        inArray(attachments.id, [...new Set(ids)]),
        eq(attachments.burrowId, run.burrowId),
        eq(attachments.state, 'ready'),
      ),
    );
  sources.sort((a, b) => ids.indexOf(a.attachment.id) - ids.indexOf(b.attachment.id));
  const rows: AttachmentRow[] = [];
  for (const { attachment: src } of sources) {
    if (!src.blobKey) continue;
    await lockBlob(tx, src.blobKey);
    const id = newId('attachment');
    const [copy] = await tx
      .insert(attachments)
      .values({
        id,
        burrowId: run.burrowId,
        conversationId: to,
        name: src.name,
        declaredType: src.declaredType,
        contentType: src.contentType,
        kind: src.kind,
        size: src.size,
        sha256: src.sha256,
        blobKey: src.blobKey,
        width: src.width,
        height: src.height,
        state: 'ready',
        url: attachmentUrl(ctx.burrow.slug, id),
        uploadedById: ctx.actor.id,
        createdAt: ctx.now,
        uploadedAt: ctx.now,
      })
      .returning();
    if (copy) rows.push(copy);
  }
  return rows;
}
