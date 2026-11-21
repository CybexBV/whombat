/**
 * Read paths that scanned (docs/decisions/server-efficiency.md SV-01, SV-09, SV-12): migration 0084's indexes, and the
 * rewritten unread and open-question queries count exactly what the queries they replace counted.
 */
import { newId } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { hasOpenQuestion } from '../commands/agent-status';
import { messages, readStates } from '../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { personUnreadCounts, type UnreadCounts, unreadCounts } from './conversations';

const t = useTestServer({ seed: true });

/** The query `unreadCounts` ran before SV-01 (one viewer, any conversations): the reference. */
async function before(viewerId: string, ids: readonly string[]): Promise<Map<string, UnreadCounts>> {
  const rows = await t.services.db.execute<{ conversation_id: string; unread: number; mentions: number }>(sql`
    select m.conversation_id,
           count(*)::int as unread,
           count(*) filter (where ${viewerId} = any(m.mentions))::int as mentions
      from messages m
      left join read_states rs
        on rs.conversation_id = m.conversation_id and rs.principal_id = ${viewerId}
     where m.conversation_id in (${sql.join(
       ids.map((i) => sql`${i}`),
       sql`, `,
     )})
       and m.thread_root_id is null
       and m.deleted_at is null
       and m.author_id <> ${viewerId}
       and (rs.last_read_ord is null or m.ord > rs.last_read_ord)
     group by m.conversation_id`);
  const out = new Map<string, UnreadCounts>(ids.map((id) => [id, { unread: 0, mentions: 0 }]));
  for (const r of rows) out.set(r.conversation_id, { unread: r.unread, mentions: r.mentions });
  return out;
}

beforeAll(async () => {
  // #billing-v2 gets 60 more top-level messages by turns (some mention Mara or Dusty, some deleted) and thread replies
  // (never counted); Dusty has read up to the 20th, Mara has a marker without a position.
  const db = t.services.db;
  const authors = [IDS.dusty, IDS.mara, IDS.dusty];
  const base = Date.parse('2026-09-24T08:00:00Z');
  const ids: string[] = [];
  for (let i = 0; i < 60; i++) {
    const id = newId('message');
    ids.push(id);
    await db.insert(messages).values({
      id,
      burrowId: TEST_BURROW_ID,
      conversationId: IDS.billing,
      authorId: authors[i % authors.length] as string,
      createdAt: new Date(base + i * 60_000),
      text: `top ${i}`,
      mentions: i % 7 === 0 ? [IDS.mara] : i % 11 === 0 ? [IDS.dusty, IDS.mara] : [],
      deletedAt: i % 13 === 5 ? new Date(base + i * 60_000 + 1000) : null,
    });
    if (i % 9 === 0)
      await db.insert(messages).values({
        id: newId('message'),
        burrowId: TEST_BURROW_ID,
        conversationId: IDS.billing,
        authorId: IDS.dusty,
        createdAt: new Date(base + i * 60_000 + 30_000),
        text: `reply ${i}`,
        mentions: [IDS.mara],
        threadRootId: id,
      });
  }
  const ordOf = async (id: string) =>
    (await db.execute<{ ord: number }>(sql`select ord::int from messages where id = ${id}`))[0]?.ord ?? 0;
  const marker = async (principalId: string, messageId: string | null, ord: number | null) =>
    db
      .insert(readStates)
      .values({
        conversationId: IDS.billing,
        principalId,
        lastReadMessageId: messageId,
        lastReadAt: new Date(base),
        lastReadOrd: ord,
        updatedAt: new Date(base),
      })
      .onConflictDoUpdate({
        target: [readStates.conversationId, readStates.principalId],
        set: { lastReadMessageId: messageId, lastReadOrd: ord },
      });
  await marker(IDS.dusty, ids[20] as string, await ordOf(ids[20] as string));
  await marker(IDS.mara, null, null);
});

