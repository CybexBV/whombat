/**
 * Threads in pages (docs/decisions/review-features.md RF-03; contracts CT-299): `messages.thread` without `limit` answers
 * every reply and `more: null` (older clients), with it the newest `limit` replies before `before`, oldest first, and
 * `more.before` while earlier ones exist — what core's `pageThreadReplies` says over the whole thread.
 */
import { pageThreadReplies, ThreadView } from '@whombat/core';
import { eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let rootId = '';
const replyIds: string[] = [];

beforeAll(async () => {
  const root = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: 'A long thread' });
  if (root.status !== 'ok') throw new Error('no root');
  rootId = root.result.id;
  for (let i = 1; i <= 7; i++) {
    const reply = await t.commit(i % 2 ? IDS.dusty : IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      threadRootId: rootId,
      text: `Reply ${i}`,
    });
    if (reply.status !== 'ok') throw new Error('no reply');
    replyIds.push(reply.result.id);
  }
});

async function thread(query = '') {
  const { cookie } = await sessionFor(t.services, IDS.mara);
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/messages/${rootId}/thread${query}`,
    headers: { cookie },
  });
  return { status: res.statusCode, view: res.statusCode === 200 ? ThreadView.parse(res.json()) : null };
}

const ids = (view: ThreadView | null) => view?.replies.map((r) => r.id) ?? [];
const reference = (query: { before?: string; limit?: number }) =>
  pageThreadReplies(
    replyIds.map((id) => ({ id })),
    query,
  );

describe('messages.thread pages', () => {
  it('without a limit: every reply, nothing more (older clients)', async () => {
    const { view } = await thread();
    expect(ids(view)).toEqual(replyIds);
    expect(view?.more).toBeNull();
    expect(view?.root.replyCount).toBe(7);
  });

  it('with one: the newest page, then earlier ones until the first', async () => {
    const first = await thread('?limit=3');
    expect(ids(first.view)).toEqual(replyIds.slice(4));
    expect(first.view?.more).toEqual({ before: replyIds[4] });
    const second = await thread(`?limit=3&before=${first.view?.more?.before}`);
    expect(ids(second.view)).toEqual(replyIds.slice(1, 4));
    expect(second.view?.more).toEqual({ before: replyIds[1] });
    const last = await thread(`?limit=3&before=${second.view?.more?.before}`);
    expect(ids(last.view)).toEqual(replyIds.slice(0, 1));
    expect(last.view?.more).toBeNull();
    // The root stays whole on every page.
    expect(last.view?.root.id).toBe(rootId);
  });

  it('answers what the contracts’ reference answers, an unknown `before` from the newest', async () => {
    for (const query of [
      { limit: 1 },
      { limit: 7 },
      { limit: 200 },
      { limit: 2, before: replyIds[2] },
      { limit: 2, before: 'msg_notinthisthread' },
      { limit: 3, before: rootId },
    ]) {
      const qs = `?limit=${query.limit}${query.before ? `&before=${query.before}` : ''}`;
      const { view } = await thread(qs);
      const expected = reference(query);
      expect(ids(view), qs).toEqual(expected.replies.map((r) => r.id));
      expect(view?.more, qs).toEqual(expected.more);
    }
  });

  it('keeps replies with tied and submillisecond times in order across page boundaries', async () => {
    const original = await t.services.db
      .select({ id: messages.id, at: sql<string>`${messages.createdAt}::text` })
      .from(messages)
      .where(inArray(messages.id, replyIds));
    try {
      // Imports can retain microseconds, and several replies can share a timestamp. Neither can skip a reply.
      for (const [index, id] of replyIds.entries())
        await t.services.db
          .update(messages)
          .set({
            createdAt: sql`'2026-09-23T09:23:00Z'::timestamptz + ${Math.floor(index / 2)} * interval '1 microsecond'`,
          })
          .where(eq(messages.id, id));
      let before: string | undefined;
      const pages: string[] = [];
      do {
        const { view } = await thread(`?limit=2${before ? `&before=${before}` : ''}`);
        const expected = reference({ limit: 2, before });
        expect(ids(view)).toEqual(expected.replies.map((r) => r.id));
        expect(view?.more).toEqual(expected.more);
        pages.unshift(...ids(view));
        before = view?.more?.before;
      } while (before);
      expect(pages).toEqual(replyIds);
    } finally {
      for (const { id, at } of original)
        await t.services.db
          .update(messages)
          .set({ createdAt: sql`${at}::timestamptz` })
          .where(eq(messages.id, id));
    }
  });
});
