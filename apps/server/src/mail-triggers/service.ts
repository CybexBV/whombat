/**
 * Watches connected mailboxes (Gmail, Microsoft 365, Email/IMAP) that have at least one live `mail` automation.
 *
 * Strategy per provider:
 * - Gmail: History API (`users.getProfile` baseline -> `users.history.list` + partial metadata-only `messages.get`).
 * - Microsoft 365: Graph delta (`$deltaToken=latest` baseline -> deltaLink polling with metadata-only `$select`).
 * - Email (IMAP): IMAP IDLE on INBOX when the server advertises `IDLE` (wakes an immediate sync on EXISTS), plus
 *   UIDVALIDITY + lastUid incremental search with `BODYSTRUCTURE` (headers/attachment metadata only) and a safety poll.
 *
 * Full message bodies (`mailRead`) are fetched ONLY for messages whose headers match at least one live trigger.
 * High-water marks (`mail_cursors`) and matched messages (`mail_trigger_items`) are written strictly through the
 * commit pipeline, so pre-existing mail never triggers and no message ever triggers twice.
 */
import {
  CONNECTOR_BINARY_MAX_BYTES,
  extractMailAddress,
  MAIL_BODY_CAP,
  type MailMessage,
  triggerMatches,
} from '@whombat/core';
import { eq, isNotNull, lt, or } from 'drizzle-orm';
import { imapWorkspaceOf } from '../connectors/imap/service';
import { providerWorkspace } from '../connectors/providers';
import {
  ConnectionUnavailableError,
  GoogleApiError,
  type MailChangesResult,
  type MailHeader,
  type MailProviderCursor,
  normalizeRfcMessageId,
  receivedAtOrAfter,
} from '../connectors/types';
import { connections, mailCursors, mailTriggerItems } from '../db/schema/index';
import { sniffBuffer } from '../files/sniff';
import type { StagedFile } from '../files/store';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import {
  MAIL_RECORDED_MAX_ATTACHMENTS,
  pruneMailTriggerItems,
  recordMailReceived,
  setMailCursor,
} from './commands';
import { mailPrincipal } from './principal';
import {
  consumedMailText,
  hasMirroredMailItem,
  type ListenedMailbox,
  type ListenedMailEntry,
  listenedMailConnections,
} from './store';

const DEFAULT_POLL_MS = 60_000;
const IDLE_BACKOFF_MIN_MS = 5_000;
const IDLE_BACKOFF_MAX_MS = 60_000;
/** Skip a matched message after this many consecutive failed full reads so a mailbox never stalls. */
const MAX_READ_FAILURES = 3;
/** Drop mirrored mail deduplication rows after 30 days. */
export const MAIL_TRIGGER_ITEM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Maximum number of attachments downloaded and handed over per matched email. */
const MAIL_HANDOVER_MAX_ATTACHMENTS = 10;

export interface MailTriggerOptions {
  /** Periodic poll interval for Gmail/Microsoft change feeds and IMAP safety checks (default 60 s). */
  pollIntervalMs?: number;
}

interface IdleHandle {
  controller: AbortController;
  done: Promise<void>;
}

function matchingAutomationNames(
  connectionId: string,
  header: MailHeader,
  entries: readonly ListenedMailEntry[],
): string[] {
  const facts = {
    kind: 'mail' as const,
    connectionId,
    from: header.from,
    subject: header.subject,
    hasAttachments: header.hasAttachments,
    attachments: header.attachments ?? [],
  };
  const names = new Set<string>();
  for (const entry of entries) {
    if (triggerMatches(entry.trigger, facts)) names.add(entry.automationName);
  }
  return [...names];
}

function isMessageGone(err: unknown): boolean {
  if (err instanceof GoogleApiError) return err.status === 404 || err.reason === 'not_found';
  if (err instanceof ApiError) return err.code === 'not_found';
  return false;
}

