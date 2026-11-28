/**
 * What the threads of a person's Chat or Feedback room are doing, as the Threads list and settling read it
 * (docs/decisions/chat-settle.md): whether the agent works on a thread, whether something in it waits for the person,
 * whether a message of it is pinned, and when the pull request its work opened merged or closed.
 *
 * A thread is its first message (a top-level message of the room) and its replies, so a message belongs to the thread
 * `coalesce(thread_root_id, id)`.
 */
import type { ChatThreadJob } from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { activeCouncilThreads } from '../council/context';
import type { Db } from '../db/client';
import { dispatches, t3Watches } from '../db/schema/index';
import { liveDelegationThreads } from '../delegate/commands';
import { iso } from '../lib/time';
import { jobEndOf } from '../t3code/status';

/** The room the threads are in, and whose it is. */
export interface ThreadRoom {
  burrowId: string;
  conversationId: string;
  agentId: string;
  personId: string;
}

/** `rootIds` null: every thread of the room. */
type Roots = readonly string[] | null;

/** SQL: the thread `root` is one of `rootIds` (always, when null). */
const among = (root: SQL, rootIds: Roots): SQL =>
  rootIds
    ? sql`${root} in (${sql.join(
        rootIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`true`;

/**
 * The threads a turn of the agent is queued, claimed or running in; with `handedOver`, also those it handed work to T3
 * Code from that still goes on there (t3code.md T3-27) and those with a council or a delegation at work: settling
 * doesn't put those away.
 */
export async function workingThreads(
  db: Db,
  room: Pick<ThreadRoom, 'conversationId' | 'agentId'>,
  rootIds: Roots,
  opts: { handedOver?: boolean } = {},
): Promise<Set<string>> {
  if (rootIds && !rootIds.length) return new Set();
  if (opts.handedOver) {
    const [turns, handed, councils, delegated] = await Promise.all([
      workingThreads(db, room, rootIds),
      handedOverThreads(db, room, rootIds),
      // A council at work, also while it waits for the person's go-ahead (council.md CNL-43).
      activeCouncilThreads(db, room.conversationId, rootIds ? [...rootIds] : null),
      // A delegation's checklist waiting for the person, or its tasks at work (delegate.md).
      liveDelegationThreads(db, room.conversationId, rootIds ? [...rootIds] : null),
    ]);
    return new Set([...turns, ...handed, ...councils, ...delegated]);
  }
  const rows = await db
    .select({ threadRootId: dispatches.threadRootId })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, room.agentId),
        eq(dispatches.conversationId, room.conversationId),
        inArray(dispatches.state, ['queued', 'claimed', 'running']),
        rootIds ? inArray(dispatches.threadRootId, [...rootIds]) : isNotNull(dispatches.threadRootId),
      ),
    );
  return new Set(rows.flatMap((r) => (r.threadRootId ? [r.threadRootId] : [])));
}

/** The threads whose work the agent handed to T3 Code still goes on there (a watch still watching). */
async function handedOverThreads(
  db: Db,
  room: Pick<ThreadRoom, 'conversationId' | 'agentId'>,
  rootIds: Roots,
): Promise<Set<string>> {
  const rows = await db
    .select({ threadRootId: t3Watches.threadRootId })
    .from(t3Watches)
    .where(
      and(
        eq(t3Watches.conversationId, room.conversationId),
        eq(t3Watches.agentId, room.agentId),
        eq(t3Watches.state, 'watching'),
        rootIds ? inArray(t3Watches.threadRootId, [...rootIds]) : isNotNull(t3Watches.threadRootId),
      ),
    );
  return new Set(rows.flatMap((r) => (r.threadRootId ? [r.threadRootId] : [])));
}

/**
 * How the latest job each thread handed to T3 Code ended (`ChatThread.job`), for threads whose person hasn't written
 * there since: its row then says Done, Didn’t finish or Stopped. A council's or a checklist's threads are their cards'.
 * A thread whose latest job still goes on, or that has none, isn't in the map.
 */
export async function endedJobs(
  db: Db,
  room: Pick<ThreadRoom, 'conversationId' | 'agentId' | 'personId'>,
  rootIds: readonly string[],
): Promise<Map<string, ChatThreadJob>> {
  if (!rootIds.length) return new Map();
  const [watches, written] = await Promise.all([
    db
      .select({
        threadRootId: t3Watches.threadRootId,
        state: t3Watches.state,
        status: t3Watches.status,
        prs: t3Watches.prs,
        progress: t3Watches.progress,
        runEndedAt: t3Watches.runEndedAt,
      })
      .from(t3Watches)
      .where(
        and(
          eq(t3Watches.conversationId, room.conversationId),
          eq(t3Watches.agentId, room.agentId),
          inArray(t3Watches.threadRootId, [...rootIds]),
          isNull(t3Watches.councilId),
          isNull(t3Watches.delegationTaskId),
        ),
      )
      .orderBy(desc(t3Watches.armedAt)),
    db.execute<{ root_id: string; at: string | Date }>(sql`
      select coalesce(thread_root_id, id) as root_id, max(created_at) as at from messages
       where conversation_id = ${room.conversationId} and author_id = ${room.personId} and deleted_at is null
         and ${among(sql`coalesce(thread_root_id, id)`, rootIds)}
       group by 1`),
  ]);
  const lastWritten = new Map(written.map((r) => [r.root_id, new Date(r.at).getTime()]));
  const out = new Map<string, ChatThreadJob>();
  const seen = new Set<string>();
  for (const w of watches) {
    // Newest hand-over first: only each thread's latest job counts.
    if (!w.threadRootId || seen.has(w.threadRootId)) continue;
    seen.add(w.threadRootId);
    const end = jobEndOf(w);
    if (!end) continue;
    const wrote = lastWritten.get(w.threadRootId);
    if (wrote !== undefined && wrote > end.endedAt.getTime()) continue;
    out.set(w.threadRootId, { outcome: end.outcome, endedAt: iso(end.endedAt) });
  }
  return out;
}

/**
 * The threads that wait for the person: a pending approval whose card is in it (a yes or no, a key the agent asked for,
 * a Vault entry it wants to use), a question of the agent's in it that the person hasn't answered in the thread since
 * (the same rule as Home's Needs you), or a guide card still open there.
 */
export async function waitingThreads(db: Db, room: ThreadRoom, rootIds: Roots): Promise<Set<string>> {
  if (rootIds && !rootIds.length) return new Set();
  const rows = await db.execute<{ root_id: string }>(sql`
    select coalesce(m.thread_root_id, m.id) as root_id
      from approvals a join messages m on m.id = a.message_id
     where a.burrow_id = ${room.burrowId} and a.state = 'pending' and m.conversation_id = ${room.conversationId}
       and ${among(sql`coalesce(m.thread_root_id, m.id)`, rootIds)}
    union
    select coalesce(q.thread_root_id, q.id)
      from messages q
     where q.conversation_id = ${room.conversationId} and q.author_id = ${room.agentId} and q.asks
       and q.deleted_at is null and ${among(sql`coalesce(q.thread_root_id, q.id)`, rootIds)}
       and not exists (select 1 from messages r
             where r.conversation_id = q.conversation_id and r.author_id = ${room.personId} and r.ord > q.ord
               and r.deleted_at is null and r.thread_root_id = coalesce(q.thread_root_id, q.id))
    union
    select coalesce(g.thread_root_id, g.id)
      from messages g
     where g.conversation_id = ${room.conversationId}
       and g.card->>'kind' = 'guide' and g.card->>'state' = 'open'
       and coalesce((g.card->>'standing')::boolean, false) = false
       and ${among(sql`coalesce(g.thread_root_id, g.id)`, rootIds)}`);
  return new Set(rows.map((r) => r.root_id));
}

/** The threads with a pinned message, their first one or a reply. */
export async function pinnedThreads(
  db: Db,
  room: Pick<ThreadRoom, 'conversationId'>,
  rootIds: Roots,
): Promise<Set<string>> {
  if (rootIds && !rootIds.length) return new Set();
  const rows = await db.execute<{ root_id: string }>(sql`
    select distinct coalesce(thread_root_id, id) as root_id from messages
     where conversation_id = ${room.conversationId} and pinned_at is not null
       and ${among(sql`coalesce(thread_root_id, id)`, rootIds)}`);
  return new Set(rows.map((r) => r.root_id));
}

/**
 * When the work of each thread ended, after the person's last message in the thread (a later question from the person
 * means it isn't over): the latest time a pull request of its runs (a run whose card is in the thread, or that a turn in
 * the thread started) merged or closed, as the GitHub mirror saw it; or, for a customer's report, when the last of its
 * fixes went live where the customer is (and the customer was told), once every fix of the report automation's runs in
 * the thread is live (or closed unmerged, one at least live) and none of those runs still goes on. A closed pull request
 * has no time of its own: its row's last change is when the mirror saw it close.
 */
export async function endedThreads(db: Db, room: ThreadRoom, rootIds: Roots): Promise<Map<string, Date>> {
  if (rootIds && !rootIds.length) return new Map();
  const rows = await db.execute<{ root_id: string; ended_at: string | Date }>(sql`
    select x.root_id, max(x.ended_at) as ended_at from (
      select coalesce(cm.thread_root_id, cm.id) as root_id, coalesce(p.merged_at, p.updated_at) as ended_at
        from runs u
        join pull_requests p on p.repo_id = u.repo_id and p.number = u.pr_number
        join messages cm on cm.id = u.message_id
       where u.burrow_id = ${room.burrowId} and cm.conversation_id = ${room.conversationId}
         and p.state in ('merged', 'closed')
      union all
      select d.thread_root_id, coalesce(p.merged_at, p.updated_at)
        from runs u
        join pull_requests p on p.repo_id = u.repo_id and p.number = u.pr_number
        join dispatches d on d.id = u.dispatch_id
       where u.burrow_id = ${room.burrowId} and d.conversation_id = ${room.conversationId}
         and d.thread_root_id is not null and p.state in ('merged', 'closed')
      union all
      select f.root_id, f.ended_at from (
        select r.thread_root_id as root_id,
               max(coalesce(t.production_at, t.development_at, t.merged_at, t.updated_at)) as ended_at,
               bool_and(t.state in ('live', 'confirmed', 'closed')) as over,
               bool_or(t.state in ('live', 'confirmed')) as live
          from tracker_fixes t
          join automation_runs r on r.id = t.run_id
         where t.burrow_id = ${room.burrowId} and r.conversation_id = ${room.conversationId}
           and r.thread_root_id is not null
         group by r.thread_root_id
      ) f
       where f.over and f.live
         and not exists (select 1 from automation_runs g
               where g.thread_root_id = f.root_id
                 and g.status not in ('succeeded', 'failed', 'cancelled', 'skipped'))
    ) x
     where ${among(sql`x.root_id`, rootIds)}
       and x.ended_at > coalesce((select max(pm.created_at) from messages pm
             where pm.conversation_id = ${room.conversationId} and pm.author_id = ${room.personId}
               and (pm.id = x.root_id or pm.thread_root_id = x.root_id)), '-infinity'::timestamptz)
     group by x.root_id`);
  return new Map(rows.map((r) => [r.root_id, new Date(r.ended_at)]));
}
