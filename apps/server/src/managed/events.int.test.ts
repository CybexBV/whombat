/**
 * The session event log (MA-09, MR-07): live events with appliance cursors, resume `after` a cursor, ephemeral
 * typing without one, per-topic authorization as `/ws`, and `snapshot_required` for an expired cursor (retention),
 * another epoch (restart) and another authorization generation.
 */
import { newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accounts, applianceEndpoints } from '../db/schema/index';
import * as frameFilling from '../realtime/fill';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { makeRoom } from '../test/rooms';
import { localId } from './audit';
import { formatCursor, MAX_PENDING_PER_SUBSCRIPTION, parseCursor, resumeDecision } from './events';
import { type TestSessionClient, testIdentity } from './testing';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
/** Another device of Mara's. */
let phone: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
  phone = await m.enroll(IDS.mara);
});

const send = (text: string, conversationId: string = IDS.general) => ({
  params: { burrow: 'burrow-hq', conversationId },
  body: { text },
});

type EventMsg = {
  t: 'event';
  ephemeral: boolean;
  cursor?: string;
  topic: string;
  event: { type: string; message?: { text: string } };
};

function texts(msgs: unknown[]): string[] {
  return (msgs as EventMsg[])
    .filter((x) => x.t === 'event' && x.event.type === 'message.created')
    .map((x) => x.event.message?.text ?? '');
}

