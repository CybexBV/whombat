/**
 * Durable command receipts (MA-09, docs/decisions/managed-runtime.md MR-06; docs/decisions/command-safety.md).
 *
 * A command request `(principal, op, requestId)` gets one `command_receipts` row bound to the request digest
 * `sha256(canonicalJson({op, input}))`:
 *
 *   received ──(the command's transaction commits; same transaction)──► accepted ──► completed | rejected
 *      │  └──(an external effect before the commit, CS-01: the row is marked, outside the transaction)
 *      └──(failed, cancelled or past its deadline before any commit or effect)──► not_executed (a retry runs it again)
 *
 * - A retry with the same id and digest never runs the command twice: a finished receipt replays its stored
 *   outcome, one still running in this process joins it, a `received` one whose process died never committed (the
 *   accept is in the command's own transaction), so it runs — unless it was marked for an external effect: then it
 *   may have acted, and it finishes as an unknown outcome (CS-02).
 * - An `accepted` one whose process died committed, but its result is gone: it finishes `completed` with its result
 *   redacted, “done, check the current state” (CS-06, CT-195), never `accepted` for ever.
 * - The same id with another digest is refused (`idempotency_mismatch`).
 * - `status` answers the receipt state for an ambiguous outcome; an enrolled device also finds the receipts it made
 *   as `peer:<peerId>` before its enrollment (CS-04).
 * - Retention: finished receipts are removed after `WHOMBAT_COMMAND_RECEIPT_HOURS`; `accepted` ones are kept.
 */
import { requestDigest } from '@whombat/protocol/session';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { commandReceipts, type ReceiptState } from '../db/schema/index';

export interface ReceiptKey {
  principalId: string;
  op: string;
  requestId: string;
}

/**
 * What a command ended with, as replayed to a retry (the protocol's `result` / `error`). A redacted result was not
 * kept (CT-44, CT-195): a `secret` op's never is, nor the result of a command whose process died after its commit
 * (CS-06) or whose handler failed after its commit while reading its result back (CS-05).
 */
export type CommandOutcome =
  | { kind: 'result'; resultKind: 'ok' | 'approval_required'; output: unknown; redacted?: false }
  | { kind: 'result'; resultKind: 'ok' | 'approval_required'; redacted: true }
  | {
      kind: 'error';
      code: string;
      message: string;
      retryable: boolean;
      details?: unknown;
      fields?: Record<string, string[]>;
    };

/**
 * The mark a `received` receipt carries in its `outcome` column once its command ran an external effect before its
 * commit (CS-01). Never replayed: it only tells a later process that the command may have acted.
 */
export interface EffectMark {
  kind: 'effect';
  label: string;
  at: string;
}

/** The protocol's receipt states (`status`): `not_found` = never committed, safe to resend. */
export type PublicReceiptState = 'not_found' | 'accepted' | 'executing' | 'completed' | 'rejected';

/** Committed, its result not kept: “done, check the current state” (CS-05, CS-06). */
export const REDACTED_COMPLETION: CommandOutcome = { kind: 'result', resultKind: 'ok', redacted: true };

/**
 * A command that may have acted outside the database but recorded nothing (CS-02): an unknown outcome
 * (`unknown_outcome`, final for the id — a retry never runs it again).
 */
export function unknownOutcome(
  message = 'This may have happened, but the appliance couldn’t record it. Check the current state before doing it again.',
): CommandOutcome {
  return { kind: 'error', code: 'unknown_outcome', message, retryable: false };
}

type BeginResult =
  | { kind: 'new' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; state: 'completed' | 'rejected'; outcome: CommandOutcome };

/** How a command request is answered. */
export type ExecuteAnswer =
  | {
      kind: 'outcome';
      state: 'completed' | 'rejected' | 'not_executed';
      outcome: CommandOutcome;
      replayed: boolean;
    }
  /** The id was used with another payload. */
  | { kind: 'mismatch' };

/** What an execution reports: `not_executed` = nothing committed (cancelled, deadline, failure before commit). */
export interface ExecutionResult {
  state: 'completed' | 'rejected' | 'not_executed';
  outcome: CommandOutcome;
}

/** `@whombat/protocol`'s idempotency digest: sha256(canonicalJson({op, input})). */
export { requestDigest };

/**
 * What a receipt may keep of an outcome. A `secret` op's input or result carries a secret (CT-44, MA-19f): its result
 * is dropped (only the state and kind stay) and an error keeps only its code and message (no fields or details that
 * could echo the input).
 */
