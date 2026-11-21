/**
 * The advisory lock that makes one engine active (bp-automations BP-C05). It lives on a session reserved for it, so it
 * dies with that session: the engine checks it (`lockHeld`) and steps down when it's gone (command-safety CS-11).
 */
import type { Sql } from '../../db/client';

/** The advisory lock the active engine holds ("WHAU"). */
export const ENGINE_LOCK = 0x57484155;

/** The session reserved for the lock. */
export type LockSession = Awaited<ReturnType<Sql['reserve']>>;

/** A session of its own holding the lock, or null when another process holds it. */
export async function takeLock(sql: Sql): Promise<LockSession | null> {
  const reserved = await sql.reserve();
  const [row] = await reserved<{ ok: boolean }[]>`select pg_try_advisory_lock(${ENGINE_LOCK}) as ok`;
  if (row?.ok) return reserved;
  reserved.release();
  return null;
}

/** Whether the reserved session holds the engine's advisory lock; rejects when the session is gone (PGG-03). */
export async function lockHeld(reserved: LockSession): Promise<boolean> {
  const [row] = await reserved<{ held: boolean }[]>`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid() and objid = ${ENGINE_LOCK} and granted
    ) as held`;
  return row?.held === true;
}

/** Gives the lock back (closing); the caller releases the session. */
export async function unlock(reserved: LockSession): Promise<void> {
  try {
    await reserved`select pg_advisory_unlock(${ENGINE_LOCK})`;
  } catch {
    /* the connection is going away anyway */
  }
}
