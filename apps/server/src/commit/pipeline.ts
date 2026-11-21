/**
 * The commit pipeline — the only write path (ARCHITECTURE "The commit pipeline").
 *
 *   commit(command, input, {burrowId, actorId})
 *     1. validate the input (the command's Zod schema)
 *     2. one transaction holding the burrow's advisory lock:
 *        keys engine → deny:  signed Blocked event                          → { status: 'blocked' }  (403)
 *                    → ask:   Approval + card message + signed Asks event   → { status: 'pending_approval' } (202)
 *                    → allow: command.apply (domain change + signed events) → { status: 'ok' }
 *        outbox rows for every realtime frame are written in the same transaction
 *     3. after commit: publish the outbox to the in-process bus, then run post-commit hooks
 *        (unread badges, search index, notifications, approval re-evaluation and required continuations)
 *
 * REST routes (and later MCP tools) are thin adapters over `commit`.
 */

import {
  blockedEventFields,
  type Decision,
  decide,
  describeDecision,
  EventEnvelope,
  type JsonObject,
  keyRefOf,
  newId,
  RealtimeEvent,
  type SignedEvent,
  topics,
} from '@whombat/core';
import { eq, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { scrubForAgent } from '../agent-commands/secrets';
import { createAskApproval } from '../approvals/create';
import { appendSignedEvent, lockBurrow, toAuditEvent } from '../audit/events';
import type { Tx } from '../db/client';
import { approvals, burrows, outbox, principals } from '../db/schema/index';
import { forbidden, notFound, validationError } from '../lib/errors';
import { iso } from '../lib/time';
import { type ActorInfo, engineActor, loadGrants, loadPrincipalRow, toActor } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import type { Services } from '../services';
import { underBurrowLock } from './lock-scope';
import { currentCommandScope } from './scope';
import type {
  ApplyContext,
  BurrowRow,
  CommandDef,
  CommitOptions,
  CommitResult,
  CompletionHook,
  EmitFields,
  PostCommitHook,
  PublishOptions,
  TxSession,
} from './types';

const DraftSchema = EventEnvelope.omit({ v: true, seq: true, prevHash: true });

interface OutboxDraft {
  topic: string;
  event: RealtimeEvent;
  eventId: string | null;
}

interface BackgroundHook {
  what: string;
  hook: PostCommitHook;
  key: string | undefined;
}

class Session implements TxSession {
  readonly outbox: OutboxDraft[] = [];
  readonly beforeHooks: PostCommitHook[] = [];
  readonly completions: CompletionHook[] = [];
  readonly hooks: PostCommitHook[] = [];
  readonly backgroundHooks: BackgroundHook[] = [];
  private readonly ids: string[] = [];
  private readonly keys = new Map<string, string>();

  constructor(
    readonly tx: Tx,
    readonly services: Services,
    readonly burrowId: string,
  ) {}

  get eventIds(): readonly string[] {
    return this.ids;
  }

  /** Caches a principal's encrypted key for signing (saves a lookup per event). */
  rememberKey(principalId: string, secretKeyEnc: string): void {
    this.keys.set(principalId, secretKeyEnc);
  }

  async append(actorId: string, fields: EmitFields & { createdAt: string }): Promise<SignedEvent> {
    const { approvalState, ...rest } = fields;
    const draft = DraftSchema.parse({
      ...rest,
      id: rest.id ?? newId('event'),
      burrowId: this.burrowId,
      actorId,
      payload: rest.payload ?? {},
    });
    let enc = this.keys.get(actorId);
    if (!enc) {
      const [row] = await this.tx
        .select({ secretKeyEnc: principals.secretKeyEnc, burrowId: principals.burrowId })
        .from(principals)
        .where(eq(principals.id, actorId));
      if (!row || row.burrowId !== this.burrowId)
        throw new Error(`Cannot sign as ${actorId} in ${this.burrowId}`);
      enc = row.secretKeyEnc;
      this.keys.set(actorId, enc);
    }
    const signed = await appendSignedEvent(this.tx, this.services.custody, draft, enc);
    this.ids.push(signed.id);
    if (signed.text !== null) {
      this.publish(
        topics.burrow(this.burrowId),
        { type: 'audit.appended', event: toAuditEvent(signed, true, approvalState ?? null) },
        { eventId: signed.id },
      );
    }
    return signed;
  }

  publish(topic: string, event: RealtimeEvent, options: PublishOptions = {}): void {
    const checked = this.services.config.NODE_ENV === 'production' ? event : RealtimeEvent.parse(event);
    this.outbox.push({
      topic,
      event: checked,
      eventId: options.eventId ?? null,
    });
  }

  beforeCommit(hook: PostCommitHook): void {
    this.beforeHooks.push(hook);
  }

  complete(hook: CompletionHook): void {
    this.completions.push(hook);
  }

  after(hook: PostCommitHook): void {
    this.hooks.push(hook);
  }

  background(what: string, hook: PostCommitHook, key?: string): void {
    this.backgroundHooks.push({ what, hook, key });
  }

  /**
   * Writes the frames' outbox rows and returns the frames to publish after the commit. Only the ids and times come
   * back from Postgres; the frames are the ones in memory (server-efficiency.md SV-05).
   */
  async flushOutbox(): Promise<BusFrame[]> {
    if (this.outbox.length === 0) return [];
    const rows = await this.tx
      .insert(outbox)
      .values(
        this.outbox.map((o) => ({
          burrowId: this.burrowId || null,
          topic: o.topic,
          event: o.event as unknown as Record<string, unknown>,
          eventId: o.eventId,
        })),
      )
      .returning({ id: outbox.id, createdAt: outbox.createdAt });
    // Postgres returns a multi-row INSERT's rows in VALUES order. Each frame is a copy as JSON makes it (what the
    // stored row reads back as), so nothing the command does with its objects afterwards reaches a frame.
    return this.outbox.map((o, i) => {
      const row = rows[i];
      if (!row) throw new Error('outbox: a frame got no row');
      return {
        topic: o.topic,
        event: JSON.parse(JSON.stringify(o.event)) as RealtimeEvent,
        eventId: o.eventId,
        at: iso(row.createdAt),
        outboxId: row.id,
      };
    });
  }
}

export async function loadBurrowRow(db: Services['db'] | Tx, id: string): Promise<BurrowRow | undefined> {
  const [row] = await db.select().from(burrows).where(eq(burrows.id, id));
  return row;
}

/** How long one write may wait for the burrow lock, and one of its statements may run. */
export const WRITE_LIMIT = '60s';

export class Pipeline {
  private readonly registry = new Map<string, CommandDef>();

  constructor(private readonly services: Services) {}

  register(...defs: CommandDef[]): void {
    for (const def of defs) {
      if (this.registry.has(def.name)) throw new Error(`Command ${def.name} registered twice`);
      this.registry.set(def.name, def);
    }
  }

  get(name: string): CommandDef {
    const def = this.registry.get(name);
    if (!def) throw new Error(`Unknown command ${name}`);
    return def;
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** Runs a command for an actor in a burrow. Validation errors and domain errors throw `ApiError`. */
  async commit<S extends z.ZodType, R>(
    command: CommandDef<S, R> | string,
    input: unknown,
    options: CommitOptions,
  ): Promise<CommitResult<R>> {
    const def = (typeof command === 'string' ? this.get(command) : command) as CommandDef<S, R>;
    const parsed = def.schema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const parsedData = parsed.data as z.output<S>;
    // A new agent turn on a lapsed appliance is refused up front; an approved action continues (LC-10).
    if (def.licence === 'agentTurn' && !options.approvalId) this.services.licence.assertNotLapsed();

    // A session command's write begins: whatever it reads afterwards isn't a read-back yet (command-safety CS-12).
    const scope = currentCommandScope();
    scope?.beforeWrite?.();
    const { result, eventIds } = await this.transact(options.burrowId, async (session) => {
      const tx = session.tx;
      const burrow = await loadBurrowRow(tx, options.burrowId);
      if (!burrow) throw notFound('Whombat');
      const actorRow = await loadPrincipalRow(tx, options.actorId);
      if (!actorRow || actorRow.burrowId !== burrow.id) throw forbidden('You’re not on this Whombat.');
      const actor = toActor(actorRow);
      session.rememberKey(actor.id, actor.secretKeyEnc);
      // What an agent writes never carries a value it holds (agent-computer.md AC-32): scrubbed here, the one
      // door every agent-authored message, edit, note and request passes, before anything reads or stores it.
      const data =
        actor.kind === 'agent' ? await scrubForAgent(this.services, tx, actor.id, parsedData) : parsedData;
      const now = options.now ?? this.services.clock();
      const at = iso(now);
      const onBehalfOf = options.onBehalfOf ?? {};
      if (options.approvalId) {
        // Only the approvals engine runs a deferred command, for the approval that holds it, while it runs.
        const [held] = await tx.select().from(approvals).where(eq(approvals.id, options.approvalId));
        if (
          !held ||
          held.burrowId !== burrow.id ||
          held.state !== 'approved' ||
          held.requesterId !== actor.id ||
          held.command?.name !== def.name ||
          held.execution.state !== 'running'
        ) {
          throw forbidden('That approval does not cover this action.');
        }
      }

      const requirement = def.requiredKey
        ? await def.requiredKey(data, { db: tx, services: this.services, burrow, actor })
        : null;
      let decision: Decision | null = null;
      if (requirement) {
        const grants = actor.kind === 'agent' ? (requirement.grants ?? (await loadGrants(tx, actor.id))) : [];
        decision = decide(engineActor(actor), grants, requirement.keyId, requirement.scope);

        if (decision.outcome === 'deny') {
          const fields = blockedEventFields(decision, actor.shortName, requirement.attempt);
          const event = await session.append(actor.id, {
            ...fields,
            where: requirement.where ?? null,
            ...(requirement.ref ? { ref: requirement.ref } : {}),
            ...behalf(onBehalfOf),
            payload: { command: def.name, keyId: requirement.keyId, reason: decision.reason },
            createdAt: at,
          });
          const keyNeeded = fields.keyUsed as NonNullable<typeof fields.keyUsed>;
          return {
            status: 'blocked',
            keyNeeded,
            eventId: event.id,
            message: describeDecision(decision, actor.shortName),
          } satisfies CommitResult<R>;
        }

        if (
          decision.outcome === 'ask' &&
          !options.approvalId &&
          (requirement.onAsk ?? 'approval') === 'approval'
        ) {
          const created = await createAskApproval(session, {
            burrow,
            actor,
            decision,
            requirement,
            command: { name: def.name, input: toJsonObject(data) },
            at,
            onBehalfOf,
          });
          return {
            status: 'pending_approval',
            approvalId: created.approval.id,
            approvalNumber: created.approval.number,
            eventId: created.eventId,
            message: describeDecision(decision, actor.shortName),
          } satisfies CommitResult<R>;
        }
      }

      const ctx = applyContext(session, {
        burrow,
        actor,
        now,
        at,
        decision,
        requirement,
        approvalId: options.approvalId ?? null,
        onBehalfOf,
      });
      const value = await def.apply(tx, ctx, data);
      return { status: 'ok', result: value, eventIds: [...session.eventIds] } satisfies CommitResult<R>;
    });
    if (result.status === 'ok') {
      scope?.resultDecided?.();
      return { ...result, eventIds };
    }
    return result;
  }

  /**
   * One transaction holding the burrow lock, with signed-event, outbox and post-commit support.
   * Used by `commit` and by bootstrap writes that create their own actor (new burrow, seed).
   */
  async transact<R>(
    burrowId: string,
    fn: (session: Session) => Promise<R>,
  ): Promise<{ result: R; eventIds: string[] }> {
    let session: Session | undefined;
    // A session command (managed mode, MA-09): its receipt is accepted in this same transaction.
    const scope = currentCommandScope();
    // A backup checkpoint's write barrier (MR-15, drain scope `writes`): new writes wait; ones in flight finish.
    const gate = this.services.maintenance;
    await gate.writeBarrier();
    gate.activeWrites += 1;
    const { result, frames } = await this.services.db
      .transaction((tx) =>
        underBurrowLock(async () => {
          // No write waits for the lock, or runs a statement, for ever: past the limit it fails and says so.
          await tx.execute(
            sql`select set_config('statement_timeout', ${WRITE_LIMIT}, true), set_config('lock_timeout', ${WRITE_LIMIT}, true)`,
          );
          if (burrowId) await lockBurrow(tx, burrowId);
          const s = new Session(tx, this.services, burrowId);
          session = s;
          const value = await fn(s);
          for (const hook of s.beforeHooks) await hook();
          const flushed = await s.flushOutbox();
          if (scope) await scope.beforeCommit(tx);
          return { result: value, frames: flushed };
        }),
      )
      .finally(() => {
        gate.activeWrites -= 1;
      });
    scope?.afterCommit();
    const s = session as unknown as Session;
    await this.afterCommit(frames, s.hooks, s.backgroundHooks);
    const eventIds = [...s.eventIds];
    for (const hook of s.completions) eventIds.push(...(await hook()));
    return { result, eventIds };
  }

  /** Account-level writes (preferences, devices, tokens): no burrow, no keys, no signed events. */
  async transactAccount<R>(fn: (tx: Tx, session: TxSession) => Promise<R>): Promise<R> {
    const { result } = await this.transact('', (session) => fn(session.tx, session));
    return result;
  }

  /**
   * After the commit: the frames go to the bus in order, the background hooks start (SV-02), then the `after` hooks run
   * one by one (follow-up work the response waits for). The outbox rows aren't marked
   * published (SV-05): sockets are per process, so a row is only ever for this process's bus, and the hourly prune
   * removes it a day later.
   */
  private async afterCommit(
    frames: BusFrame[],
    hooks: PostCommitHook[],
    background: BackgroundHook[],
  ): Promise<void> {
    for (const frame of frames) this.services.bus.publish(frame);
    for (const b of background) {
      if (b.key) this.services.background.serial(b.key, b.what, b.hook);
      else this.services.background.run(b.what, b.hook);
    }
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        this.services.log.error({ err }, 'post-commit hook failed');
      }
    }
  }

  /**
   * Housekeeping (startup and hourly, SV-05): outbox rows older than a day go. Nothing reads them after their commit
   * published them (a crash's leftovers had no live subscriber either: sockets are per process).
   */
  async drainOutbox(): Promise<{ deleted: number }> {
    const cutoff = new Date(this.services.clock().getTime() - OUTBOX_KEEP_MS);
    const deleted = await this.services.db.delete(outbox).where(lt(outbox.createdAt, cutoff));
    return { deleted: deleted.count };
  }
}