export function storedOutcome(outcome: CommandOutcome, secret: boolean): CommandOutcome {
  if (!secret) return outcome;
  if (outcome.kind === 'result') return { kind: 'result', resultKind: outcome.resultKind, redacted: true };
  return { kind: 'error', code: outcome.code, message: outcome.message, retryable: outcome.retryable };
}

const keyString = (k: ReceiptKey) => `${k.principalId}\u0000${k.op}\u0000${k.requestId}`;

function whereKey(k: ReceiptKey) {
  return and(
    eq(commandReceipts.principalId, k.principalId),
    eq(commandReceipts.op, k.op),
    eq(commandReceipts.requestId, k.requestId),
  );
}

/** The receipt was settled by another process (it took the command for dead): this one may not commit it (CS-13). */
export class ReceiptSettled extends Error {
  constructor() {
    super('the command receipt was settled elsewhere');
  }
}

const isEffectMark = (value: unknown): value is EffectMark =>
  (value as { kind?: unknown } | null)?.kind === 'effect';
const isPendingResult = (value: unknown): boolean =>
  (value as { kind?: unknown } | null)?.kind === 'pending_result';

interface Inflight {
  digest: string;
  accepted: boolean;
  listeners: (() => void)[];
  answer: Promise<ExecuteAnswer>;
}