function isCommitValidationFailure(err: unknown): boolean {
  if (err instanceof ApiError) return err.code === 'validation_failed' || err.code === 'bad_request';
  return err instanceof Error && err.name === 'ZodError';
}

function normalizeRecordedAttachment(
  att: MailMessage['attachments'][number],
): MailMessage['attachments'][number] {
  const id = typeof att.id === 'string' && att.id.length > 0 && att.id.length <= 2048 ? att.id : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    name: String(att.name ?? '').slice(0, 500),
    mimeType: String(att.mimeType || 'application/octet-stream').slice(0, 200),
    size: Number.isFinite(att.size) ? Math.max(0, Math.trunc(att.size)) : 0,
  };
}

function skippedReadProblem(names: readonly string[]): string {
  const list = names.length ? names : ['A mail automation'];
  const who =
    list.length === 1
      ? `“${list[0]}”`
      : list.length === 2
        ? `“${list[0]}” and “${list[1]}”`
        : `“${list[0]}” and ${list.length - 1} other automations`;
  return `${who} skipped one email because it couldn’t be read.`.slice(0, 500);
}

function trimReadFailures(map: Record<string, number>): Record<string, number> | null {
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.slice(-100));
}

function safeIso(raw: string, fallback: Date): string {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback.toISOString();
}

function sameCursor(a: MailProviderCursor | null | undefined, b: MailProviderCursor): boolean {
  if (!a || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'gmail':
      return (
        b.kind === 'gmail' &&
        a.historyId === b.historyId &&
        Boolean(a.backfill) === Boolean(b.backfill) &&
        a.backfill?.pageToken === b.backfill?.pageToken &&
        a.backfill?.afterSeconds === b.backfill?.afterSeconds &&
        a.backfill?.sinceMs === b.backfill?.sinceMs &&
        Boolean(a.paging) === Boolean(b.paging) &&
        a.paging?.startHistoryId === b.paging?.startHistoryId &&
        a.paging?.pageToken === b.paging?.pageToken
      );
    case 'microsoft':
      return (
        b.kind === 'microsoft' &&
        a.deltaLink === b.deltaLink &&
        Boolean(a.paging) === Boolean(b.paging) &&
        a.paging?.sinceMs === b.paging?.sinceMs &&
        a.paging?.dropHeaders === b.paging?.dropHeaders
      );
    case 'imap':
      return (
        b.kind === 'imap' &&
        a.mailbox === b.mailbox &&
        a.uidValidity === b.uidValidity &&
        a.lastUid === b.lastUid &&
        Boolean(a.backfill) === Boolean(b.backfill) &&
        a.backfill?.sinceMs === b.backfill?.sinceMs &&
        a.backfill?.untilUid === b.backfill?.untilUid
      );
    case 'fake':
      return b.kind === 'fake' && a.seq === b.seq;
  }
}

export class MailTriggerService {
  private readonly pollIntervalMs: number;
  private started = false;
  private readonly inFlight = new Set<string>();
  private readonly pendingNudge = new Set<string>();
  private readonly idleWatchers = new Map<string, IdleHandle>();
  private readonly idleUnsupported = new Set<string>();

