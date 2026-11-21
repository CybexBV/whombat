/**
 * What a long-lived connection (a collab document an agent's turn opened) was opened with, and whether that still
 * holds: the collaboration service re-checks every live connection periodically, so a dispatch that ended cuts it off.
 */
import { inArray } from 'drizzle-orm';
import { dispatches } from '../db/schema/index';
import type { Services } from '../services';

export interface ConnectionCredential {
  /** The dispatch an agent's connection works for. */
  dispatchId: string | null;
}

const LIVE_DISPATCH = ['queued', 'claimed', 'running'] as const;

export interface DeadCredentials {
  dispatches: ReadonlySet<string>;
}

/** The dispatch ids among `list` that no longer authorize anything. */
export async function deadCredentials(
  services: Services,
  list: readonly ConnectionCredential[],
): Promise<DeadCredentials> {
  const dispatchIds = [...new Set(list.map((c) => c.dispatchId).filter((id): id is string => id !== null))];
  if (!dispatchIds.length) return { dispatches: new Set() };
  const live = await services.db
    .select({ id: dispatches.id, state: dispatches.state })
    .from(dispatches)
    .where(inArray(dispatches.id, dispatchIds));
  const alive = new Set(
    live.filter((r) => (LIVE_DISPATCH as readonly string[]).includes(r.state)).map((r) => r.id),
  );
  return { dispatches: new Set(dispatchIds.filter((id) => !alive.has(id))) };
}

export function isDead(credential: ConnectionCredential, dead: DeadCredentials): boolean {
  return credential.dispatchId !== null && dead.dispatches.has(credential.dispatchId);
}