describe('0084 read indexes (SV-01, SV-09, SV-12)', () => {
  it('creates the top-level messages index and the listed-events index with their included columns', async () => {
    const rows = await t.services.db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
       where indexname in ('messages_top_level_idx', 'events_listed_kind_idx') order by indexname`);
    expect(rows.map((r) => r.indexname)).toEqual(['events_listed_kind_idx', 'messages_top_level_idx']);
    expect(rows[0]?.indexdef).toContain(
      '(burrow_id, kind) INCLUDE (actor_id, about_id) WHERE (text IS NOT NULL)',
    );
    expect(rows[1]?.indexdef).toContain(
      '(conversation_id, ord) INCLUDE (author_id, mentions, deleted_at) WHERE (thread_root_id IS NULL)',
    );
  });

  it('counts the person’s badge as the query it replaced did, and none when they wrote the message', async () => {
    const all = await personUnreadCounts(t.services.db, TEST_BURROW_ID, IDS.billing, null);
    expect([...all.keys()]).toEqual([IDS.mara]);
    expect(all.get(IDS.mara)).toEqual((await before(IDS.mara, [IDS.billing])).get(IDS.billing));
    // Something to count: Mara (no position) everything by others.
    expect(all.get(IDS.mara)?.mentions).toBeGreaterThan(5);
    // The author is left out; the agent keeps no badge.
    expect((await personUnreadCounts(t.services.db, TEST_BURROW_ID, IDS.billing, IDS.mara)).size).toBe(0);
    expect([
      ...(await personUnreadCounts(t.services.db, TEST_BURROW_ID, IDS.billing, IDS.dusty)).keys(),
    ]).toEqual([IDS.mara]);
  });

  it('counts the same per conversation for a viewer (bootstrap) as before', async () => {
    const ids = [IDS.billing, IDS.general, IDS.incidents, IDS.pr482, IDS.dmDusty, IDS.billing];
    for (const viewer of [IDS.mara, IDS.dusty])
      expect(await unreadCounts(t.services.db, viewer, ids)).toEqual(await before(viewer, ids));
  });

  it('finds an agent’s open question by the place it was asked, as before (SV-12)', async () => {
    const db = t.services.db;
    const base = Date.parse('2026-09-25T08:00:00Z');
    const post = async (authorId: string, at: number, extra: Partial<typeof messages.$inferInsert> = {}) => {
      const id = newId('message');
      await db.insert(messages).values({
        id,
        burrowId: TEST_BURROW_ID,
        conversationId: IDS.incidents,
        authorId,
        createdAt: new Date(base + at * 1000),
        text: `m ${at}`,
        ...extra,
      });
      return id;
    };
    // Dusty asks at the top: open until a person speaks at the top or in the question's thread, not in another thread
    // or before the question; an agent's answer doesn't count.
    const other = await post(IDS.mara, 0);
    const q = await post(IDS.dusty, 10, { asks: true });
    await post(IDS.dusty, 20);
    await post(IDS.mara, 30, { threadRootId: other });
    expect(await hasOpenQuestion(db, IDS.dusty)).toBe(true);
    await post(IDS.mara, 40, { threadRootId: q });
    expect(await hasOpenQuestion(db, IDS.dusty)).toBe(false);
    // In a thread: open until a person replies in that thread after it; top-level messages don't answer it.
    const q2 = await post(IDS.dusty, 50, { asks: true, threadRootId: other });
    await post(IDS.mara, 60);
    expect(await hasOpenQuestion(db, IDS.dusty)).toBe(true);
    await post(IDS.mara, 70, { threadRootId: other });
    expect(await hasOpenQuestion(db, IDS.dusty)).toBe(false);
    // A deleted reply by a person still answers it (as before).
    await post(IDS.dusty, 80, { asks: true });
    await post(IDS.mara, 90, { deletedAt: new Date(base + 95_000) });
    expect(await hasOpenQuestion(db, IDS.dusty)).toBe(false);
    void q2;
  });
});
