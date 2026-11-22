/**
 * Hermes sessions per Chat thread (hermes-engine.md HE-18, HE-40, HE-S116…HE-S119). Hermes keeps the conversation; the
 * server only remembers which session a turn ran in (`dispatches.provider_session_id`, `hermes:<id>`), and from that:
 *
 * - which session a chat turn resumes: the latest of an earlier turn in the same thread (or conversation) for the same
 *   person — the session lives in that person's Hermes profile — that ended (done or stopped), unless this turn is
 *   served a tool that turn wasn't (`dispatches.served_tools`): Hermes keeps the tools a session began with, so only a
 *   fresh session sees a new one;
 * - what a resumed session is sent: only the messages since its last turn (`sessionSince`);
 * - which sessions to forget with an edited or deleted message, a deleted thread or Clear chats (`dropSessions`);
 * - a resumed turn's prompt cache result (PE-12), from the session's last turn's usage.
 *
 * Our own session store (`agent_sessions`, `dispatch_memory`: parts, fingerprints, idle and context limits, knowledge
 * checks) is gone; its tables stay unused until step 4 (HE-45).
 */
import { createHash } from 'node:crypto';
import { promptCacheTtlMs } from '@whombat/agent-runtime/cache';
import { conversationKeyFor, type DispatchSession, type HermesHome, type SpendUsage } from '@whombat/core';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, principals } from '../db/schema/index';
import { type CacheJudgement, judgeCache, type StoredUsage } from '../domain/cache-result';
import { homeOf, kickHermesHousekeeping, recordForgottenSessions } from '../hermes-home/housekeeping';
import type { DispatchRow } from './context';
import { turnProviderSql } from './turn-runtime';

/** How Whombat stores a Hermes session id (the runner's `HERMES_SESSION_PREFIX`). */
export const HERMES_SESSION = 'hermes:';

type Queryable = Db | Tx;

/** Whether a dispatch takes part in thread sessions: chat replies (runs and search answers keep their own). */
export function usesSessions(
  d: Pick<DispatchRow, 'mode' | 'runId' | 'search'> & { trigger?: string },
): boolean {
  // A Feedback assessment never resumes or records a session, nor does an automation's step: each is a fresh turn of
  // the agent.
  return (
    d.mode === 'reply' && !d.runId && !d.search && d.trigger !== 'feedback' && d.trigger !== 'automation'
  );
}

/** The same thread (or the conversation's top level) and the same person's profile. */
function sameScope(
  d: Pick<DispatchRow, 'agentId' | 'conversationId' | 'threadRootId' | 'onBehalfOfAccountId'>,
) {
  return and(
    eq(dispatches.agentId, d.agentId),
    eq(dispatches.conversationId, d.conversationId),
    d.threadRootId ? eq(dispatches.threadRootId, d.threadRootId) : isNull(dispatches.threadRootId),
    d.onBehalfOfAccountId
      ? eq(dispatches.onBehalfOfAccountId, d.onBehalfOfAccountId)
      : isNull(dispatches.onBehalfOfAccountId),
  );
}

/** Turns whose session counts: chat replies that ended with a Hermes session. */
const sessionTurn = and(
  eq(dispatches.mode, 'reply'),
  isNull(dispatches.runId),
  isNull(dispatches.search),
  sql`${dispatches.trigger} not in ('feedback', 'automation')`,
  like(dispatches.providerSessionId, `${HERMES_SESSION}%`),
);

/**
 * The session a chat turn resumes (null: a fresh one): the latest session of an earlier turn here, for the same person,
 * that ended done or stopped. A failed turn's session isn't picked up again (it may be what failed). Nor is one whose
 * last turn wasn't served every tool this turn is (`served`, the names; null when unknown): Hermes freezes a session's tools when it begins
 * and drops those no longer served, but never adds one, so the model wouldn't see it. The fresh session gets the
 * conversation's window. A turn from before Whombat recorded its tools counts as one that lacked them.
 */