/** How long outbox rows are kept (SV-05). */
export const OUTBOX_KEEP_MS = 24 * 3600_000;

function behalf(onBehalfOf: { text?: string; principalId?: string }): Partial<EmitFields> {
  const out: Partial<EmitFields> = {};
  if (onBehalfOf.text) out.onBehalfOf = onBehalfOf.text;
  if (onBehalfOf.principalId) out.onBehalfOfId = onBehalfOf.principalId;
  return out;
}

export function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

export interface ContextParts {
  burrow: BurrowRow;
  actor: ActorInfo;
  now: Date;
  at: string;
  decision: Decision | null;
  requirement: ApplyContext['requirement'];
  approvalId: string | null;
  onBehalfOf: { text?: string; principalId?: string };
}

/** Binds a session to an actor: `emit` signs as the actor, at `now`, on behalf of whoever the call is for. */
export function applyContext(session: TxSession, parts: ContextParts): ApplyContext {
  return {
    tx: session.tx,
    services: session.services,
    burrowId: session.burrowId,
    append: (actorId, fields) => session.append(actorId, fields),
    publish: (topic, event, options) => session.publish(topic, event, options),
    beforeCommit: (hook) => session.beforeCommit(hook),
    complete: (hook) => session.complete(hook),
    after: (hook) => session.after(hook),
    background: (what, hook, key) => session.background(what, hook, key),
    get eventIds() {
      return session.eventIds;
    },
    ...parts,
    emit: (fields) => {
      // An agent acting under a key records it as KEY USED unless the command says otherwise.
      const keyUsed =
        !fields.keyUsed && parts.actor.kind === 'agent' && parts.decision && parts.decision.outcome !== 'deny'
          ? { keyUsed: keyRefOf(parts.decision.keyId) }
          : {};
      return session.append(parts.actor.id, {
        createdAt: parts.at,
        ...behalf(parts.onBehalfOf),
        ...keyUsed,
        ...fields,
      });
    },
  };
}

export type { Session };
