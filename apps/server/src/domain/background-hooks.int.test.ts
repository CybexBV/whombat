/**
 * The sender's response doesn't wait for badges, notifications or push (docs/decisions/server-efficiency.md SV-02):
 * a mention whose push transport hangs still answers at once; the dispatch it queues is in the response; the badge,
 * the inbox row and the push follow in the background, and `background.settle()` (shutdown, tests) waits for them.
 */
import type { PushPayload, RealtimeEvent } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { notifications, outbox } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true, app: true });

/** Dusty posts in #incidents; the commit doesn't wait for its background work. */
const dustyPosts = (text: string) =>
  t.services.pipeline.commit(
    sendMessage,
    { conversationId: IDS.incidents, text },
    { burrowId: t.burrowId, actorId: IDS.dusty },
  );

describe('post-commit work in the background (SV-02)', () => {
  it('answers a message at once while its push hangs, then badges, notifies and pushes', async () => {
    let release: () => void = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pushed: { to: string[]; payload: PushPayload }[] = [];
    t.services.push.control = async (to, payload) => {
      await hung;
      pushed.push({ to: [...to], payload });
    };
    const frames: RealtimeEvent[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.topic === `me:${IDS.mara}`) frames.push(f.event);
    });
    try {
      const res = await dustyPosts('@Mara the 8812 refunds are back, can you look?');
      if (res.status !== 'ok') throw new Error(res.status);
      const messageId = res.result.id;
      // The push to Mara is still hanging: the commit didn't wait for it.
      expect(pushed).toEqual([]);
      expect(t.services.background.size).toBeGreaterThan(0);

      release();
      await t.services.background.settle();
      expect(frames.map((e) => e.type)).toEqual(
        expect.arrayContaining(['conversation.unread', 'notification.created']),
      );
      const badge = frames.find((e) => e.type === 'conversation.unread');
      expect(badge).toMatchObject({ conversationId: IDS.incidents, mentions: expect.any(Number) });
      const rows = await t.services.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.principalId, IDS.mara), eq(notifications.messageId, messageId)));
      expect(rows).toHaveLength(1);
      expect(pushed).toEqual([expect.objectContaining({ to: [IDS.mara] })]);
    } finally {
      off();
      t.services.push.control = null;
    }
  });

  it('publishes one room’s badges in the order the messages came, the last with the newest count', async () => {
    const counts: number[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.topic === `me:${IDS.mara}` && f.event.type === 'conversation.unread') counts.push(f.event.unread);
    });
    try {
      for (let i = 0; i < 5; i++) await dustyPosts(`refund batch ${i} done`);
      await t.services.background.settle();
      expect(counts).toHaveLength(5);
      expect([...counts].sort((a, b) => a - b)).toEqual(counts);
      expect(counts[4]).toBe((counts[0] ?? 0) + 4);
    } finally {
      off();
    }
  });

  it('writes each frame’s outbox row once, publishes the frame as stored, and prunes rows after a day (SV-05)', async () => {
    const seen: BusFrame[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.outboxId !== null) seen.push(f);
    });
    try {
      const res = await t.commit(IDS.mara, sendMessage, {
        conversationId: IDS.incidents,
        text: 'outbox check',
      });
      expect(res.status).toBe('ok');
    } finally {
      off();
    }
    expect(seen.length).toBeGreaterThan(0);
    const rows = await t.services.db
      .select()
      .from(outbox)
      .where(
        inArray(
          outbox.id,
          seen.map((f) => f.outboxId as number),
        ),
      );
    expect(rows).toHaveLength(seen.length);
    for (const frame of seen) {
      const row = rows.find((r) => r.id === frame.outboxId);
      expect(row?.publishedAt).toBeNull();
      expect({ topic: frame.topic, event: frame.event, eventId: frame.eventId }).toEqual({
        topic: row?.topic,
        event: row?.event,
        eventId: row?.eventId,
      });
      expect(frame.at).toBe(row?.createdAt.toISOString());
    }
    // A day later they go; newer ones stay.
    await t.services.db.execute(
      sql`update outbox set created_at = created_at - interval '25 hours' where id in (${sql.join(
        seen.map((f) => sql`${f.outboxId}`),
        sql`, `,
      )})`,
    );
    const pruned = await t.services.pipeline.drainOutbox();
    expect(pruned.deleted).toBeGreaterThanOrEqual(seen.length);
    const left = await t.services.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        inArray(
          outbox.id,
          seen.map((f) => f.outboxId as number),
        ),
      );
    expect(left).toEqual([]);
  });
});
