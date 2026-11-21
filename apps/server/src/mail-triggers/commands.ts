/**
 * Commit-pipeline commands for mail-triggered automations: every write to `mail_cursors` (the high-water mark) and
 * `mail_trigger_items` goes through the commit pipeline, signed by the burrow's mail system principal. Signed events
 * carry no email text (`text: null`, content-free payloads).
 */
import {
  AttachmentKind,
  attachmentUrl,
  ConnectionId,
  ConnectorProvider,
  MAIL_BODY_CAP,
  MailAttachment,
  newId,
  safeDisplayName,
} from '@whombat/core';
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { type MailProviderCursor, normalizeRfcMessageId } from '../connectors/types';
import { attachments, mailCursors, mailTriggerItems } from '../db/schema/index';
import { lockBlob } from '../files/service';
import { blobKey } from '../files/store';
import { forbidden } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import { mailPrincipal } from './principal';

const StagedMailAttachment = z.object({
  name: z.string().min(1).max(1000),
  declaredType: z.string().max(255).default(''),
  staged: z.object({
    token: z.string().regex(/^[0-9a-f-]{36}$/),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  sniffed: z.object({
    contentType: z.string().min(1).max(120),
    kind: AttachmentKind,
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
});

const MailProviderCursorSchema: z.ZodType<MailProviderCursor> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gmail'),
    historyId: z.string().min(1).max(128),
    backfill: z
      .object({
        pageToken: z.string().min(1).max(2048),
        afterSeconds: z.number().int().nonnegative(),
        sinceMs: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('microsoft'),
    deltaLink: z.string().min(1).max(8192),
    paging: z
      .object({
        sinceMs: z.number().int().nonnegative().optional(),
        dropHeaders: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('imap'),
    mailbox: z.string().min(1).max(255),
    uidValidity: z.string().min(1).max(64),
    lastUid: z.number().int().nonnegative(),
    backfill: z
      .object({
        sinceMs: z.number().int().nonnegative(),
        untilUid: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('fake'), seq: z.number().int().nonnegative() }),
]);

async function requireMailSigner(tx: Parameters<typeof loadPrincipalRow>[0], actorId: string): Promise<void> {
  const row = await loadPrincipalRow(tx, actorId);
  if (!mailPrincipal.is(row)) throw forbidden('Only the mail watcher writes mailbox trigger state.');
}

/** Updates, baselines, records a problem on, or clears a mailbox's high-water mark inside the commit pipeline. */
export const setMailCursor = defineCommand({
  name: 'mail.cursor_set',
  schema: z.object({
    connectionId: ConnectionId,
    cursor: MailProviderCursorSchema.nullable().optional(),
    since: z.string().datetime().nullable().optional(),
    clear: z.boolean().optional(),
    succeeded: z.boolean().optional(),
    problemCode: z.string().max(64).nullable().optional(),
    problem: z.string().max(500).nullable().optional(),
    readFailures: z.record(z.string().max(200), z.number().int().positive()).nullable().optional(),
  }),
  async apply(tx, ctx, input) {
    await requireMailSigner(tx, ctx.actor.id);
    if (input.clear) {
      await tx
        .update(mailCursors)
        .set({
          cursor: null,
          since: null,
          problemCode: null,
          problem: null,
          readFailures: null,
          updatedAt: ctx.now,
        })
        .where(eq(mailCursors.connectionId, input.connectionId));
      await ctx.emit({
        type: 'mail.cursor_updated',
        kind: 'System',
        text: null,
        where: null,
        payload: { connectionId: input.connectionId, cleared: true },
      });
      return { connectionId: input.connectionId, cleared: true };
    }

    const [existing] = await tx
      .select()
      .from(mailCursors)
      .where(eq(mailCursors.connectionId, input.connectionId));
    const nextCursor = input.cursor !== undefined ? input.cursor : (existing?.cursor ?? null);
    const nextSince =
      input.since !== undefined ? (input.since ? new Date(input.since) : null) : (existing?.since ?? null);
    const nextSucceededAt = input.succeeded ? ctx.now : (existing?.succeededAt ?? null);
    const nextProblemCode =
      input.problemCode !== undefined
        ? input.problemCode
        : input.succeeded
          ? null
          : (existing?.problemCode ?? null);
    const nextProblem =
      input.problem !== undefined ? input.problem : input.succeeded ? null : (existing?.problem ?? null);
    const nextReadFailures =
      input.readFailures !== undefined ? input.readFailures : (existing?.readFailures ?? null);

    await tx
      .insert(mailCursors)
      .values({
        connectionId: input.connectionId,
        burrowId: ctx.burrow.id,
        cursor: nextCursor,
        since: nextSince,
        checkedAt: ctx.now,
        succeededAt: nextSucceededAt,
        problemCode: nextProblemCode,
        problem: nextProblem,
        readFailures: nextReadFailures,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: mailCursors.connectionId,
        set: {
          burrowId: ctx.burrow.id,
          cursor: nextCursor,
          since: nextSince,
          checkedAt: ctx.now,
          succeededAt: nextSucceededAt,
          problemCode: nextProblemCode,
          problem: nextProblem,
          readFailures: nextReadFailures,
          updatedAt: ctx.now,
        },
      });

    await ctx.emit({
      type: 'mail.cursor_updated',
      kind: 'System',
      // Only plain-English skipped-mail problems (naming the automation, never email content) carry event text.
      text: nextProblemCode === 'read_failed' && nextProblem ? nextProblem : null,
      where: null,
      payload: {
        connectionId: input.connectionId,
        cursorKind: nextCursor?.kind ?? null,
        ...(nextProblemCode ? { problemCode: nextProblemCode } : {}),
      },
    });
    return { connectionId: input.connectionId, cleared: false };
  },
});

/**
 * Mirrors one matched incoming email into `mail_trigger_items` (deduplicated by `(connection_id, external_id)`),
 * optionally advances `mail_cursors` in the same transaction, and emits a content-free signed `mail.received` event
 * only when the message has not been recorded before.
 */
export const recordMailReceived = defineCommand({
  name: 'mail.received',
  schema: z.object({
    connectionId: ConnectionId,
    provider: ConnectorProvider,
    mailbox: z.string().min(1).max(320),
    externalId: z.string().min(1).max(200),
    messageId: z.string().max(500).nullable().optional(),
    threadId: z.string().min(1).max(200),
    fromHeader: z.string().max(500),
    fromAddress: z.string().max(320),
    subject: z.string().max(1000),
    snippet: z.string().max(500),
    body: z.string().max(MAIL_BODY_CAP),
    bodyTruncated: z.boolean().default(false),
    attachments: z.array(MailAttachment).max(100).default([]),
    stagedAttachments: z.array(StagedMailAttachment).max(10).default([]),
    receivedAt: z.string().datetime(),
    cursor: MailProviderCursorSchema.optional(),
  }),
  async apply(tx, ctx, input) {
    await requireMailSigner(tx, ctx.actor.id);
    const id = newId('mailTriggerItem');
    const messageId = normalizeRfcMessageId(input.messageId);
    const inserted = await tx
      .insert(mailTriggerItems)
      .values({
        id,
        burrowId: ctx.burrow.id,
        connectionId: input.connectionId,
        provider: input.provider,
        mailbox: input.mailbox,
        externalId: input.externalId,
        messageId,
        threadId: input.threadId,
        fromHeader: input.fromHeader,
        fromAddress: input.fromAddress,
        subject: input.subject,
        snippet: input.snippet,
        body: input.body,
        bodyTruncated: input.bodyTruncated,
        attachments: input.attachments,
        attachmentIds: [],
        receivedAt: new Date(input.receivedAt),
        mirroredAt: ctx.now,
      })
      .onConflictDoNothing()
      .returning({ id: mailTriggerItems.id });

    if (input.cursor) {
      await tx
        .insert(mailCursors)
        .values({
          connectionId: input.connectionId,
          burrowId: ctx.burrow.id,
          cursor: input.cursor,
          since: ctx.now,
          checkedAt: ctx.now,
          succeededAt: ctx.now,
          problemCode: null,
          problem: null,
          updatedAt: ctx.now,
        })
        .onConflictDoUpdate({
          target: mailCursors.connectionId,
          set: {
            cursor: input.cursor,
            checkedAt: ctx.now,
            succeededAt: ctx.now,
            problemCode: null,
            problem: null,
            updatedAt: ctx.now,
          },
        });
    }

    if (inserted.length === 0) {
      if (input.stagedAttachments.length > 0) {
        const store = ctx.services.files.store;
        const leftover = input.stagedAttachments.map((a) => a.staged);
        ctx.after(async () => {
          await Promise.allSettled(leftover.map((s) => store.discard(s)));
        });
      }
      return { created: false, rowId: null };
    }

    // Commit handed-over attachments as ready rows inside the same transaction so the run's outsiders' turn can read
    // them via `read_attachment` without ever touching the person's mailbox.
    const attachmentIds: string[] = [];
    for (const file of input.stagedAttachments) {
      const key = blobKey(file.staged.sha256);
      await lockBlob(tx, key);
      await ctx.services.files.store.commit(file.staged, key);
      const attId = newId('attachment');
      await tx.insert(attachments).values({
        id: attId,
        burrowId: ctx.burrow.id,
        conversationId: null,
        messageId: null,
        name: safeDisplayName(file.name),
        declaredType: file.declaredType.replace(/[^\x21-\x7e]/g, '').slice(0, 120),
        contentType: file.sniffed.contentType,
        kind: file.sniffed.kind,
        size: file.staged.size,
        sha256: file.staged.sha256,
        blobKey: key,
        width: file.sniffed.width,
        height: file.sniffed.height,
        state: 'ready',
        url: attachmentUrl(ctx.burrow.slug, attId),
        uploadedById: ctx.actor.id,
        createdAt: ctx.now,
        uploadedAt: ctx.now,
      });
      attachmentIds.push(attId);
    }
    if (attachmentIds.length > 0) {
      await tx.update(mailTriggerItems).set({ attachmentIds }).where(eq(mailTriggerItems.id, id));
    }

    // Content-free signed event: no email subject, sender or body enters the signed audit log.
    await ctx.emit({
      type: 'mail.received',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        rowId: id,
        connectionId: input.connectionId,
        externalId: input.externalId,
        hasAttachments: input.attachments.length > 0,
      },
    });
    return { created: true, rowId: id };
  },
});

/** Deletes mirrored mail deduplication rows older than the retention window through the commit pipeline. */
export const pruneMailTriggerItems = defineCommand({
  name: 'mail.items_pruned',
  schema: z.object({
    before: z.string().datetime(),
  }),
  async apply(tx, ctx, input) {
    await requireMailSigner(tx, ctx.actor.id);
    const cutoff = new Date(input.before);
    const deleted = await tx
      .delete(mailTriggerItems)
      .where(and(eq(mailTriggerItems.burrowId, ctx.burrow.id), lt(mailTriggerItems.mirroredAt, cutoff)))
      .returning({ id: mailTriggerItems.id });
    if (deleted.length > 0) {
      await ctx.emit({
        type: 'mail.items_pruned',
        kind: 'System',
        text: null,
        where: null,
        payload: { count: deleted.length },
      });
    }
    return { deleted: deleted.length };
  },
});

export const MAIL_TRIGGER_COMMANDS = [setMailCursor, recordMailReceived, pruneMailTriggerItems];