  constructor(
    private readonly services: Services,
    options: MailTriggerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  /** Registers periodic polling with housekeeping and kicks off an immediate reconciliation. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.services.housekeeping.add('mail triggers', this.pollIntervalMs, () => this.pollOnce());
    this.nudge();
  }

  /** Stops all IMAP IDLE connections cleanly. */
  async stop(): Promise<void> {
    this.started = false;
    const handles = [...this.idleWatchers.values()];
    this.idleWatchers.clear();
    for (const h of handles) h.controller.abort();
    await Promise.allSettled(handles.map((h) => h.done));
  }

  /** Schedules a non-blocking poll (used after publishing/enabling/disabling/deleting a mail automation). */
  nudge(): void {
    if (!this.started) return;
    this.services.background.run('mail triggers nudge', () => this.pollOnce());
  }

  /** Polls every mailbox with a live mail automation once, reconciles IDLE watchers, clears unwatched cursors and prunes expired rows. */
  async pollOnce(): Promise<number> {
    if (this.services.schemaAccess === 'read-only') return 0;
    // Mail automations wait while the release the box would go back to doesn't know them: no mailbox is read, and
    // what they keep (cursors, items) stays for when they go on (automations/release-gate.ts).
    if (!(await this.services.newerAutomations.ready())) {
      this.reconcileIdleStop(new Map());
      return 0;
    }
    const listened = await listenedMailConnections(this.services.db);
    await this.clearUnwatched(listened);
    await this.pruneExpiredItems();
    this.reconcileIdleStop(listened);
    const results = await Promise.allSettled(
      [...listened.entries()].map(async ([connectionId, entry]) => {
        try {
          return await this.syncConnection(connectionId, entry);
        } catch (err) {
          this.services.log.warn(
            { connectionId, err: err instanceof Error ? err.message : String(err) },
            'mail trigger sync failed for mailbox',
          );
          return 0;
        }
      }),
    );
    let triggered = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') triggered += r.value;
    }
    return triggered;
  }

  /** Syncs a single mailbox (serialized per connection so IDLE wakes and periodic polls never overlap). */
  async syncConnection(connectionId: string, watched?: ListenedMailbox): Promise<number> {
    if (this.inFlight.has(connectionId)) {
      this.pendingNudge.add(connectionId);
      return 0;
    }
    this.inFlight.add(connectionId);
    let triggered = 0;
    try {
      if (!(await this.services.newerAutomations.ready())) {
        this.stopIdle(connectionId);
        return 0;
      }
      const target = watched ?? (await listenedMailConnections(this.services.db)).get(connectionId);
      if (!target || target.triggers.length === 0) return 0;
      triggered = await this.syncOne(connectionId, target);
    } finally {
      this.inFlight.delete(connectionId);
      if (this.pendingNudge.delete(connectionId) && this.started) {
        this.services.background.run('mail triggers resync', () => this.syncConnection(connectionId));
      }
    }
    return triggered;
  }

