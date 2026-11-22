/**
 * Which messages outsiders' input wrote, whether or not they carry the mark (`messages.outsiders_run`): an agent's post
 * in a turn queued for nobody (`runtime/person.ts`), that turn's failure notice and its prompt, and what a tracker or mail
 * run's own steps posted in the threads it worked in. The mark is set when such a message is posted, but some never got
 * it: what came before the mark and lies outside the run's main thread (a step that posts in a thread of its own), and
 * what the previous release wrote while the box ran it again after an update (it doesn't mark). So:
 *
 * - every start of this release marks them (`reconcileOutsidersMarks`), bounded, newest first, and doing nothing for
 *   what is marked already;
 * - what lets a person's turn start from a message (More detail, Try again, the claim of such a turn) asks
 *   `outsidersWrote`, which reads the dispatch that wrote it, not only the mark.
 *
 * A post without its turn's id (the previous release stamped it only in Chat) counts as the outsiders' turn's when the
 * agent wrote it in that turn's place while the turn held it: a place has one turn at a time, so no person's turn wrote
 * there then. For a turn claimed twice (after a crash) that is from when it was queued, as its first claim isn't kept.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import type { Services } from '../services';

/** Dispatches looked at in one statement, and how many statements one start runs at most. */
const DISPATCH_PAGE = 500;
const RUN_PAGE = 200;
const MAX_PAGES = 40;

/** The ids of messages an outsiders' dispatch in `page` (a relation of dispatch rows, `d`) wrote, unmarked. */
function writtenByDispatches(page: SQL): SQL {
  return sql`
    select m.id from ${page} d
      join messages m on m.dispatch_id = d.id and m.author_id = d.agent_id
      where m.outsiders_run = false
    union
    select m.id from ${page} d
      join messages m on m.card ->> 'kind' = 'turn_failed' and m.card ->> 'dispatchId' = d.id
        and m.author_id = d.agent_id
      where m.outsiders_run = false
    union
    select m.id from ${page} d
      join messages m on m.conversation_id = d.conversation_id and m.author_id = d.agent_id
        and m.dispatch_id is null
        and m.created_at >= case when d.attempts > 1 then d.created_at else d.claimed_at end
        and (d.finished_at is null or m.created_at <= d.finished_at)
      where m.outsiders_run = false
        and d.claimed_at is not null
        and (d.thread_root_id = coalesce(m.thread_root_id, m.id)
          or (d.thread_root_id is null and m.thread_root_id is null))
    union
    select m.id from ${page} d
      join messages m on m.id = d.message_id
      where m.outsiders_run = false and d.trigger = 'automation'`;
}

/**
 * The ids of messages a tracker or mail run in `page` (a relation of run rows, `r`) posted as its automation while it
 * ran, unmarked: in its thread, as a step's prompt or message, or in the thread a step's turn worked in.
 */
function writtenByRuns(page: SQL): SQL {
  const during = sql`m.created_at >= r.created_at and (r.finished_at is null or m.created_at <= r.finished_at)`;
  return sql`
    select m.id from ${page} r
      join automations a on a.id = r.automation_id
      join messages m on (m.id = r.thread_root_id or m.thread_root_id = r.thread_root_id)
        and m.author_id = a.principal_id
      where m.outsiders_run = false and ${during}
    union
    select m.id from ${page} r
      join automations a on a.id = r.automation_id
      join automation_run_steps s on s.run_id = r.id
      join messages m on (m.id = s.prompt_message_id or m.id = any(s.message_ids))
        and m.author_id = a.principal_id
      where m.outsiders_run = false
    union
    select m.id from ${page} r
      join automations a on a.id = r.automation_id
      join automation_run_steps s on s.run_id = r.id
      join dispatches d on d.id = s.dispatch_id
      join messages m on (m.id = d.thread_root_id or m.thread_root_id = d.thread_root_id)
        and m.author_id = a.principal_id
      where m.outsiders_run = false and ${during}`;
}

const OUTSIDERS_DISPATCHES = sql`select * from dispatches where on_behalf_of_account_id is null`;
const OUTSIDERS_RUNS = sql`select * from automation_runs where trigger ->> 'kind' in ('tracker', 'mail')`;

