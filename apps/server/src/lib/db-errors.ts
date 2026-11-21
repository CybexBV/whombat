/**
 * What may be said about a failed database statement. A statement that fails rejects with drizzle's
 * `DrizzleQueryError`, whose message is the statement and its values, and whose `cause` is the driver's error, whose
 * own message and `detail` can quote a value too (“Key (email)=(…) already exists.”). A person's name or email in a
 * failed insert must never reach a log: the log gets the error's class, the Postgres error code and the names of the
 * constraint and table it was about, which are the schema's own words.
 */

/** How far a `cause` chain is followed. */
const CAUSE_DEPTH = 5;

function* causes(err: unknown): Generator<Record<string, unknown>> {
  for (let e: unknown = err, depth = 0; e && depth < CAUSE_DEPTH; depth++) {
    if (typeof e !== 'object') return;
    yield e as Record<string, unknown>;
    e = (e as { cause?: unknown }).cause;
  }
}

/**
 * The Postgres error code (SQLSTATE) behind an error, or null. A statement inside a transaction rejects with drizzle's
 * `DrizzleQueryError`, whose `cause` is the driver's error: the chain is walked (CS-09), as `isReadOnlyViolation` does
 * for REST.
 */
export function sqlState(err: unknown): string | null {
  for (const e of causes(err)) {
    const code = e.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Whether a failed database statement is behind this error: a query with its values, or a driver's error code. */
export function isDatabaseError(err: unknown): boolean {
  if (sqlState(err) !== null) return true;
  for (const e of causes(err)) if ('query' in e && 'params' in e) return true;
  return false;
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * An error as a log line may carry it. A failed database statement: its class, its SQLSTATE and the constraint and
 * table the driver named, never the statement, its values, the driver's message or a stack that repeats them. Anything
 * else: its text and stack, as before.
 */
export function errorForLog(err: unknown): Record<string, unknown> {
  if (!isDatabaseError(err)) return { err: String(err), stack: (err as Error | undefined)?.stack };
  const out: Record<string, unknown> = {
    err: (err as { constructor?: { name?: string } } | null)?.constructor?.name || 'Error',
    sqlState: sqlState(err),
  };
  for (const e of causes(err)) {
    // postgres.js names them `constraint_name` and `table_name`; node-postgres `constraint` and `table`.
    const constraint = e.constraint_name ?? e.constraint;
    const table = e.table_name ?? e.table;
    if (typeof constraint === 'string' && SCHEMA_NAME.test(constraint)) out.constraint ??= constraint;
    if (typeof table === 'string' && SCHEMA_NAME.test(table)) out.table ??= table;
  }
  return out;
}

/**
 * A failed database statement with its statement and values taken off: what may travel up and be logged whole. It
 * keeps the Postgres error code where `sqlState` looks for it, and the constraint and table the driver named.
 */
export class DatabaseFailure extends Error {
  override name = 'DatabaseFailure';
  readonly code: string | null;
  readonly constraint?: string;
  readonly table?: string;

  constructor(err: unknown) {
    const about = errorForLog(err);
    super(`A database statement failed (${about.sqlState ?? 'no error code'}).`);
    this.code = (about.sqlState as string | null) ?? null;
    if (typeof about.constraint === 'string') this.constraint = about.constraint;
    if (typeof about.table === 'string') this.table = about.table;
  }
}

/** The error to pass on from a write that carried a person's details: a database failure loses its values here. */
export function withoutValues(err: unknown): unknown {
  return isDatabaseError(err) && !(err instanceof DatabaseFailure) ? new DatabaseFailure(err) : err;
}