export async function chooseSession(
  tx: Queryable,
  d: DispatchRow,
  served: readonly string[] | null,
): Promise<string | null> {
  if (!usesSessions(d)) return null;
  const [last] = await tx
    .select({ session: dispatches.providerSessionId, servedTools: dispatches.servedTools })
    .from(dispatches)
    .where(
      and(
        sameScope(d),
        sessionTurn,
        ne(dispatches.id, d.id),
        inArray(dispatches.state, ['done', 'cancelled']),
        isNotNull(dispatches.finishedAt),
      ),
    )
    .orderBy(desc(dispatches.finishedAt))
    .limit(1);
  if (!last?.session) return null;
  return !served || servesNoMore(last.servedTools, served) ? last.session : null;
}

/** Whether `served` holds no tool `before` didn't (null `before`: nobody recorded them). */
export function servesNoMore(before: readonly string[] | null, served: readonly string[]): boolean {
  if (!before) return false;
  const had = new Set(before);
  return served.every((name) => had.has(name));
}

/** The last turn a session ran before this one (another dispatch), or null when the session is this dispatch's own. */
async function lastTurnOf(db: Queryable, row: DispatchRow) {
  if (!row.providerSessionId) return null;
  const [last] = await db
    .select({
      id: dispatches.id,
      trigger: dispatches.trigger,
      claimedAt: dispatches.claimedAt,
      finishedAt: dispatches.finishedAt,
      usage: dispatches.usage,
      provider: turnProviderSql,
    })
    .from(dispatches)
    .innerJoin(principals, eq(principals.id, dispatches.agentId))
    .where(
      and(
        eq(dispatches.providerSessionId, row.providerSessionId),
        eq(dispatches.agentId, row.agentId),
        ne(dispatches.id, row.id),
        isNotNull(dispatches.finishedAt),
      ),
    )
    .orderBy(desc(dispatches.finishedAt))
    .limit(1);
  return last ?? null;
}

/**
 * What a resumed session has seen already (HE-40): the messages up to its last turn's start, and the agent's own
 * messages until that turn ended (it wrote them there). A retry resuming the session its own first attempt began has
 * seen everything up to the turn's request. Null for a fresh session: it gets the window.
 */
export async function sessionSince(
  db: Queryable,
  row: DispatchRow,
  triggerAt: Date | null,
): Promise<{ before: Date; ownUntil: Date | null } | null> {
  if (!row.providerSessionId?.startsWith(HERMES_SESSION)) return null;
  const last = await lastTurnOf(db, row);
  if (last?.claimedAt) return { before: last.claimedAt, ownUntil: last.finishedAt };
  return { before: triggerAt ?? row.createdAt, ownUntil: null };
}

/** A folder name for the session's turns without a working directory: the same for every turn of the thread. */
function scratchKey(d: Pick<DispatchRow, 'conversationId' | 'threadRootId' | 'onBehalfOfAccountId'>): string {
  const key = `${d.threadRootId ?? d.conversationId}-${d.onBehalfOfAccountId ?? 'nobody'}`.replace(
    /[^A-Za-z0-9_-]/g,
    '_',
  );
  return key.length <= 80 ? key : createHash('sha256').update(key).digest('hex').slice(0, 40);
}

/**
 * The turn's session as the runner reads it (`DispatchContext.session`, CT-1207): whether it resumes one, and since when
 * the window holds only what is new.
 */
export function turnSession(row: DispatchRow, since: { before: Date } | null): DispatchSession | null {
  if (!usesSessions(row) && !row.providerSessionId) return null;
  const resumed = !!since;
  return {
    key: conversationKeyFor(row),
    resumed,
    since: since ? since.before.toISOString() : null,
    reason: resumed ? null : 'a new session',
    scratchKey: scratchKey(row),
  };
}

/** Whether a failed attempt had resumed an earlier turn's session: its retry then starts fresh (BP-B17). */
export async function resumedEarlierSession(db: Queryable, row: DispatchRow): Promise<boolean> {
  return (await lastTurnOf(db, row)) !== null;
}