/**
 * Whether outsiders' input wrote this message (see the module's note): marked, or written by an outsiders' dispatch or
 * as a tracker or mail run's own post. What a person's turn may start from is refused when it says yes.
 */
export async function outsidersWrote(db: Pick<Db | Tx, 'execute'>, messageId: string): Promise<boolean> {
  const of = sql`(select conversation_id, dispatch_id, burrow_id from messages where id = ${messageId})`;
  // The turns that could have written it: in its room, or the one it names.
  const turns = sql`(select * from dispatches where on_behalf_of_account_id is null
    and (conversation_id = (select conversation_id from ${of} x) or id = (select dispatch_id from ${of} x)))`;
  const runs = sql`(${OUTSIDERS_RUNS} and burrow_id = (select burrow_id from ${of} x))`;
  const [row] = await db.execute<{ outside: boolean }>(sql`
    select exists (select 1 from messages where id = ${messageId} and outsiders_run)
      or exists (select 1 from (${writtenByDispatches(turns)}) as w where w.id = ${messageId})
      or exists (select 1 from (${writtenByRuns(runs)}) as w where w.id = ${messageId}) as outside`);
  return row?.outside === true;
}

/** Where the next page starts: the oldest row of the last one. */
interface Cursor {
  createdAt: string;
  id: string;
}

interface PageDone {
  marked: number;
  next: Cursor;
  full: boolean;
}

/**
 * Marks what outsiders' input wrote and isn't marked yet (see the module's note), and takes those messages and the
 * approvals asked on them out of Search as the mark does. Newest first, a page of dispatches or runs a statement, at
 * most `MAX_PAGES` of each a start (`limits` for tests); running it again changes nothing. How many messages it marked.
 */
export async function reconcileOutsidersMarks(
  services: Services,
  limits: { dispatchPage?: number; runPage?: number; maxPages?: number } = {},
): Promise<number> {
  let marked = 0;
  const maxPages = limits.maxPages ?? MAX_PAGES;
  const pages = [
    { rows: OUTSIDERS_DISPATCHES, size: limits.dispatchPage ?? DISPATCH_PAGE, written: writtenByDispatches },
    { rows: OUTSIDERS_RUNS, size: limits.runPage ?? RUN_PAGE, written: writtenByRuns },
  ];
  for (const { rows, size, written } of pages) {
    let after: Cursor | null = null;
    for (let n = 0; n < maxPages; n++) {
      const cursor: Cursor | null = after;
      const page: SQL = sql`(select * from (${rows}) as all_rows
        ${cursor ? sql`where (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : sql``}
        order by created_at desc, id desc limit ${size})`;
      const step: PageDone | null = await services.pipeline.transactAccount(
        async (tx): Promise<PageDone | null> => {
          // The page's oldest row, where the next page starts, and whether the page was full.
          const [last] = await tx.execute<{ created_at: string; id: string; n: number }>(sql`
          select oldest.created_at::text as created_at, oldest.id, (select count(*)::int from ${page} p) as n
          from (select created_at, id from ${page} p order by created_at asc, id asc limit 1) as oldest`);
          if (!last) return null;
          const ids: string[] = (
            await tx.execute<{ id: string }>(sql`
            update messages set outsiders_run = true
            where outsiders_run = false and id in (${written(page)})
            returning id`)
          ).map((r) => r.id);
          if (ids.length) {
            const list = sql`${sql.param(ids)}::text[]`;
            await tx.execute(sql`delete from search_documents where id = any(${list})`);
            await tx.execute(
              sql`delete from search_documents where id in (select id from approvals where message_id = any(${list}))`,
            );
          }
          return {
            marked: ids.length,
            next: { createdAt: last.created_at, id: last.id },
            full: last.n >= size,
          };
        },
      );
      if (!step) break;
      marked += step.marked;
      if (!step.full) break;
      after = step.next;
      if (n === maxPages - 1)
        services.log.warn({ pages: maxPages }, 'outsiders’ marks: stopped at the page limit for this start');
    }
  }
  return marked;
}