  private async syncOne(connectionId: string, watched: ListenedMailbox): Promise<number> {
    const { burrowId, triggers, since: activationSince } = watched;
    const [conn] = await this.services.db.select().from(connections).where(eq(connections.id, connectionId));
    if (!conn?.services.includes('mail')) return 0;

    const actorId = await mailPrincipal.ensure(this.services, burrowId);
    const now = this.services.clock();

    const [existing] = await this.services.db
      .select()
      .from(mailCursors)
      .where(eq(mailCursors.connectionId, connectionId));

    const recordProblem = async (problemCode: string, problem: string) => {
      if (existing?.problemCode === problemCode && existing?.problem === problem) return;
      await this.commitCursor(burrowId, actorId, { connectionId, problemCode, problem });
    };

    if (conn.status !== 'active') {
      await recordProblem('needs_reauth', 'Reconnect this mailbox in Settings → Connections.');
      this.stopIdle(connectionId);
      return 0;
    }

    let token: string;
    try {
      token = await this.services.google.tokens.accessFor(conn.accountId, conn.provider);
    } catch (err) {
      const code = err instanceof ConnectionUnavailableError ? err.reason : 'token_error';
      await recordProblem(
        code,
        err instanceof Error ? err.message.slice(0, 500) : 'Could not access this mailbox.',
      );
      this.stopIdle(connectionId);
      return 0;
    }

    const workspace = providerWorkspace(this.services, conn.provider);
    const needAttachmentTypes = triggers.some((t) => Boolean(t.attachmentTypes?.length));
    const isInitial = !existing?.cursor || !existing.since;
    // Capture the recovery boundary before reading from the provider so mail delivered while we download bodies and
    // attachments cannot fall into a gap if the provider cursor later expires.
    const readStartedAt = this.services.clock();
    let changes: MailChangesResult;
    if (isInitial) {
      // First poll after activation: backfill from the earliest active trigger's activation time (with 5 s skew
      // margin) so mail delivered between publishing and the first poll fires, while older mail is dropped.
      try {
        changes = await workspace.mailBaseline(token, {
          needAttachmentTypes,
          since: activationSince,
        });
      } catch (err) {
        this.services.log.warn(
          { connectionId, provider: conn.provider, err: err instanceof Error ? err.message : String(err) },
          'mail trigger baseline failed',
        );
        await recordProblem('baseline_failed', 'Could not read this mailbox right now.');
        return 0;
      }
    } else {
      const resyncSince =
        existing.succeededAt && existing.succeededAt > activationSince
          ? existing.succeededAt
          : activationSince;
      try {
        changes = await workspace.mailChanges(token, existing.cursor as MailProviderCursor, {
          needAttachmentTypes,
          since: activationSince,
          resyncSince,
        });
      } catch (err) {
        this.services.log.warn(
          { connectionId, provider: conn.provider, err: err instanceof Error ? err.message : String(err) },
          'mail trigger poll failed',
        );
        await recordProblem('poll_failed', 'Could not check this mailbox for new mail right now.');
        return 0;
      }
    }

    if (this.started && conn.provider === 'imap') this.ensureIdle(connectionId);

    let createdCount = 0;
    const readFailures: Record<string, number> = { ...(existing?.readFailures ?? {}) };
    let failuresChanged = false;
    let skippedProblem: string | null = null;
    const recordBoundedFailure = async (
      failureKey: string,
      messageId: string,
      matchedNames: readonly string[],
      err: unknown,
      stage: 'read' | 'commit',
    ): Promise<'skip' | 'retry'> => {
      const attempts = (readFailures[failureKey] ?? 0) + 1;
      if (attempts >= MAX_READ_FAILURES) {
        delete readFailures[failureKey];
        failuresChanged = true;
        skippedProblem = skippedReadProblem(matchedNames);
        this.services.log.warn(
          {
            connectionId,
            messageId,
            stage,
            attempts,
            err: err instanceof Error ? err.message : String(err),
          },
          stage === 'commit'
            ? 'mail trigger skipped invalid message after 3 failed commits'
            : 'mail trigger skipped unreadable message after 3 failed reads',
        );
        return 'skip';
      }
      readFailures[failureKey] = attempts;
      await this.commitCursor(burrowId, actorId, {
        connectionId,
        readFailures: trimReadFailures(readFailures),
      });
      this.services.log.warn(
        {
          connectionId,
          messageId,
          stage,
          attempts,
          err: err instanceof Error ? err.message : String(err),
        },
        stage === 'commit'
          ? 'mail trigger commit validation failed; will retry on next poll'
          : 'mail trigger full read failed; will retry on next poll',
      );
      return 'retry';
    };
    for (const header of changes.headers) {
      // Drop pre-activation mail defensively even if a provider returned an old moved message.
      if (!receivedAtOrAfter(header.date, activationSince)) continue;
      // Only fetch full message body when headers/attachment metadata match a live trigger.
      const matchedNames = matchingAutomationNames(connectionId, header, watched.entries);
      if (matchedNames.length === 0) continue;
      const failureKey = header.id.slice(0, 200);
      if (await hasMirroredMailItem(this.services.db, connectionId, header.id, header.messageId)) {
        if (failureKey in readFailures) {
          delete readFailures[failureKey];
          failuresChanged = true;
        }
        continue;
      }
      let full: MailMessage | undefined;
      try {
        const list = await workspace.mailRead(token, { messageId: header.id });
        full = list[0];
      } catch (err) {
        if (isMessageGone(err)) {
          // Message was deleted or moved away before we could read it: skip it and let the cursor move on.
          if (failureKey in readFailures) {
            delete readFailures[failureKey];
            failuresChanged = true;
          }
          continue;
        }
        const action = await recordBoundedFailure(failureKey, header.id, matchedNames, err, 'read');
        if (action === 'skip') continue;
        // Do not advance the cursor yet so the next poll retries this message up to 3 times.
        if (createdCount > 0) this.services.automations.nudge();
        return createdCount;
      }
      if (!full) {
        if (failureKey in readFailures) {
          delete readFailures[failureKey];
          failuresChanged = true;
        }
        continue;
      }
      // Hand over matched email attachments on the server so the outsiders' turn reads them via `read_attachment`
      // without ever having access to the person's mailbox. Cap metadata at `MAIL_RECORDED_MAX_ATTACHMENTS` so one
      // message with hundreds of attachments fits the commit schema, and record how many were left out.
      const maxAttBytes = Math.min(CONNECTOR_BINARY_MAX_BYTES, this.services.files.maxBytes);
      const stagedAttachments: {
        name: string;
        declaredType: string;
        staged: StagedFile;
        sniffed: {
          contentType: string;
          kind: 'image' | 'text' | 'document' | 'file';
          width: number | null;
          height: number | null;
        };
      }[] = [];
      const recordedAttachments: ((typeof full.attachments)[number] & {
        missingReason?: 'too_large' | 'unsupported_type' | 'download_failed' | 'too_many';
      })[] = [];
      const totalAttachments = full.attachments.length;
      const metadataCap = Math.min(totalAttachments, MAIL_RECORDED_MAX_ATTACHMENTS);
      const omittedAttachmentCount = Math.max(0, totalAttachments - metadataCap);
      for (let i = 0; i < metadataCap; i++) {
        const rawAtt = full.attachments[i];
        if (!rawAtt) continue;
        const att = normalizeRecordedAttachment(rawAtt);
        if (i >= MAIL_HANDOVER_MAX_ATTACHMENTS) {
          recordedAttachments.push({ ...att, missingReason: 'too_many' });
          continue;
        }
        if (!rawAtt.id) {
          recordedAttachments.push({ ...att, missingReason: 'download_failed' });
          continue;
        }
        if (att.size > maxAttBytes) {
          recordedAttachments.push({ ...att, missingReason: 'too_large' });
          continue;
        }
        try {
          const downloaded = await workspace.mailAttachment(token, {
            messageId: full.id,
            attachmentId: rawAtt.id,
          });
          const bytes = Buffer.from(downloaded.contentBase64, 'base64');
          if (bytes.length > maxAttBytes) {
            recordedAttachments.push({ ...att, missingReason: 'too_large' });
            continue;
          }
          if (bytes.length === 0) {
            recordedAttachments.push({ ...att, missingReason: 'download_failed' });
            continue;
          }
          const fileName = (att.name || downloaded.name || 'attachment').slice(0, 1000) || 'attachment';
          const sniffed = sniffBuffer(bytes, fileName);
          if (!sniffed.ok) {
            recordedAttachments.push({
              ...att,
              missingReason: sniffed.reason === 'image_too_large' ? 'too_large' : 'unsupported_type',
            });
            continue;
          }
          const staged = await this.services.files.store.stage([bytes], { maxBytes: maxAttBytes });
          stagedAttachments.push({
            name: fileName,
            declaredType: (att.mimeType || downloaded.mimeType || '').slice(0, 255),
            staged,
            sniffed: sniffed.value,
          });
          recordedAttachments.push(att);
        } catch (err) {
          recordedAttachments.push({ ...att, missingReason: 'download_failed' });
          this.services.log.warn(
            {
              connectionId,
              messageId: full.id,
              attachmentId: rawAtt.id,
              err: err instanceof Error ? err.message : String(err),
            },
            'mail trigger could not hand over an attachment; continuing without it',
          );
        }
      }
      const fromHeader = full.from || header.from;
      const fromAddress = extractMailAddress(fromHeader) ?? '';
      const externalId = (full.id || header.id).slice(0, 200);
      const threadId = (full.threadId || externalId).slice(0, 200);
      const body = full.body.slice(0, MAIL_BODY_CAP);
      const bodyTruncated = full.bodyTruncated || full.body.length > MAIL_BODY_CAP;
      let committed = false;
      try {
        const res = await this.services.pipeline.commit(
          recordMailReceived,
          {
            connectionId,
            provider: conn.provider,
            mailbox: (conn.email || 'mailbox').slice(0, 320),
            externalId,
            messageId: normalizeRfcMessageId(header.messageId),
            threadId,
            fromHeader: fromHeader.slice(0, 500),
            fromAddress: fromAddress.slice(0, 320),
            subject: full.subject.slice(0, 1000),
            snippet: full.snippet.slice(0, 500),
            body,
            bodyTruncated,
            attachments: recordedAttachments,
            omittedAttachmentCount,
            stagedAttachments,
            receivedAt: safeIso(full.date, now),
          },
          { burrowId, actorId },
        );
        committed = res.status === 'ok';
        if (res.status === 'ok' && res.result.created) createdCount++;
        if (failureKey in readFailures) {
          delete readFailures[failureKey];
          failuresChanged = true;
        }
      } catch (err) {
        if (isCommitValidationFailure(err)) {
          const action = await recordBoundedFailure(failureKey, header.id, matchedNames, err, 'commit');
          if (action === 'skip') continue;
          if (createdCount > 0) this.services.automations.nudge();
          return createdCount;
        }
        throw err;
      } finally {
        if (!committed && stagedAttachments.length > 0) {
          await Promise.allSettled(stagedAttachments.map((a) => this.services.files.store.discard(a.staged)));
        }
      }
    }

    // Advance the durable high-water mark through the commit pipeline only when the cursor, baseline, failures or
    // problem state changed, so quiet polls never bloat the signed event log (keep a skipped-mail `read_failed` note
    // on quiet polls until another write replaces it). While backfill/catch-up still has more batches (`changes.more`),
    // keep `succeededAt` before the backfill window so a mid-backfill reset never skips unprocessed pages.
    const morePending = Boolean(changes.more);
    const finishingBackfill =
      !isInitial &&
      (existing?.cursor?.kind === 'gmail' || existing?.cursor?.kind === 'imap') &&
      Boolean(existing.cursor.backfill);
    const recoveryBoundary = finishingBackfill
      ? existing?.succeededAt && existing.succeededAt > activationSince
        ? existing.succeededAt
        : activationSince
      : readStartedAt;
    const clearTransientProblem = existing?.problemCode !== null && existing?.problemCode !== 'read_failed';
    const cursorChanged = !sameCursor(existing?.cursor, changes.cursor);
    if (
      isInitial ||
      cursorChanged ||
      changes.reset ||
      failuresChanged ||
      skippedProblem !== null ||
      clearTransientProblem ||
      existing?.since?.getTime() !== activationSince.getTime()
    ) {
      await this.commitCursor(burrowId, actorId, {
        connectionId,
        cursor: changes.cursor,
        since: activationSince.toISOString(),
        succeeded: !morePending,
        ...(!morePending ? { succeededAt: recoveryBoundary.toISOString() } : {}),
        ...(failuresChanged ? { readFailures: trimReadFailures(readFailures) } : {}),
        ...(skippedProblem
          ? { problemCode: 'read_failed', problem: skippedProblem }
          : clearTransientProblem
            ? { problemCode: null, problem: null }
            : {}),
      });
    }

    if (createdCount > 0) this.services.automations.nudge();
    if (morePending && (isInitial || cursorChanged) && this.started) {
      this.pendingNudge.add(connectionId);
    }
    return createdCount;
  }