describe('session events', () => {
  it('delivers committed events with cursors and typing without one', async () => {
    const reader = await m.client(mara);
    const writer = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 'general', topics: [`conv:${IDS.general}`] });
    const subscribed = await reader.waitFor((x) => x.t === 'subscribed');
    expect(subscribed).toMatchObject({ sub: 'general', denied: [] });
    await writer.request('messages.send', send('first live'));
    const event = (await reader.waitFor(
      (x) => x.t === 'event' && (x as unknown as EventMsg).event.message?.text === 'first live',
    )) as unknown as EventMsg;
    expect(event).toMatchObject({ ephemeral: false, topic: `conv:${IDS.general}` });
    expect(parseCursor(event.cursor as string)).not.toBeNull();
    // The agent thinking: the one typing there is (people's typing went, one-person.md OP-S14).
    m.t.services.typing.start({ conversationId: IDS.general, threadRootId: null, principalId: IDS.dusty });
    const typing = (await reader.waitFor(
      (x) => x.t === 'event' && (x as unknown as EventMsg).event.type === 'typing',
    )) as unknown as EventMsg;
    expect(typing.ephemeral).toBe(true);
    expect(typing.cursor).toBeUndefined();
  });

  it('resumes after a cursor: what was missed arrives in order, nothing twice', async () => {
    const reader = await m.client(mara);
    const writer = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 's1', topics: [`conv:${IDS.general}`] });
    const { cursor } = (await reader.waitFor((x) => x.t === 'subscribed')) as { cursor: string };
    reader.close();
    await writer.request('messages.send', send('missed one'));
    await writer.request('messages.send', send('missed two'));
    await m.runtime.events.flushed();
    const again = await m.client(mara);
    again.send({ t: 'subscribe', sub: 's2', topics: [`conv:${IDS.general}`], after: cursor });
    await again.waitFor((x) => x.t === 'subscribed');
    await writer.request('messages.send', send('live after resume'));
    await again.waitFor(
      (x) => x.t === 'event' && (x as unknown as EventMsg).event.message?.text === 'live after resume',
    );
    expect(texts(again.received)).toEqual(['missed one', 'missed two', 'live after resume']);
  });

  it('authorizes topics like /ws: a room that doesn’t exist is denied', async () => {
    const reader = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 'mixed', topics: [`conv:${IDS.general}`, 'conv:cnv_nope'] });
    const subscribed = (await reader.waitFor((x) => x.t === 'subscribed')) as {
      denied: { topic: string; reason: string }[];
    };
    expect(subscribed.denied).toEqual([{ topic: 'conv:cnv_nope', reason: 'not_found' }]);
  });

  it('gives the person’s devices every room, one nobody was added to as well, and another account none', async () => {
    const room = await makeRoom(m.t.services, m.t.burrowId, 'feat/no-members');
    const reader = await m.client(mara);
    reader.send({ t: 'subscribe', sub: 'room', topics: [`conv:${room}`] });
    expect(await reader.waitFor((x) => x.t === 'subscribed')).toMatchObject({ sub: 'room', denied: [] });
    // An enrolled device of an account that isn't the person's (nobody else uses the box, one-person.md OP-01).
    const stranger = testIdentity();
    const accountId = newId('account');
    await m.t.services.db.insert(accounts).values({ id: accountId, email: 'stranger@example.com' });
    await m.t.services.db.insert(applianceEndpoints).values({
      id: localId('ep'),
      peerId: stranger.peerId,
      publicKey: stranger.publicKey,
      accountId,
      label: 'stranger test',
      platform: 'web',
      enrolledVia: 'pairing',
    });
    const other = await m.client(stranger);
    other.send({ t: 'subscribe', sub: 'theirs', topics: [`conv:${room}`, `burrow:${m.t.burrowId}`] });
    const refused = (await other.waitFor((x) => x.t === 'subscribed')) as {
      denied: { topic: string; reason: string }[];
    };
    expect(refused.denied.map((d) => d.reason)).toEqual(['not_member', 'not_member']);
    const writer = await m.client(phone);
    await writer.request('messages.send', send('in a room nobody joined', room));
    await reader.waitFor(
      (x) => x.t === 'event' && (x as unknown as EventMsg).event.message?.text === 'in a room nobody joined',
    );
    await m.runtime.events.flushed();
    expect(texts(other.received)).toEqual([]);
  });

  it('answers snapshot_required once the cursor fell out of retention, then resumes from the new cursor', async () => {
    const reader = await m.client(mara);
    reader.send({ t: 'subscribe', sub: 'old', topics: [`conv:${IDS.general}`] });
    const { cursor } = (await reader.waitFor((x) => x.t === 'subscribed')) as { cursor: string };
    reader.close();
    const writer = await m.client(phone);
    for (let i = 0; i < 3; i++) await writer.request('messages.send', send(`churn ${i}`));
    await m.runtime.events.flushed();
    // Retention by age: everything older than now goes (the floor moves past the old cursor).
    const events = m.runtime.events as unknown as { options: { maxAgeMs: number } };
    const before = events.options.maxAgeMs;
    events.options.maxAgeMs = 0;
    try {
      expect(await m.runtime.events.sweep(new Date(Date.now() + 1000))).toBeGreaterThan(0);
    } finally {
      events.options.maxAgeMs = before;
    }
    const again = await m.client(mara);
    again.send({ t: 'subscribe', sub: 'old', topics: [`conv:${IDS.general}`], after: cursor });
    const snap = (await again.waitFor((x) => x.t === 'snapshot_required' || x.t === 'subscribed')) as {
      t: string;
      reason: string;
      cursor: string;
    };
    expect(snap).toMatchObject({ t: 'snapshot_required', reason: 'cursor_expired' });
    // Refetch the snapshot (here: nothing), then subscribe after the cursor it gave.
    again.send({ t: 'subscribe', sub: 'old', topics: [`conv:${IDS.general}`], after: snap.cursor });
    await again.waitFor((x) => x.t === 'subscribed');
    await writer.request('messages.send', send('after the snapshot'));
    await again.waitFor(
      (x) => x.t === 'event' && (x as unknown as EventMsg).event.message?.text === 'after the snapshot',
    );
  });

  it('answers snapshot_required for another epoch (restart) and another authorization generation', async () => {
    const reader = await m.client(mara);
    const head = m.runtime.events.cursor(0);
    const parsed = parseCursor(head);
    const restarted = formatCursor({ ...(parsed as NonNullable<typeof parsed>), epoch: 'otherEpoch' });
    reader.send({ t: 'subscribe', sub: 'r', topics: [`conv:${IDS.general}`], after: restarted });
    expect(await reader.waitFor((x) => x.t === 'snapshot_required')).toMatchObject({ reason: 'restart' });
    // Mara's authorization moves (e.g. an endpoint of hers revoked): an old-generation cursor needs a snapshot.
    await m.t.services.db.update(accounts).set({ authzGeneration: 5 }).where(eq(accounts.id, mara.accountId));
    const fresh = await m.client(mara);
    fresh.send({ t: 'subscribe', sub: 'g', topics: [`conv:${IDS.general}`], after: head });
    expect(await fresh.waitFor((x) => x.t === 'snapshot_required')).toMatchObject({
      reason: 'authz_changed',
    });
    await m.t.services.db.update(accounts).set({ authzGeneration: 0 }).where(eq(accounts.id, mara.accountId));
  });
});