export class CommandReceipts {
  private readonly inflight = new Map<string, Inflight>();

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date,
  ) {}

  /** Commands executing in this process (drain reports them). */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * The key a request's receipt has (CS-04). `principalIds` are the session's, its own first: an enrolled device's
   * account, then `peer:<peerId>` of the same Noise peer. A request with this id and op the device made before its
   * enrollment keeps the receipt it made then, so a retry after the enrollment meets it; otherwise the first.
   */
  async keyFor(principalIds: readonly string[], op: string, requestId: string): Promise<ReceiptKey> {
    const keys = principalIds.map((principalId) => ({ principalId, op, requestId }));
    const [own] = keys;
    if (!own) throw new Error('a receipt needs a principal');
    if (keys.length === 1) return own;
    const live = keys.find((k) => this.inflight.has(keyString(k)));
    if (live) return live;
    const rows = await this.db
      .select({ principalId: commandReceipts.principalId })
      .from(commandReceipts)
      .where(
        and(
          inArray(commandReceipts.principalId, [...principalIds]),
          eq(commandReceipts.op, op),
          eq(commandReceipts.requestId, requestId),
        ),
      );
    return keys.find((k) => rows.some((r) => r.principalId === k.principalId)) ?? own;
  }

  /**
   * Runs a command at most once per `(principal, op, requestId)`. `onAccepted` fires (once) after the command's
   * first transaction committed — also for a retry that joins an execution still running here.
   */
  async execute(
    key: ReceiptKey,
    digest: string,
    extra: { endpointId: string | null; deadlineAt: Date | null; secret?: boolean },
    run: () => Promise<ExecutionResult>,
    onAccepted: () => void,
  ): Promise<ExecuteAnswer> {
    const k = keyString(key);
    const live = this.inflight.get(k);
    if (live) {
      if (live.digest !== digest) return { kind: 'mismatch' };
      if (live.accepted) onAccepted();
      else live.listeners.push(onAccepted);
      const answer = await live.answer;
      return answer.kind === 'outcome' ? { ...answer, replayed: true } : answer;
    }
    let settle!: (answer: ExecuteAnswer) => void;
    const entry: Inflight = {
      digest,
      accepted: false,
      listeners: [onAccepted],
      answer: new Promise<ExecuteAnswer>((resolve) => {
        settle = resolve;
      }),
    };
    this.inflight.set(k, entry);
    try {
      const answer = await this.#run(key, digest, extra, run);
      settle(answer);
      return answer;
    } catch (err) {
      settle({
        kind: 'outcome',
        state: 'not_executed',
        outcome: {
          kind: 'error',
          code: 'internal',
          message: 'Something went wrong on the appliance.',
          retryable: true,
        },
        replayed: false,
      });
      throw err;
    } finally {
      if (this.inflight.get(k) === entry) this.inflight.delete(k);
    }
  }

  async #run(
    key: ReceiptKey,
    digest: string,
    extra: { endpointId: string | null; deadlineAt: Date | null; secret?: boolean },
    run: () => Promise<ExecutionResult>,
  ): Promise<ExecuteAnswer> {
    const begun = await this.#begin(key, digest, extra);
    if (begun.kind === 'mismatch') return begun;
    if (begun.kind === 'replay')
      return { kind: 'outcome', state: begun.state, outcome: begun.outcome, replayed: true };
    const result = await run();
    const stored = storedOutcome(result.outcome, extra.secret === true);
    if (result.state === 'not_executed') await this.#notExecuted(key, stored);
    else await this.#finish(key, result.state, stored);
    return { kind: 'outcome', state: result.state, outcome: result.outcome, replayed: false };
  }

  /**
   * Inside the command's transaction: `received` → `accepted` (later transactions find it `accepted`). A receipt
   * another process already settled (it took this command for dead, CS-13) refuses: the transaction rolls back rather
   * than commit behind an answer already given.
   */
  async markAccepted(tx: Tx, key: ReceiptKey): Promise<void> {
    const rows = await tx
      .update(commandReceipts)
      .set({
        state: 'accepted',
        acceptedAt: sql`coalesce(${commandReceipts.acceptedAt}, ${this.clock().toISOString()}::timestamptz)`,
      })
      .where(and(whereKey(key), inArray(commandReceipts.state, ['received', 'accepted'])))
      .returning({ state: commandReceipts.state });
    if (rows.length === 0) throw new ReceiptSettled();
  }

  /** Intent committed, but a required continuation has not yet supplied the command's result. */
  async markPendingResult(tx: Tx, key: ReceiptKey): Promise<void> {
    await tx
      .update(commandReceipts)
      .set({ outcome: { kind: 'pending_result' } })
      .where(whereKey(key));
  }

  /**
   * Before an external effect of a command that hasn't committed (CS-01), on its own (not in the command's
   * transaction, which may still roll back): the receipt remembers that its command may have acted.
   */
  async markEffect(key: ReceiptKey, label: string): Promise<void> {
    const mark: EffectMark = { kind: 'effect', label, at: this.clock().toISOString() };
    await this.db
      .update(commandReceipts)
      .set({ outcome: mark as unknown as Record<string, unknown> })
      .where(and(whereKey(key), eq(commandReceipts.state, 'received')));
  }

  /** After the command's first transaction committed: tell whoever waits for `accepted`. */
  accepted(key: ReceiptKey): void {
    const entry = this.inflight.get(keyString(key));
    if (!entry || entry.accepted) return;
    entry.accepted = true;
    for (const listener of entry.listeners.splice(0)) {
      try {
        listener();
      } catch {
        // a closed session
      }
    }
  }

  async #begin(
    key: ReceiptKey,
    digest: string,
    extra: { endpointId: string | null; deadlineAt: Date | null },
  ): Promise<BeginResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.db
        .insert(commandReceipts)
        .values({
          ...key,
          digest,
          state: 'received',
          endpointId: extra.endpointId,
          deadlineAt: extra.deadlineAt,
          createdAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning({ state: commandReceipts.state });
      if (inserted.length) return { kind: 'new' };
      const [row] = await this.db.select().from(commandReceipts).where(whereKey(key));
      if (!row) continue;
      if (row.digest !== digest) return { kind: 'mismatch' };
      if (row.state === 'completed' || row.state === 'rejected')
        return { kind: 'replay', state: row.state, outcome: row.outcome as unknown as CommandOutcome };
      // No execution of it in this process (`execute` joins a live one first), so the process that ran it died.
      // After its commit: done, the result is gone (CS-06). After an external effect but before any commit: it may
      // have acted (CS-02). Both finish here, so every later retry and `status` answer the same.
      if (row.state === 'accepted') {
        const pending = isPendingResult(row.outcome);
        const state = pending ? 'rejected' : 'completed';
        const outcome = pending ? unknownOutcome() : REDACTED_COMPLETION;
        if (await this.#settleDead(key, 'accepted', state, outcome))
          return { kind: 'replay', state, outcome };
        continue;
      }
      if (row.state === 'received' && isEffectMark(row.outcome)) {
        const unknown = unknownOutcome();
        if (await this.#settleDead(key, 'received', 'rejected', unknown))
          return { kind: 'replay', state: 'rejected', outcome: unknown };
        continue;
      }
      // `received` with no execution in this process (it died before any commit), or `not_executed`: run again.
      const reset = await this.db
        .update(commandReceipts)
        .set({
          state: 'received',
          outcome: null,
          endpointId: extra.endpointId,
          deadlineAt: extra.deadlineAt,
          finishedAt: null,
        })
        .where(
          and(
            whereKey(key),
            inArray(commandReceipts.state, ['received', 'not_executed']),
            // Never over an effect mark another process wrote meanwhile (CS-13): that one may have acted.
            sql`(${commandReceipts.outcome} is null or ${commandReceipts.outcome}->>'kind' <> 'effect')`,
          ),
        )
        .returning({ state: commandReceipts.state });
      if (reset.length) return { kind: 'new' };
    }
    throw new Error('command receipt kept changing');
  }

  /** Finishes a receipt a dead process left in `from` (only if it still is). */
  async #settleDead(
    key: ReceiptKey,
    from: 'accepted' | 'received',
    state: 'completed' | 'rejected',
    outcome: CommandOutcome,
  ): Promise<boolean> {
    const rows = await this.db
      .update(commandReceipts)
      .set({
        state,
        outcome: outcome as unknown as Record<string, unknown>,
        finishedAt: this.clock(),
        acceptedAt: sql`coalesce(${commandReceipts.acceptedAt}, now())`,
      })
      .where(and(whereKey(key), eq(commandReceipts.state, from)))
      .returning({ state: commandReceipts.state });
    return rows.length > 0;
  }

  /** Stores the outcome — never over a receipt another process settled meanwhile (CS-13). */
  async #finish(key: ReceiptKey, state: 'completed' | 'rejected', outcome: CommandOutcome): Promise<void> {
    await this.db
      .update(commandReceipts)
      .set({
        state,
        outcome: outcome as unknown as Record<string, unknown>,
        finishedAt: this.clock(),
        acceptedAt: sql`coalesce(${commandReceipts.acceptedAt}, now())`,
      })
      .where(and(whereKey(key), inArray(commandReceipts.state, ['received', 'accepted'])));
  }

  async #notExecuted(key: ReceiptKey, outcome: CommandOutcome): Promise<void> {
    await this.db
      .update(commandReceipts)
      .set({
        state: 'not_executed',
        outcome: outcome as unknown as Record<string, unknown>,
        finishedAt: this.clock(),
      })
      .where(and(whereKey(key), eq(commandReceipts.state, 'received')));
  }

  /**
   * `status{id}`: the receipt's state as the protocol names it, with the digest it is bound to and the outcome
   * when finished. The protocol's `status` names no op: the newest receipt of that id among the session's
   * principals answers (`principalIds`: its own, and its pre-enrollment `peer:<peerId>`, CS-04).
   */
  async status(
    principalIds: readonly string[],
    requestId: string,
  ): Promise<{ state: PublicReceiptState; digest?: string; outcome?: CommandOutcome }> {
    const [row] = await this.db
      .select()
      .from(commandReceipts)
      .where(
        and(
          inArray(commandReceipts.principalId, [...principalIds]),
          eq(commandReceipts.requestId, requestId),
        ),
      )
      .orderBy(desc(commandReceipts.createdAt))
      .limit(1);
    const live = row
      ? this.inflight.has(keyString({ principalId: row.principalId, op: row.op, requestId }))
      : false;
    const answer = publicState(row?.state ?? null, row?.outcome ?? undefined, live);
    return row && answer.state !== 'not_found' ? { ...answer, digest: row.digest } : answer;
  }

  /** Removes finished receipts older than the retention window. `accepted` ones stay (their result is unknown). */
  async sweep(retentionMs: number): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - retentionMs);
    const rows = await this.db
      .delete(commandReceipts)
      .where(
        and(
          inArray(commandReceipts.state, ['completed', 'rejected', 'not_executed']),
          lt(commandReceipts.finishedAt, cutoff),
        ),
      )
      .returning({ op: commandReceipts.op });
    return rows.length;
  }
}