  private async commitCursor(
    burrowId: string,
    actorId: string,
    input: Parameters<typeof setMailCursor.apply>[2],
  ): Promise<void> {
    await this.services.pipeline.commit(setMailCursor, input, { burrowId, actorId });
  }

  private async clearUnwatched(listened: ReadonlyMap<string, unknown>): Promise<void> {
    const activeRows = await this.services.db
      .select({ connectionId: mailCursors.connectionId, burrowId: mailCursors.burrowId })
      .from(mailCursors)
      .where(or(isNotNull(mailCursors.cursor), isNotNull(mailCursors.since)));
    for (const row of activeRows) {
      if (listened.has(row.connectionId)) continue;
      const actorId = await mailPrincipal.ensure(this.services, row.burrowId);
      await this.commitCursor(row.burrowId, actorId, { connectionId: row.connectionId, clear: true });
    }
  }

  private async pruneExpiredItems(): Promise<number> {
    const cutoff = new Date(this.services.clock().getTime() - MAIL_TRIGGER_ITEM_RETENTION_MS);
    const burrows = await this.services.db
      .selectDistinct({ burrowId: mailTriggerItems.burrowId })
      .from(mailTriggerItems)
      .where(or(lt(mailTriggerItems.mirroredAt, cutoff), consumedMailText()));
    let deleted = 0;
    for (const { burrowId } of burrows) {
      const actorId = await mailPrincipal.ensure(this.services, burrowId);
      const res = await this.services.pipeline.commit(
        pruneMailTriggerItems,
        { before: cutoff.toISOString() },
        { burrowId, actorId },
      );
      if (res.status === 'ok') deleted += res.result.deleted;
    }
    return deleted;
  }

