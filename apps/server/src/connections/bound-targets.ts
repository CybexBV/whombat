/**
 * Which connections the work under way signs as, and only where and as whom it was checked on (`callTarget`): a
 * connection call binds its own connection and every other one it reaches (a Servers backup place on a TrueNAS), a
 * page's action and its Put it back the connection they run on. Every credential opened for a bound connection is
 * checked once it is in hand and before anything is signed with it, on the row it is opened from and on the connection
 * as it is stored then (`credentials.ts`, the NAS drivers' own sign-ins), since a refresh or a new sign-in reads the
 * connection again: a token, account or address replaced since sends nothing (`ConnectionChangedError`).
 *
 * A refusal is remembered on the work, so its caller hears that the connection changed even where a transport turned
 * the refusal into words of its own (“Couldn’t reach it”).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
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
  for (let b: Binding | null = binding; b; b = b.parent) b.refused ??= row.id;
  throw new ConnectionChangedError(row.id);
}
