/**
 * Settling T3 Code threads (docs/decisions/t3code.md). Settling ends a thread's session in T3 Code, which stops any
 * command it left running in the background. A thread a step, a council or a checklist started is only marked here, and
 * the watcher settles it once it has been quiet (`watch.ts` `#settleQuiet`). A thread handed over for the person is
 * settled by the agent once the job is finished, and `settleRefusal` keeps it from settling one still at work.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { t3Watches } from '../db/schema/index';
import type { Services } from '../services';
import { AT_WORK, callT3, T3Failure } from '../things/kinds/business/t3code';
import { stateArgs, threadStateOf, waitOf, watchedPullRequestsOf } from './threads';

/**
 * How long a thread whose work completed stays quiet (no run, nothing it waits for) before Whombat settles it in T3 Code:
 * longer than a command it may have left running in the background (a test suite, a build, a deploy), which settling
 * would stop.
 */
export const T3_SETTLE_QUIET_MS = 2 * 3_600_000;

/** How long the check waits for a thread's delegated work: only to ask whether it is still running. */
const PROBE_MS = 1000;

/**
 * Why the agent's `t3_thread_organize` settle of a thread must wait, in words it acts on; null when it may go ahead.
 * Settling a thread still at work would stop that work: a run (or a question it waits on), work it delegated, a command
 * it waits for, a pull request T3 Code watches for it. A thread T3 Code can't show is left to T3 Code's own answer.
 */
export async function settleRefusal(
  services: Services,
  connection: CatalogConnectionRow,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (args.action !== 'settle' || typeof args.threadId !== 'string') return null;
  const threadId = args.threadId;
  const ask = (tool: string, a: Record<string, unknown>) =>
    callT3(services, connection, tool, a).catch((err: unknown) => {
      if (err instanceof T3Failure) return null;
      throw err;
    });
  const state = threadStateOf(await ask('t3_thread_read', stateArgs(threadId, 0)));
  if (!state) return null;
  const atWork = 'That thread is still at work in T3 Code. Settle it once its job is finished.';
  if (state.activeRunId !== null || AT_WORK.includes(state.status)) return atWork;
  const wait = await ask('t3_thread_wait', {
    threadId,
    timeoutMs: PROBE_MS,
    untilDelegatedWorkSettled: true,
  });
  if (wait && waitOf(wait).timedOut) return atWork;
  const watched = watchedPullRequestsOf(await ask('list_thread_pull_requests', { threadId }));
  if (watched.length)
    return 'T3 Code still watches a pull request for that thread. Settle it once the pull request is merged or closed.';
  return null;
}

/**
 * Marks a watched thread to be settled once it has been quiet since `now` (`progress.settle`). Whatever else the watch's
 * progress holds stays. False when Whombat doesn't watch the thread.
 */
export async function settleLater(
  db: Db | Tx,
  connectionId: string,
  threadId: string,
  now: Date,
): Promise<boolean> {
  const at = now.toISOString();
  const rows = await db
    .update(t3Watches)
    .set({
      progress: sql`jsonb_set(coalesce(${t3Watches.progress}, '{}'::jsonb), '{settle}', ${JSON.stringify({ from: at, at })}::jsonb)`,
    })
    .where(and(eq(t3Watches.connectionId, connectionId), eq(t3Watches.threadId, threadId)))
    .returning({ threadId: t3Watches.threadId });
  return rows.length > 0;
}
