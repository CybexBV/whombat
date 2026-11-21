/**
 * Read state across devices (docs/decisions/review-features.md RF-05; contracts CT-300): `notifications.markRead`
 * publishes `notification.read` on the reader's `me` topic — the ids it read and the unread count after, or `ids: null`
 * with `before` for “all” — only once committed, and nothing when nothing changed. (A skill proposal's decision, the
 * other path, is checked in skills/needs-you.int.test.ts.)
 */
import { api, buildPath, topics } from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { notifications } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const frames: BusFrame[] = [];

beforeAll(() => {
  t.services.bus.onFrame((f) => {
    if (f.event.type === 'notification.read') frames.push(f);
  });
});

async function markRead(as: string, body: unknown) {
  const { cookie } = await sessionFor(t.services, as);
  const ep = api.notifications.markRead;
  const res = await t.api.inject({
    method: 'POST',
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie },
    payload: body as object,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { unread: number };
}

async function unreadOf(principalId: string) {
  return t.services.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.principalId, principalId), isNull(notifications.readAt)));
}

/** Dusty mentions Mara `n` times in #billing-v2: her new notifications' ids. */
async function mentionMara(n: number): Promise<string[]> {
  const before = new Set((await unreadOf(IDS.mara)).map((r) => r.id));
  for (let i = 0; i < n; i++) {
    const res = await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: `@Mara question ${i + 1}`,
    });
    if (res.status !== 'ok') throw new Error('send failed');
  }
  return (await unreadOf(IDS.mara)).map((r) => r.id).filter((id) => !before.has(id));
}

describe('notification.read', () => {
  it('names the ids read and the unread count after, on the reader’s own topic only', async () => {
    const ids = await mentionMara(2);
    expect(ids).toHaveLength(2);
    frames.length = 0;
    const { unread } = await markRead(IDS.mara, { ids: [ids[0]] });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.topic).toBe(topics.me(IDS.mara));
    expect(frames[0]?.event).toEqual({ type: 'notification.read', ids: [ids[0]], unread });
    // Read already: nothing changed, nothing is said.
    frames.length = 0;
    await markRead(IDS.mara, { ids: [ids[0]] });
    expect(frames).toEqual([]);
    expect((await unreadOf(IDS.mara)).map((r) => r.id)).toContain(ids[1]);
  });

  it('“all”: ids null and the instant everything up to it was read', async () => {
    await mentionMara(1);
    frames.length = 0;
    const { unread } = await markRead(IDS.mara, { all: true });
    expect(unread).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toMatchObject({ type: 'notification.read', ids: null, unread: 0 });
    const before = (frames[0]?.event as { before?: string } | undefined)?.before ?? '';
    expect(Date.parse(before)).not.toBeNaN();
    frames.length = 0;
    await markRead(IDS.mara, { all: true });
    expect(frames).toEqual([]);
  });
});
