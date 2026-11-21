/**
 * Which threads of the person's Chat and Feedback rooms have something new (docs/decisions/thread-unread.md).
 *
 * A message in a thread is new to a viewer when someone else wrote it, it isn't deleted, and it comes after the
 * viewer's marker for that thread (`thread_reads`). A thread's first message is also passed once the viewer read the
 * room past it (`read_states`), because the room shows it. Settled threads count for nothing: a new message opens them
 * again (chat-settle.md), and then counts.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { threadReads } from '../db/schema/index';

/** Most threads one room lists as having something new (`chats.unread`). */
export const UNREAD_THREADS_MAX = 200;

/** The rooms whose badge counts threads: the person's Chat and Feedback (`threadedRoom`, as SQL on `conversations`). */
const threadedRoomSql = sql`c.kind = 'dm' and c.dm_agent_id is not null and c.dm_person_id is not null
  and (c.task_key is null or c.task_key = 'feedback')`;

function idList(ids: readonly string[]): SQL {
  return sql`array[${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )}]::text[]`;
}

type UnreadThreadRow = {
  conversation_id: string;
  root_id: string;
  unread: number;
};

/**
 * The open threads with something new for the viewer, in the given conversations that are threaded rooms (others give
 * nothing), newest activity first. `rootIds` narrows to those threads; `limit` caps the rows.
 */
async function unreadThreadRows(
  db: Db | Tx,
  viewerId: string,
  conversationIds: readonly string[],
  options: { rootIds?: readonly string[]; limit?: number } = {},
): Promise<UnreadThreadRow[]> {
  if (conversationIds.length === 0) return [];
  if (options.rootIds && options.rootIds.length === 0) return [];
  const roots = options.rootIds ? sql`and r.id = any(${idList(options.rootIds)})` : sql``;
  const limit = options.limit ? sql`limit ${options.limit}` : sql``;
  // Replies through `messages_thread_idx`, one range per open thread; the first message from its own row.
  return db.execute<UnreadThreadRow>(sql`
    select r.conversation_id, r.id as root_id, (x.replies + case
             when r.deleted_at is null and r.author_id <> ${viewerId}
              and r.ord > coalesce(tr.last_read_ord, -1)
              and r.ord > coalesce(rs.last_read_ord, -1) then 1 else 0 end)::int as unread
      from conversations c
      join messages r on r.conversation_id = c.id and r.thread_root_id is null and r.settled_at is null
      left join read_states rs on rs.conversation_id = c.id and rs.principal_id = ${viewerId}
      left join thread_reads tr on tr.root_id = r.id and tr.principal_id = ${viewerId}
      cross join lateral (
        select count(*)::int as replies
          from messages m
         where m.thread_root_id = r.id
           and m.deleted_at is null
           and m.author_id <> ${viewerId}
           and m.ord > coalesce(tr.last_read_ord, -1)) x
     where c.id = any(${idList([...new Set(conversationIds)])})
       and ${threadedRoomSql}
       ${roots}
       and (x.replies > 0 or (r.deleted_at is null and r.author_id <> ${viewerId}
            and r.ord > coalesce(tr.last_read_ord, -1) and r.ord > coalesce(rs.last_read_ord, -1)))
     order by coalesce(r.last_reply_at, r.created_at) desc, r.id desc
     ${limit}`);
}

/**
 * How many threads have something new, per conversation, for the conversations that are threaded rooms: their badge.
 * Conversations that aren't threaded rooms are left out of the map.
 */
export async function unreadThreadCounts(
  db: Db | Tx,
  viewerId: string,
  conversationIds: readonly string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const ids = [...new Set(conversationIds)];
  const rooms = await db.execute<{ id: string }>(sql`
    select c.id from conversations c where c.id = any(${idList(ids)}) and ${threadedRoomSql}`);
  if (rooms.length === 0) return new Map();
  const out = new Map<string, number>(rooms.map((r) => [r.id, 0]));
  const rows = await unreadThreadRows(
    db,
    viewerId,
    rooms.map((r) => r.id),
  );
  for (const r of rows) out.set(r.conversation_id, (out.get(r.conversation_id) ?? 0) + 1);
  return out;
}

/** One room's threads with something new for the viewer, newest activity first (`chats.unread`). */
export async function unreadThreads(
  db: Db | Tx,
  viewerId: string,
  conversationId: string,
): Promise<{ rootId: string; unread: number }[]> {
  const rows = await unreadThreadRows(db, viewerId, [conversationId], { limit: UNREAD_THREADS_MAX });
  return rows.map((r) => ({ rootId: r.root_id, unread: r.unread }));
}

/** Every open thread of one room with something new for the viewer, uncapped: what settling must leave open (CIB-07). */
export async function unreadRootIds(
  db: Db | Tx,
  viewerId: string,
  conversationId: string,
): Promise<Set<string>> {
  const rows = await unreadThreadRows(db, viewerId, [conversationId]);
  return new Set(rows.map((r) => r.root_id));
}

/** What is new to the viewer in one thread: 0 when nothing (or it is settled, or not in a threaded room). */
export async function unreadInThread(
  db: Db | Tx,
  viewerId: string,
  conversationId: string,
  rootId: string,
): Promise<number> {
  const [row] = await unreadThreadRows(db, viewerId, [conversationId], { rootIds: [rootId] });
  return row?.unread ?? 0;
}

/** Moves the viewer's marker in a thread to `ord`, never backwards. */
export async function moveThreadReadMark(
  tx: Tx,
  principalId: string,
  rootId: string,
  ord: number,
  now: Date,
): Promise<void> {
  await tx
    .insert(threadReads)
    .values({ rootId, principalId, lastReadOrd: ord, updatedAt: now })
    .onConflictDoUpdate({
      target: [threadReads.rootId, threadReads.principalId],
      set: { lastReadOrd: ord, updatedAt: now },
      setWhere: sql`${threadReads.lastReadOrd} < ${ord}`,
    });
}

/** The viewer read these threads to their newest message (they settled them by hand): nothing in them is new. */
export async function readThreadsToEnd(
  tx: Tx,
  principalId: string,
  rootIds: readonly string[],
  now: Date,
): Promise<void> {
  if (rootIds.length === 0) return;
  await tx.execute(sql`
    insert into thread_reads (root_id, principal_id, last_read_ord, updated_at)
    select r.id, ${principalId},
           greatest(r.ord, coalesce((select max(m.ord) from messages m where m.thread_root_id = r.id), r.ord)),
           ${now.toISOString()}::timestamptz
      from messages r
     where r.id = any(${idList(rootIds)})
    on conflict (root_id, principal_id) do update
       set last_read_ord = excluded.last_read_ord, updated_at = excluded.updated_at
     where thread_reads.last_read_ord < excluded.last_read_ord`);
}

/**
 * Marks a thread unread for the viewer (`chats.markUnread`, chat-inbox.md CIB-06): their marker moves back to just
 * before the newest message someone else wrote in it, so that message is new again. The one way a marker moves back.
 * Nothing from someone else in it: nothing changes.
 */
export async function moveThreadReadMarkBack(
  tx: Tx,
  principalId: string,
  rootId: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    insert into thread_reads (root_id, principal_id, last_read_ord, updated_at)
    select ${rootId}, ${principalId}, m.ord - 1, ${now.toISOString()}::timestamptz
      from messages m
     where (m.id = ${rootId} or m.thread_root_id = ${rootId})
       and m.deleted_at is null
       and m.author_id <> ${principalId}
     order by m.ord desc
     limit 1
    on conflict (root_id, principal_id) do update
       set last_read_ord = excluded.last_read_ord, updated_at = excluded.updated_at`);
}