describe('live events during a slow replay', () => {
  it('removes a replay registration if enriching its event fails', async () => {
    const events = m.runtime.events;
    const room = await makeRoom(m.t.services, m.t.burrowId, 'replay-failure');
    const topic = `conv:${room}`;
    await events.flushed();
    const after = events.cursor(0);
    m.t.services.bus.publish({
      topic,
      event: { type: 'conversation.unread', conversationId: room, unread: 1, mentions: 0 },
      eventId: null,
      at: m.t.services.clock().toISOString(),
      outboxId: null,
    });
    await events.flushed();
    const send = vi.fn();
    const overflow = vi.fn();
    const fill = vi.spyOn(frameFilling, 'fillFrame').mockRejectedValueOnce(new Error('database unavailable'));
    try {
      await expect(
        events.subscribe(
          { accountId: mara.accountId, generation: 0, send, overflow },
          { id: 'failed-replay', topics: [topic], after },
        ),
      ).rejects.toThrow('database unavailable');
    } finally {
      fill.mockRestore();
    }
    // A failed replay has nobody left to close it. Live events must not accumulate in an orphaned buffer.
    for (let i = 0; i <= MAX_PENDING_PER_SUBSCRIPTION; i++)
      m.t.services.bus.publish({
        topic,
        event: {
          type: 'typing',
          conversationId: room,
          threadRootId: null,
          principalId: IDS.dusty,
          active: true,
          expiresAt: m.t.services.clock().toISOString(),
        },
        eventId: null,
        at: m.t.services.clock().toISOString(),
        outboxId: null,
      });
    await events.flushed();
    expect(overflow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('requests a fresh snapshot if a live event cannot be enriched, instead of silently skipping it', async () => {
    const events = m.runtime.events;
    const room = await makeRoom(m.t.services, m.t.burrowId, 'delivery-failure');
    const topic = `conv:${room}`;
    await events.flushed();
    const send = vi.fn();
    const overflow = vi.fn();
    const sub = await events.subscribe(
      { accountId: mara.accountId, generation: 0, send, overflow },
      { id: 'failed-delivery', topics: [topic], after: null },
    );
    const fill = vi.spyOn(frameFilling, 'fillFrame').mockRejectedValueOnce(new Error('database unavailable'));
    try {
      m.t.services.bus.publish({
        topic,
        event: { type: 'conversation.unread', conversationId: room, unread: 1, mentions: 0 },
        eventId: null,
        at: m.t.services.clock().toISOString(),
        outboxId: null,
      });
      await events.flushed();
      expect(send).not.toHaveBeenCalled();
      expect(overflow).toHaveBeenCalledExactlyOnceWith('failed-delivery', events.cursor(0));
    } finally {
      fill.mockRestore();
      sub.close();
    }
  });

  it.each([
    { liveCount: MAX_PENDING_PER_SUBSCRIPTION, replayCount: 1, overflows: false },
    { liveCount: MAX_PENDING_PER_SUBSCRIPTION + 1, replayCount: 501, overflows: true },
  ])(
    'bounds $liveCount buffered events and keeps other subscribers moving',
    async ({ liveCount, replayCount, overflows }) => {
      const events = m.runtime.events;
      const topic = `me:${IDS.mara}`;
      const after = events.cursor(0);
      for (let i = 0; i < replayCount; i++)
        m.t.services.bus.publish({
          topic,
          event: { type: 'conversation.unread', conversationId: IDS.general, unread: i, mentions: 0 },
          eventId: null,
          at: m.t.services.clock().toISOString(),
          outboxId: null,
        });
      await events.flushed();
      const send = vi.fn();
      const overflow = vi.fn();
      const healthySend = vi.fn();
      const healthyOverflow = vi.fn();
      const healthy = await events.subscribe(
        { accountId: mara.accountId, generation: 0, send: healthySend, overflow: healthyOverflow },
        { id: 'healthy-replay-neighbor', topics: [topic], after: null },
      );
      let entered!: () => void;
      let release!: () => void;
      const replayEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const replayReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = frameFilling.fillFrame;
      const fill = vi.spyOn(frameFilling, 'fillFrame').mockImplementation(async (...args) => {
        if (args[1].type === 'conversation.unread') {
          entered();
          await replayReleased;
        }
        return original(...args);
      });
      const replay = events.subscribe(
        { accountId: mara.accountId, generation: 0, send, overflow },
        { id: 'slow-replay', topics: [topic], after },
      );
      try {
        await replayEntered;
        for (let i = 0; i < liveCount; i++) {
          m.t.services.bus.publish({
            topic,
            event: {
              type: 'typing',
              conversationId: IDS.general,
              threadRootId: null,
              principalId: IDS.dusty,
              active: true,
              expiresAt: m.t.services.clock().toISOString(),
            },
            eventId: null,
            at: m.t.services.clock().toISOString(),
            outboxId: null,
          });
          await events.flushed();
        }
        expect(healthySend).toHaveBeenCalledTimes(liveCount);
        expect(healthyOverflow).not.toHaveBeenCalled();
        expect(overflow).toHaveBeenCalledTimes(overflows ? 1 : 0);
      } finally {
        release();
        const result = await replay;
        await events.flushed();
        result.close();
        healthy.close();
        fill.mockRestore();
      }
      if (overflows) {
        expect(overflow).toHaveBeenCalledWith('slow-replay', events.cursor(0));
        expect(send).not.toHaveBeenCalled();
      } else {
        expect(send).toHaveBeenCalledTimes(replayCount + liveCount);
        expect(send.mock.calls[0]?.[0].event.type).toBe('conversation.unread');
        expect(send.mock.calls.slice(replayCount).every(([event]) => event.ephemeral)).toBe(true);
      }
    },
  );
});

describe('events too large for a session message (box-health.md BH-03, BH-04)', () => {
  const topic = `conv:${IDS.general}`;
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /** A pull request of 500 files, as the one on John's box (≈85 KB): more than a session message holds. */
  const publishBig = (type = 'pr.updated') =>
    m.t.services.bus.publish({
      topic,
      event: {
        type,
        pr: {
          id: 'pr_big',
          title: 'Consolidate all development branches into main',
          files: Array.from({ length: 500 }, (_, i) => ({
            path: `src/module-${i}/index.ts`,
            patch: 'x'.repeat(150),
          })),
        },
      } as never,
      eventId: null,
      at: new Date().toISOString(),
      outboxId: null,
    });
  const of = (c: TestSessionClient, sub: string, t?: string) =>
    c.received.filter((x) => (x as { sub?: string }).sub === sub && (!t || x.t === t));
  /** The next message from now on that matches. */
  const next = (c: TestSessionClient, pred: (x: TestSessionClient['received'][number]) => boolean) => {
    const from = c.received.length;
    return c.waitFor((x) => c.received.indexOf(x) >= from && pred(x));
  };
  /** Everything the session sent before now has reached the client. */
  const settled = async (c: TestSessionClient, n: number) => {
    await m.runtime.events.flushed();
    c.send({ t: 'ping', n });
    await c.waitFor((x) => x.t === 'pong' && (x as { n: number }).n === n);
  };

  it('drops the subscription with snapshot_required at that event’s cursor; a subscribe after it resumes', async () => {
    const warn = vi.spyOn(m.t.services.log, 'warn');
    const reader = await m.client(mara);
    const writer = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 'big', topics: [topic] });
    const subscribed = (await reader.waitFor((x) => x.t === 'subscribed' && x.sub === 'big')) as {
      cursor: string;
    };
    publishBig();
    const snap = (await reader.waitFor((x) => x.t === 'snapshot_required' && x.sub === 'big')) as {
      reason: string;
      cursor: string;
    };
    expect(snap.reason).toBe('overflow');
    expect(parseCursor(snap.cursor)?.id).toBeGreaterThan(parseCursor(subscribed.cursor)?.id ?? 0);
    expect(of(reader, 'big', 'event')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr.updated', topic, bytes: expect.any(Number) }),
      'session event too large for a session message; the client reloads that view',
    );
    const bytes = (warn.mock.calls.find((c) => (c[0] as { type?: string }).type === 'pr.updated')?.[0] ??
      {}) as {
      bytes: number;
    };
    expect(bytes.bytes).toBeGreaterThan(64 * 1024);
    // Nothing more for that subscription: the next event reaches only a subscription made after it.
    await writer.request('messages.send', send('after the big one'));
    await settled(reader, 1);
    expect(of(reader, 'big', 'event')).toEqual([]);
    // The client refetches the view, then subscribes after the cursor it was given: what came after arrives, the big
    // event doesn't again.
    const resubscribed = next(reader, (x) => x.t === 'subscribed' && x.sub === 'big');
    reader.send({ t: 'subscribe', sub: 'big', topics: [topic], after: snap.cursor });
    await resubscribed;
    expect(texts(of(reader, 'big'))).toEqual(['after the big one']);
    expect(of(reader, 'big', 'snapshot_required')).toHaveLength(1);
    await writer.request('messages.send', send('live again'));
    await reader.waitFor(
      (x) =>
        x.t === 'event' && x.sub === 'big' && (x as unknown as EventMsg).event.message?.text === 'live again',
    );
  });

  it('an ephemeral event too large is dropped with a warning and the subscription goes on', async () => {
    const warn = vi.spyOn(m.t.services.log, 'warn');
    const reader = await m.client(mara);
    const writer = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 'typing', topics: [topic] });
    await reader.waitFor((x) => x.t === 'subscribed' && x.sub === 'typing');
    publishBig('typing');
    await writer.request('messages.send', send('still subscribed'));
    await reader.waitFor(
      (x) =>
        x.t === 'event' &&
        x.sub === 'typing' &&
        (x as unknown as EventMsg).event.message?.text === 'still subscribed',
    );
    expect(of(reader, 'typing', 'snapshot_required')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typing', topic }),
      'ephemeral session event too large for a session message; dropped',
    );
  });
});

