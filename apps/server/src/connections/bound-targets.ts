/**
 * Which connections the work under way signs as, and only where and as whom it was checked on (`callTarget`): a
 * connection call binds its own connection and every other one it reaches (a Servers backup place on a TrueNAS), a
 * page's action and its Put it back the connection they run on. A bound connection is checked before anything goes
 * out as it, sign-ins included: before its credential is opened and once it is in hand (`credentials.ts`), on the row a
 * refresh, a token exchange or a session sign-in reads again before it asks the service (`refresh.ts`,
 * `client-credentials.ts`, `session.ts`), before a datagram or a line (`http.ts`) and in the NAS drivers' own
 * sign-ins. A token, account or address replaced since sends nothing, not even a sign-in, and writes nothing to the
 * connection (`ConnectionChangedError`).
 *
 * A refusal is remembered on the work, so its caller hears that the connection changed even where a transport turned
 * the refusal into words of its own (“Couldn’t reach it”).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { type CallTargetRow, ConnectionChangedError, callTarget } from './call-target';

/** A target no connection has: a connection bound to it signs nothing (one that wasn't there when it was checked). */
export const NOWHERE = 'none';

interface Binding {
  readonly targets: ReadonlyMap<string, string>;
  readonly parent: Binding | null;
  /** The first connection refused for having changed, if any. */
  refused: string | null;
}

const bindings = new AsyncLocalStorage<Binding>();

/** Where the work under way may sign as `connectionId` (its `callTarget`), or undefined when it isn't bound. */
export function boundTarget(connectionId: string): string | undefined {
  return bindings.getStore()?.targets.get(connectionId);
}

/**
 * Runs `work` signing as each connection in `targets` only while it is where, and as whom, its target says. Work that
 * is already bound keeps its own targets (a page action a yes was bound to). Resolves to what `work` did and which
 * connection, if any, was refused meanwhile; when `work` fails after a refusal, it fails with `ConnectionChangedError`
 * naming that connection, whatever the transport made of it.
 */
export async function signingOnlyAs<T>(
  targets: Readonly<Record<string, string>>,
  work: () => Promise<T>,
): Promise<{ value: T; refused: string | null }> {
  const parent = bindings.getStore() ?? null;
  const merged = new Map(parent?.targets ?? []);
  for (const [id, target] of Object.entries(targets)) if (!merged.has(id)) merged.set(id, target);
  const binding: Binding = { targets: merged, parent, refused: null };
  try {
    const value = await bindings.run(binding, work);
    return { value, refused: binding.refused };
  } catch (err) {
    if (binding.refused && !(err instanceof ConnectionChangedError))
      throw new ConnectionChangedError(binding.refused);
    throw err;
  }
}

/** Remembers on the work under way, and every work it runs in, that `connectionId` was refused; then throws. */
function refuse(binding: Binding, connectionId: string): never {
  for (let b: Binding | null = binding; b; b = b.parent) b.refused ??= connectionId;
  throw new ConnectionChangedError(connectionId);
}

/**
 * Throws `ConnectionChangedError` when the work under way is bound to another target for `row`'s connection than the
 * one `row`, and the connection as it is stored now, have. Nothing to check when it isn't bound.
 */
export async function keepBoundTarget(services: Pick<Services, 'db'>, row: CallTargetRow): Promise<void> {
  const binding = bindings.getStore();
  const target = binding?.targets.get(row.id);
  if (!binding || target === undefined) return;
  if (callTarget(row) === target) {
    const [now] = await services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, row.id));
    if (now && callTarget(now) === target) return;
  }
  refuse(binding, row.id);
}

/**
 * Throws `ConnectionChangedError` when the work under way is bound to another target for `row`'s connection than the
 * one `row` has: for a row just read again, before a sign-in or a refresh asks the service anything with it.
 */
export function keepBoundRow(row: CallTargetRow): void {
  const binding = bindings.getStore();
  const target = binding?.targets.get(row.id);
  if (binding && target !== undefined && callTarget(row) !== target) refuse(binding, row.id);
}

/** One sign-in or refresh under way for a connection, and the binding it was started under. */
export interface SignInFlight<T> {
  readonly promise: Promise<T>;
  readonly target: string | undefined;
}

/**
 * One sign-in (a refresh, a token exchange, a session) at a time per connection, shared by every caller bound alike:
 * work joins one started under the same binding for that connection (or none), and otherwise waits for it to end and
 * starts its own, so one caller's refusal never becomes another's and no two run at once.
 */
export async function sharedSignIn<T>(
  flights: Map<string, SignInFlight<T>>,
  connectionId: string,
  start: () => Promise<T>,
): Promise<T> {
  const target = boundTarget(connectionId);
  for (let flight = flights.get(connectionId); flight; flight = flights.get(connectionId)) {
    if (flight.target === target) return flight.promise;
    await flight.promise.catch(() => undefined);
  }
  const promise: Promise<T> = start().finally(() => {
    if (flights.get(connectionId)?.promise === promise) flights.delete(connectionId);
  });
  flights.set(connectionId, { promise, target });
  return promise;
}

/**
 * The name of the first connection in `targets` that goes elsewhere, or as someone else, now than its target says;
 * null when none does (one that is gone isn't: what would sign as it refuses by itself).
 */
export async function changedSince(
  services: Pick<Services, 'db'>,
  targets: Readonly<Record<string, string>>,
): Promise<string | null> {
  const ids = Object.keys(targets);
  if (!ids.length) return null;
  const rows = await services.db.select().from(catalogConnections).where(inArray(catalogConnections.id, ids));
  return rows.find((r) => callTarget(r) !== targets[r.id])?.label ?? null;
}

/**
 * The first connection in `targets` stored now with another target than its own, read in the transaction `db` that
 * saves a card or a call bound to them and held there until it ends (FOR SHARE): what a yes is bound to is what the
 * card was made from, and a connection replaced meanwhile saves no card. Null when none differs (one that is gone
 * doesn't: what would sign as it refuses by itself).
 */
export async function heldChanged(
  db: Db,
  targets: Readonly<Record<string, string>>,
): Promise<{ id: string; label: string } | null> {
  const ids = Object.keys(targets);
  if (!ids.length) return null;
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(inArray(catalogConnections.id, ids))
    .for('share');
  const changed = rows.find((r) => callTarget(r) !== targets[r.id]);
  return changed ? { id: changed.id, label: changed.label } : null;
}