  private reconcileIdleStop(listened: ReadonlyMap<string, unknown>): void {
    for (const connectionId of [...this.idleWatchers.keys()]) {
      if (!listened.has(connectionId)) this.stopIdle(connectionId);
    }
  }

  private stopIdle(connectionId: string): void {
    const handle = this.idleWatchers.get(connectionId);
    if (!handle) return;
    this.idleWatchers.delete(connectionId);
    handle.controller.abort();
  }

  private ensureIdle(connectionId: string): void {
    if (!this.started || this.idleWatchers.has(connectionId) || this.idleUnsupported.has(connectionId))
      return;
    const controller = new AbortController();
    const done = this.runIdleLoop(connectionId, controller.signal).finally(() => {
      if (this.idleWatchers.get(connectionId)?.controller === controller) {
        this.idleWatchers.delete(connectionId);
      }
    });
    this.idleWatchers.set(connectionId, { controller, done });
  }

  private async runIdleLoop(connectionId: string, signal: AbortSignal): Promise<void> {
    let backoffMs = IDLE_BACKOFF_MIN_MS;
    let reconnecting = false;
    const imap = imapWorkspaceOf(this.services);
    while (this.started && !signal.aborted) {
      const startedAt = Date.now();
      try {
        const result = await imap.watchInbox(
          connectionId,
          () => {
            if (this.started && !signal.aborted) {
              this.services.background.run('mail idle sync', () => this.syncConnection(connectionId));
            }
          },
          signal,
        );
        if (result === 'unsupported') {
          this.idleUnsupported.add(connectionId);
          return;
        }
        if (signal.aborted || !this.started) return;
        // If IDLE ended immediately without throwing, back off so a flaky server can never busy-spin.
        if (Date.now() - startedAt < IDLE_BACKOFF_MIN_MS) {
          await sleepAbortable(backoffMs, signal);
          backoffMs = Math.min(IDLE_BACKOFF_MAX_MS, backoffMs * 2);
        } else {
          backoffMs = IDLE_BACKOFF_MIN_MS;
        }
        reconnecting = true;
      } catch (err) {
        if (signal.aborted || !this.started) return;
        this.services.log.debug(
          { connectionId, err: err instanceof Error ? err.message : String(err) },
          'imap idle connection ended; backing off before reconnect',
        );
        await sleepAbortable(backoffMs, signal);
        backoffMs = Math.min(IDLE_BACKOFF_MAX_MS, backoffMs * 2);
        reconnecting = true;
      }
      if (reconnecting && this.started && !signal.aborted) {
        this.services.background.run('mail idle resync', () => this.syncConnection(connectionId));
      }
    }
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