describe('subscribes of one subscription id are ordered (BH-05)', () => {
  const topic = `conv:${IDS.general}`;
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /** Holds the first `events.subscribe` until released; answers when it was entered. */
  const holdFirstSubscribe = () => {
    const events = m.runtime.events;
    const original = events.subscribe.bind(events);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    let calls = 0;
    vi.spyOn(events, 'subscribe').mockImplementation(async (subscriber, input) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return original(subscriber, input);
    });
    return { release, inside };
  };
  const eventsOf = (c: TestSessionClient, sub: string) =>
    c.received.filter(
      (x) => x.t === 'event' && x.sub === sub && (x as unknown as EventMsg).event.type === 'message.created',
    );

  it('a subscribe superseded by another of the same id while it is answered registers nothing and sends nothing', async () => {
    const hold = holdFirstSubscribe();
    const reader = await m.client(mara);
    const writer = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 'dup', topics: [topic] });
    await hold.inside;
    reader.send({ t: 'subscribe', sub: 'dup', topics: [topic] });
    await reader.waitFor((x) => x.t === 'subscribed' && x.sub === 'dup');
    hold.release();
    await writer.request('messages.send', send('once only'));
    await reader.waitFor((x) => x.t === 'event' && x.sub === 'dup');
    await m.runtime.events.flushed();
    reader.send({ t: 'ping', n: 7 });
    await reader.waitFor((x) => x.t === 'pong');
    expect(texts(eventsOf(reader, 'dup'))).toEqual(['once only']);
    expect(reader.received.filter((x) => x.t === 'subscribed' && x.sub === 'dup')).toHaveLength(1);
  });

  it('an unsubscribe while its subscribe is answered closes it', async () => {
    const hold = holdFirstSubscribe();
    const reader = await m.client(mara);
    const writer = await m.client(phone);
    reader.send({ t: 'subscribe', sub: 'gone', topics: [topic] });
    await hold.inside;
    reader.send({ t: 'unsubscribe', sub: 'gone' });
    reader.send({ t: 'ping', n: 8 });
    await reader.waitFor((x) => x.t === 'pong');
    hold.release();
    // Another subscription on the same topic shows the event went out.
    reader.send({ t: 'subscribe', sub: 'other', topics: [topic] });
    await reader.waitFor((x) => x.t === 'subscribed' && x.sub === 'other');
    await writer.request('messages.send', send('not for gone'));
    await reader.waitFor((x) => x.t === 'event' && x.sub === 'other');
    await m.runtime.events.flushed();
    reader.send({ t: 'ping', n: 9 });
    await reader.waitFor((x) => x.t === 'pong' && (x as { n: number }).n === 9);
    expect(reader.received.filter((x) => (x as { sub?: string }).sub === 'gone')).toEqual([]);
  });
});

describe('resume decisions', () => {
  const now = { epoch: 'abcd', generation: 2, floor: 10 };
  it('is pure and total', () => {
    expect(resumeDecision(null, now)).toEqual({ fresh: true });
    expect(resumeDecision('garbage', now)).toEqual({ snapshot: 'cursor_expired' });
    expect(resumeDecision(formatCursor({ epoch: 'zzzz', generation: 2, id: 50 }), now)).toEqual({
      snapshot: 'restart',
    });
    expect(resumeDecision(formatCursor({ epoch: 'abcd', generation: 1, id: 50 }), now)).toEqual({
      snapshot: 'authz_changed',
    });
    expect(resumeDecision(formatCursor({ epoch: 'abcd', generation: 2, id: 9 }), now)).toEqual({
      snapshot: 'cursor_expired',
    });
    expect(resumeDecision(formatCursor({ epoch: 'abcd', generation: 2, id: 10 }), now)).toEqual({
      resume: 10,
    });
  });
});