/**
 * Pure mapping of a stored receipt to the protocol's `status` answer. `live`: its command runs in this process. One
 * that doesn't died with its process: after its commit it answers `completed` with the result redacted (CS-06); after
 * an external effect before any commit, an unknown outcome (CS-02); before either, `not_found`.
 */
export function publicState(
  state: ReceiptState | null,
  stored: unknown,
  live: boolean,
): { state: PublicReceiptState; outcome?: CommandOutcome } {
  const outcome =
    stored && !isEffectMark(stored) && !isPendingResult(stored) ? (stored as CommandOutcome) : undefined;
  switch (state) {
    case null:
    case 'not_executed':
      return { state: 'not_found' };
    case 'received':
      if (live) return { state: 'executing' };
      return isEffectMark(stored) ? { state: 'rejected', outcome: unknownOutcome() } : { state: 'not_found' };
    case 'accepted':
      return live
        ? { state: 'accepted' }
        : isPendingResult(stored)
          ? { state: 'rejected', outcome: unknownOutcome() }
          : { state: 'completed', outcome: REDACTED_COMPLETION };
    case 'completed':
      return outcome ? { state: 'completed', outcome } : { state: 'completed' };
    case 'rejected':
      return outcome ? { state: 'rejected', outcome } : { state: 'rejected' };
  }
}
