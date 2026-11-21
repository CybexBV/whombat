/**
 * The durable-command scope (docs/decisions/managed-runtime.md MR-06, MA-09). A session request that is a
 * command runs its handler inside `runInCommandScope`; every commit-pipeline transaction started in it calls the
 * scope right before it commits, in the same transaction:
 *
 * - until the command is accepted, a cancelled request or a passed deadline throws there, so the transaction
 *   rolls back and nothing was executed;
 * - the first transaction marks the command's receipt `accepted` (same transaction as the command's writes),
 *   and after it commits the scope tells the session (`accepted` is sent only after commit).
 *
 * Once the request has finished the scope is inert: work it started in the background (post-commit hooks,
 * timers) commits normally.
 *
 * An effect outside the database before the first commit (GitHub, git on disk, a provider CLI through the runner, a
 * Google revocation) runs through `externalEffect` (docs/decisions/command-safety.md CS-01): from then on the command
 * is past its point of no return — neither a cancel nor the deadline rolls back the commit that records the effect —
 * and its receipt remembers that it may have acted, so a process that dies before the commit leaves an unknown
 * outcome, never “not executed”.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tx } from '../db/client';

/**
 * A command stopped before its commit (cancelled, or past its deadline). Thrown from `beforeCommit` and from
 * `externalEffect` before the effect starts: code that wraps errors lets it through as it is.
 */
export class CommandStopped extends Error {}

/** How an external effect ended: it happened (or may have), it certainly didn't, or the caller reverted it. */
export type EffectEnd = 'acted' | 'refused' | 'undone';

export interface CommandScope {
  /** False once the request finished (its background work must not consult it). */
  readonly active: boolean;
  /** True once a transaction of this command committed. */
  readonly accepted: boolean;
  /** The session op this command runs for (`externalEffect` observers). */
  readonly op?: string;
  /** Before commit, inside the transaction: throws to roll back (cancelled / deadline), else marks the receipt. */
  beforeCommit(tx: Tx): Promise<void>;
  /** After a transaction of this command committed. */
  afterCommit(): void;
  /**
   * Before each external effect of the command (`externalEffect`). A non-idempotent one before the first commit
   * (CS-01) pins the command past cancel and deadline and marks its receipt (outside the command's transaction) as
   * possibly acted; one after the commit tells the command that a later failure may be that effect's (CS-05).
   */
  beforeEffect?(label: string, effect: { idempotent: boolean }): Promise<void>;
  /** How that effect ended. */
  afterEffect?(label: string, end: EffectEnd): void;
  /** A command's transaction begins (`Pipeline.commit`): the command isn't reading its result back (CS-12). */
  beforeWrite?(): void;
  /**
   * The command's result is decided — a command committed `ok`, or a handler says so (`readingBack`): until the next
   * write or external effect, what follows only reads it back, and an `internal`/`not_found` failure there means the
   * read-back failed, not the command (CS-12).
   */
  resultDecided?(): void;
  /** The first commit saves intent; a required continuation still has to finish before success is known. */
  deferResult?(): void;
}

const storage = new AsyncLocalStorage<CommandScope>();

export function runInCommandScope<T>(scope: CommandScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** The active scope of the current async context, if any. */
export function currentCommandScope(): CommandScope | null {
  const scope = storage.getStore();
  return scope?.active ? scope : null;
}

/**
 * Runs `fn` outside any command scope: background work a request merely noticed (the licence's state transition,
 * MR-57) commits on its own and never becomes part of that request's receipt.
 */
export function outsideCommandScope<T>(fn: () => T): T {
  return storage.exit(fn);
}

export interface ExternalEffectOptions {
  /**
   * Repeating it is harmless (an idempotent cancel or sign-out, a read-only probe, content-addressed files): observed,
   * but it neither pins the command nor marks its receipt.
   */
  idempotent?: boolean;
  /** A failure that proves it didn't act (a definite refusal by the other side); any other failure may have acted. */
  refused?: (err: unknown) => boolean;
}

/** One external effect, as `observeExternalEffects` reports it (CS-08). */
export interface ObservedEffect {
  label: string;
  /** The session op whose command ran it; null outside a command. */
  op: string | null;
  /** Inside a command that had not committed yet. */
  beforeCommit: boolean;
  idempotent: boolean;
}

const observers = new Set<(effect: ObservedEffect) => void>();

/** Reports every `externalEffect` as it starts (tests: the runtime's check of `OPERATION_SAFETY`, CS-08). */
export function observeExternalEffects(listener: (effect: ObservedEffect) => void): () => void {
  observers.add(listener);
  return () => observers.delete(listener);
}

/**
 * Runs an effect outside the database (CS-01). Inside a command it is reported to the command first — before its
 * first commit a non-idempotent one pins it past cancel and deadline and marks its receipt — and its end after
 * (`refused` when it failed with an error `options.refused` recognises, else `acted`). Outside a command it just runs.
 */
export async function externalEffect<T>(
  label: string,
  fn: () => Promise<T>,
  options: ExternalEffectOptions = {},
): Promise<T> {
  const scope = currentCommandScope();
  const idempotent = options.idempotent === true;
  for (const observer of observers)
    observer({ label, op: scope?.op ?? null, beforeCommit: scope !== null && !scope.accepted, idempotent });
  if (!scope?.beforeEffect) return fn();
  await scope.beforeEffect(label, { idempotent });
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    scope.afterEffect?.(label, options.refused?.(err) ? 'refused' : 'acted');
    throw err;
  }
  scope.afterEffect?.(label, 'acted');
  return value;
}

/**
 * A handler whose last write wasn't a pipeline command (a session-native op committing with `transactAccount`) says its
 * result is decided and it only reads it back from here (CS-12).
 */
export function readingBack(): void {
  currentCommandScope()?.resultDecided?.();
}

/** The caller reverted an effect of its command that couldn't commit (the origin `repos.create` made, CS-03). */
export function undoneEffect(label: string): void {
  currentCommandScope()?.afterEffect?.(label, 'undone');
}