/**
 * The prompt cache result of a chat turn that resumed its session (prompt-efficiency.md PE-12): from the session's
 * last turn's largest call, the gap since it ended and the cache lifetime it wrote with. Null when not judged.
 */
export async function resumedCacheResult(
  tx: Queryable,
  row: DispatchRow,
  providerSessionId: string | null | undefined,
  usage: SpendUsage | undefined,
  now: Date,
): Promise<CacheJudgement | null> {
  if (!usage || !providerSessionId || providerSessionId !== row.providerSessionId || !usesSessions(row))
    return null;
  const last = await lastTurnOf(tx, row);
  const prior = last?.usage as StoredUsage | null | undefined;
  if (!last?.finishedAt || !prior) return null;
  return judgeCache({
    usage,
    priorContextTokens: prior.largestCallInputTokens ?? null,
    gapMs: Math.max(0, (row.claimedAt ?? now).getTime() - last.finishedAt.getTime()),
    ttlMs: promptCacheTtlMs(last.provider, last.trigger),
  });
}

/** A Hermes session and the home it lives in (the person's, or the outsiders' for a turn queued for nobody). */
export interface HermesSession {
  home: HermesHome;
  /** Hermes's id, without `hermes:`. */
  session: string;
}

async function sessionsWhere(db: Queryable, where: ReturnType<typeof and>): Promise<HermesSession[]> {
  const rows = await db
    .selectDistinct({ account: dispatches.onBehalfOfAccountId, session: dispatches.providerSessionId })
    .from(dispatches)
    .where(and(where, like(dispatches.providerSessionId, `${HERMES_SESSION}%`)));
  return rows.flatMap((r) =>
    r.session ? [{ home: homeOf(r.account), session: r.session.slice(HERMES_SESSION.length) }] : [],
  );
}

/**
 * The sessions of a conversation's turns that began after `since`: what may hold a message from then on (a thread's
 * own turns, and later threads whose opening window showed it, CH-03).
 */
export function sessionsSince(db: Queryable, conversationId: string, since: Date) {
  return sessionsWhere(
    db,
    and(eq(dispatches.conversationId, conversationId), gte(dispatches.claimedAt, since)),
  );
}

/**
 * The sessions of the finished automation turns in a thread: what an automation run's agent steps ran in (its turns
 * answer in the run's thread), once none of them runs any more.
 */
export function finishedAutomationSessions(db: Queryable, threadRootId: string) {
  return sessionsWhere(
    db,
    and(
      eq(dispatches.threadRootId, threadRootId),
      eq(dispatches.trigger, 'automation'),
      inArray(dispatches.state, ['done', 'failed', 'cancelled']),
    ),
  );
}

/** The sessions of a room's top level, not its threads' (Clear chats, CHC-04). */
export function topLevelSessions(db: Queryable, conversationId: string) {
  return sessionsWhere(
    db,
    and(eq(dispatches.conversationId, conversationId), isNull(dispatches.threadRootId)),
  );
}

/**
 * Forgets Hermes sessions (HE-40): no turn resumes them again — the turns that ran in them no longer name them — and,
 * after the commit, the runner deletes them from their Hermes home (`sessions.delete`, HE-S113). The commit
 * records them (`hermes_session_drops`), so a runner that isn't there, or a call that fails, only delays the delete
 * (hermes-native.md HN-K02, `hermes-home/housekeeping.ts`).
 */
export async function dropSessions(
  ctx: Pick<ApplyContext, 'tx' | 'services' | 'background' | 'now'>,
  sessions: readonly HermesSession[],
): Promise<void> {
  if (sessions.length === 0) return;
  await ctx.tx
    .update(dispatches)
    .set({ providerSessionId: null })
    .where(
      inArray(
        dispatches.providerSessionId,
        sessions.map((s) => `${HERMES_SESSION}${s.session}`),
      ),
    );
  await recordForgottenSessions(ctx.tx, sessions, ctx.now);
  kickHermesHousekeeping(ctx);
}
