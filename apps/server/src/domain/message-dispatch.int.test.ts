/** Needs Postgres: message markers, resumed runs, signed queue events and jobs must survive or roll back together. */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { requestMore, sendMessage } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { dispatches, events, messages, runs } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true });
const jobs = (messageId: string) =>
  t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));
const input = (clientId: string) => ({
  conversationId: IDS.dmDusty,
  text: 'Please check the next invoice.',
  clientId,
});
const options = { burrowId: t.burrowId, actorId: IDS.mara };

const failBeforeCommit = defineCommand({
  name: 'test_message_rollback',
  schema: sendMessage.schema,
  async apply(tx, ctx, value) {
    const posted = await sendMessage.apply(tx, ctx, value);
    ctx.beforeCommit(async () => {
      throw new Error('database write interrupted');
    });
    return posted;
  },
});

/** A process dies just after the database commits, before any realtime or follow-up work runs. */
async function interruptPublish(work: () => Promise<unknown>) {
  const publish = t.services.bus.publish.bind(t.services.bus);
  t.services.bus.publish = () => {
    throw new Error('process stopped after commit');
  };
  try {
    await expect(work()).rejects.toThrow('process stopped after commit');
  } finally {
    t.services.bus.publish = publish;
  }
}

describe('durable message dispatch', () => {
  it('rolls back the message, signed events and queued turn if a final write fails', async () => {
    await expect(
      t.services.pipeline.commit(failBeforeCommit, input('atomic-rollback'), options),
    ).rejects.toThrow('database write interrupted');
    expect(
      await t.services.db.select().from(messages).where(eq(messages.clientId, 'atomic-rollback')),
    ).toEqual([]);
    const retry = await t.services.pipeline.commit(sendMessage, input('atomic-rollback'), options);
    if (retry.status !== 'ok') throw new Error(retry.status);
    expect(await jobs(retry.result.id)).toHaveLength(1);
    const signed = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'dispatch.created')));
    const queued = (await jobs(retry.result.id))[0];
    expect(signed.find((e) => e.payload.dispatchId === queued?.id)?.id).toBeOneOf(retry.eventIds);
  });

  it('keeps the job after a post-commit interruption; the same client id never queues it twice', async () => {
    await interruptPublish(() => t.services.pipeline.commit(sendMessage, input('atomic-retry'), options));
    const [saved] = await t.services.db.select().from(messages).where(eq(messages.clientId, 'atomic-retry'));
    expect(saved).toBeDefined();
    expect(await jobs(saved?.id ?? '')).toHaveLength(1);
    const retried = await t.services.pipeline.commit(sendMessage, input('atomic-retry'), options);
    expect(retried).toMatchObject({ status: 'ok', result: { id: saved?.id } });
    expect(await jobs(saved?.id ?? '')).toHaveLength(1);
  });

  it('keeps More detail’s marker and job together across interruption and retry', async () => {
    const posted = await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: 'Use the invoice cache.',
      more: 'The reasons and tradeoffs.',
    });
    if (posted.status !== 'ok') throw new Error(posted.status);
    const messageId = posted.result.id;
    await interruptPublish(() => t.services.pipeline.commit(requestMore, { messageId }, options));
    const [saved] = await t.services.db.select().from(messages).where(eq(messages.id, messageId));
    expect(saved?.more?.requestedById).toBe(IDS.mara);
    expect(await jobs(messageId)).toMatchObject([{ trigger: 'expand', state: 'queued' }]);
    await t.services.pipeline.commit(requestMore, { messageId }, options);
    expect(await jobs(messageId)).toHaveLength(1);
  });

  it('commits the answer, cleared attention and resumed run job together', async () => {
    const runId = 'run_atomic_answer';
    await t.services.pipeline.transact(t.burrowId, async ({ tx }) => {
      await tx.insert(runs).values({
        id: runId,
        burrowId: t.burrowId,
        number: 9990,
        agentId: IDS.dusty,
        title: 'Finish the invoice',
        branch: 'feat/invoice',
        status: 'live',
        askedById: IDS.mara,
        conversationId: IDS.billing,
        startedAt: new Date(),
        attention: 'Which invoice?',
      });
    });
    const answer = { conversationId: IDS.billing, text: 'Invoice 8812.', clientId: 'atomic-answer' };
    await expect(t.services.pipeline.commit(failBeforeCommit, answer, options)).rejects.toThrow(
      'database write interrupted',
    );
    expect((await t.services.db.select().from(runs).where(eq(runs.id, runId)))[0]?.attention).toBe(
      'Which invoice?',
    );
    await interruptPublish(() => t.services.pipeline.commit(sendMessage, answer, options));
    const [saved] = await t.services.db.select().from(messages).where(eq(messages.clientId, 'atomic-answer'));
    expect((await t.services.db.select().from(runs).where(eq(runs.id, runId)))[0]?.attention).toBeNull();
    expect(await jobs(saved?.id ?? '')).toMatchObject([{ mode: 'run', runId, state: 'queued' }]);
    await t.services.pipeline.commit(sendMessage, answer, options);
    expect(await jobs(saved?.id ?? '')).toHaveLength(1);
  });
});

describe('what a reply reads in its commit', () => {
  /** The statements of the commit's own transaction (postgres.js's `debug` hook on the suite's pool). */
  async function inCommit(work: () => Promise<unknown>): Promise<string[]> {
    const options = (t.services.sql as unknown as { options: { debug: unknown } }).options;
    const before = options.debug;
    const seen: string[] = [];
    options.debug = (_connection: number, query: string) => seen.push(query);
    try {
      await work();
    } finally {
      options.debug = before;
    }
    const begin = seen.findIndex((q) => q.startsWith('select pg_advisory_xact_lock'));
    return seen.slice(begin, seen.indexOf('commit', begin));
  }

  it('reads the thread root and the room once while the person’s reply queues a turn', async () => {
    const root = await t.commit(IDS.mara, sendMessage, input('reads-root'));
    if (root.status !== 'ok') throw new Error(root.status);
    // Its turn is over, so the reply queues one of its own.
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.messageId, root.result.id));
    const seen = await inCommit(() =>
      t.services.pipeline.commit(
        sendMessage,
        { conversationId: IDS.dmDusty, text: 'And the one after.', threadRootId: root.result.id },
        options,
      ),
    );
    expect(seen.filter((q) => q.startsWith('insert into "dispatches"')).length).toBeGreaterThan(0);
    expect(seen.filter((q) => q.includes('from "messages" where "messages"."id" = $1'))).toHaveLength(1);
    expect(
      seen.filter((q) => q.includes('from "conversations" where "conversations"."id" = $1')),
    ).toHaveLength(1);
  });
});
