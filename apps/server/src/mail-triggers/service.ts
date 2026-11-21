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
import { extractMailAddress, type MailMessage, type MailTrigger, triggerMatches } from '@whombat/core';
import { eq, isNotNull, or } from 'drizzle-orm';
import { imapWorkspaceOf } from '../connectors/imap/service';
import { providerWorkspace } from '../connectors/providers';
import {
  ConnectionUnavailableError,
  type MailChangesResult,
  type MailHeader,
  type MailProviderCursor,
  receivedAtOrAfter,
} from '../connectors/types';
import { connections, mailCursors } from '../db/schema/index';
import type { Services } from '../services';
import { recordMailReceived, setMailCursor } from './commands';
import { mailPrincipal } from './principal';
import { hasMirroredMailItem, type ListenedMailbox, listenedMailConnections } from './store';

const DEFAULT_POLL_MS = 60_000;
const IDLE_BACKOFF_MIN_MS = 5_000;
const IDLE_BACKOFF_MAX_MS = 60_000;

export interface MailTriggerOptions {
  /** Periodic poll interval for Gmail/Microsoft change feeds and IMAP safety checks (default 60 s). */
  pollIntervalMs?: number;
}

interface IdleHandle {
  controller: AbortController;
  done: Promise<void>;
}

function headerMatchesAny(
  connectionId: string,
  header: MailHeader,
  triggers: readonly MailTrigger[],
): boolean {
  const facts = {
    kind: 'mail' as const,
    connectionId,
    from: header.from,
    subject: header.subject,
    hasAttachments: header.hasAttachments,
    attachments: header.attachments ?? [],
  };
  return triggers.some((t) => triggerMatches(t, facts));
}

function safeIso(raw: string, fallback: Date): string {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback.toISOString();
}

function sameCursor(a: MailProviderCursor | null | undefined, b: MailProviderCursor): boolean {
  if (!a || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'gmail':
      return b.kind === 'gmail' && a.historyId === b.historyId;
    case 'microsoft':
      return b.kind === 'microsoft' && a.deltaLink === b.deltaLink;
    case 'imap':
      return (
        b.kind === 'imap' &&
        a.mailbox === b.mailbox &&
        a.uidValidity === b.uidValidity &&
        a.lastUid === b.lastUid
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

  /** Polls every mailbox with a live mail automation once, reconciles IDLE watchers, and clears unwatched cursors. */
  async pollOnce(): Promise<number> {
    if (this.services.schemaAccess === 'read-only') return 0;
    const listened = await listenedMailConnections(this.services.db);
    await this.clearUnwatched(listened);
    this.reconcileIdleStop(listened);
    let triggered = 0;
    for (const [connectionId, entry] of listened) {
      triggered += await this.syncConnection(connectionId, entry);
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
    for (const header of changes.headers) {
      // Drop pre-activation mail defensively even if a provider returned an old moved message.
      if (!receivedAtOrAfter(header.date, activationSince)) continue;
      // Only fetch full message body when headers/attachment metadata match a live trigger.
      if (!headerMatchesAny(connectionId, header, triggers)) continue;
      if (await hasMirroredMailItem(this.services.db, connectionId, header.id, header.messageId)) continue;
      let full: MailMessage | undefined;
      try {
        const list = await workspace.mailRead(token, { messageId: header.id });
        full = list[0];
      } catch (err) {
        this.services.log.warn(
          { connectionId, messageId: header.id, err: err instanceof Error ? err.message : String(err) },
          'mail trigger full read failed; will retry on next poll',
        );
        // Do not advance the cursor past an unread match so the next poll retries cleanly.
        if (createdCount > 0) this.services.automations.nudge();
        return createdCount;
      }
      if (!full) continue;
      const fromHeader = full.from || header.from;
      const fromAddress = extractMailAddress(fromHeader) ?? '';
      const res = await this.services.pipeline.commit(
        recordMailReceived,
        {
          connectionId,
          provider: conn.provider,
          mailbox: conn.email,
          externalId: full.id,
          messageId: header.messageId ?? null,
          threadId: full.threadId,
          fromHeader: fromHeader.slice(0, 500),
          fromAddress: fromAddress.slice(0, 320),
          subject: full.subject.slice(0, 1000),
          snippet: full.snippet.slice(0, 500),
          body: full.body,
          bodyTruncated: full.bodyTruncated,
          attachments: full.attachments,
          receivedAt: safeIso(full.date, now),
        },
        { burrowId, actorId },
      );
      if (res.status === 'ok' && res.result.created) createdCount++;
    }

    // Advance the durable high-water mark through the commit pipeline only when the cursor, baseline or problem state
    // changed, so quiet polls never bloat the signed event log.
    if (
      isInitial ||
      !sameCursor(existing?.cursor, changes.cursor) ||
      changes.reset ||
      existing?.problemCode !== null ||
      existing?.since?.getTime() !== activationSince.getTime()
    ) {
      await this.commitCursor(burrowId, actorId, {
        connectionId,
        cursor: changes.cursor,
        since: activationSince.toISOString(),
        succeeded: true,
      });
    }

    if (createdCount > 0) this.services.automations.nudge();
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
