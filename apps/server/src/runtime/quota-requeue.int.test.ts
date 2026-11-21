/**
 * A usage limit doesn't end the task (docs/decisions/resourceful-agents.md RA-32, RA-DS11…RA-DS13): a turn that failed
 * for good with `usage_limit` and a reset time is queued again by the server a minute after the reset, once, the agent
 * saying it will carry on; a newer turn of the agent for the same person in the same place takes it over (the requeued
 * turn gives way at the claim), and no request rides on it.
 */
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sendMessage } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { dispatches, messages } from '../db/schema/index';
import { wakeQuietly } from '../domain/wake';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { buildDispatchContext } from './context';
import { REQUEUE_AFTER_RESET_MS } from './failure';

const t = useTestServer({ seed: true, listen: true });
const RUNNER = 'rnr_quota-test';

async function dispatchRow(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error('no dispatch');
  return row;
}

/** A person's message that wakes an agent: the queued dispatch it made. */
async function ask(by: string, conversationId: string, text: string, threadRootId?: string | null) {
  const res = await t.commit(by, sendMessage, {
    conversationId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error('send failed');
  const [row] = (await t.services.db.select().from(dispatches)).filter(
    (d) => d.messageId === res.result.id && d.state === 'queued',
  );
  if (!row) throw new Error('nothing queued');
  return row;
}

/** Ends a turn for good on a usage limit that resets at `resetsAt`, as the runner reports it. */
async function failOnLimit(id: string, resetsAt: Date) {
  await t.services.db
    .update(dispatches)
    .set({ state: 'running', runnerId: RUNNER, attempts: 2, claimedAt: new Date() })
    .where(eq(dispatches.id, id));
  await t.services.runtime.finalize(id, {
    outcome: 'failed',
    error: 'Claude AI usage limit reached',
    failure: { code: 'usage_limit', resetsAt: resetsAt.toISOString() },
  });
}

async function requeueOf(failedId: string) {
  return (await t.services.db.select().from(dispatches)).filter((d) => d.retryOfId === failedId);
}

describe('a usage limit', () => {
  it('queues the turn again a minute after the reset, once, and the agent says it will carry on', async () => {
    const asked = await ask(IDS.mara, IDS.dmDusty, 'Summarise the incidents of this week.');
    const resetsAt = new Date(Date.now() + 2 * 3600_000);
    await failOnLimit(asked.id, resetsAt);
    expect(await dispatchRow(asked.id)).toMatchObject({ state: 'failed', failure: { code: 'usage_limit' } });
    const [again] = await requeueOf(asked.id);
    expect(again).toMatchObject({
      state: 'queued',
      trigger: asked.trigger,
      requeuedFor: 'usage_limit',
      conversationId: IDS.dmDusty,
      messageId: asked.messageId,
      onBehalfOfAccountId: asked.onBehalfOfAccountId,
    });
    expect(again?.notBefore?.getTime()).toBe(resetsAt.getTime() + REQUEUE_AFTER_RESET_MS);
    // The agent's message says it carries on, with the Try again card as before.
    const failure = (await dispatchRow(asked.id)).failure;
    const [said] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, failure?.messageId ?? ''));
    expect(said?.text).toMatch(/It resets .+; I’ll carry on then\.$/);
    expect(said?.card).toMatchObject({ kind: 'turn_failed', code: 'usage_limit' });
    // Not claimable before the reset.
    expect(await t.services.runtime.claimOne(RUNNER, ['claude'])).toBeNull();
    // Once: the requeued turn failing on the limit again isn't queued a third time.
    await failOnLimit(again?.id as string, new Date(Date.now() + 3600_000));
    expect(await requeueOf(again?.id as string)).toEqual([]);
  });

  it('takes no quiet wake in: an approval granted meanwhile gets a turn now', async () => {
    const asked = await ask(IDS.mara, IDS.dmDusty, 'Rotate the backup key.');
    await failOnLimit(asked.id, new Date(Date.now() + 3 * 3600_000));
    const [again] = await requeueOf(asked.id);
    if (!again) throw new Error('not queued again');
    const wake = defineCommand({
      name: 'test_quiet_wake',
      schema: z.object({}),
      apply: (_tx, ctx) =>
        wakeQuietly(ctx, {
          agentId: asked.agentId,
          conversationId: asked.conversationId as string,
          threadRootId: asked.threadRootId,
          person: asked.onBehalfOfAccountId,
          trigger: 'approval_granted',
          coalesce: true,
          approvalId: 'approval_quota_test',
        }),
    });
    const res = await t.commit(IDS.mara, wake, {});
    const woken = res.status === 'ok' ? res.result : null;
    expect(woken).toMatchObject({ created: true });
    expect(woken?.dispatchId).not.toBe(again.id);
    expect(await dispatchRow(woken?.dispatchId as string)).toMatchObject({
      state: 'queued',
      approvalId: 'approval_quota_test',
      notBefore: null,
    });
    expect((await dispatchRow(again.id)).approvalId).toBeNull();
    // Out of the way of the next cases' claims.
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(inArray(dispatches.id, [again.id, woken?.dispatchId as string]));
  });

  it('gives way to a newer turn for the same person there, and takes no request in', async () => {
    const asked = await ask(IDS.mara, IDS.billing, '@Dusty fix the VAT rounding');
    await failOnLimit(asked.id, new Date(Date.now() - 60_000));
    const [again] = await requeueOf(asked.id);
    if (!again) throw new Error('not queued again');
    // Mara asks again in its thread (a new top-level ask would be another job, channel-threads.md CH-02): a turn of its
    // own, not merged into the waiting one.
    const newer = await ask(IDS.mara, IDS.billing, '@Dusty also check the totals', asked.threadRootId);
    expect(newer.id).not.toBe(again.id);
    // The reset passed: the claim cancels the waiting turn (the newer one reads the room as it is) and runs the newer.
    await t.services.db
      .update(dispatches)
      .set({ notBefore: new Date(Date.now() - 1000) })
      .where(eq(dispatches.id, again.id));
    const claimed = await t.services.runtime.claimOne(RUNNER, ['claude']);
    expect(claimed?.id).toBe(newer.id);
    expect(await dispatchRow(again.id)).toMatchObject({ state: 'cancelled', error: 'requeue_superseded' });
    await t.services.runtime.finalize(newer.id, { outcome: 'done' });
  });

  it('carries on after the reset when nothing newer came, told what it tries again', async () => {
    const asked = await ask(IDS.mara, IDS.incidents, '@Dusty check the staging disk');
    await failOnLimit(asked.id, new Date(Date.now() - 60_000));
    const [again] = await requeueOf(asked.id);
    if (!again) throw new Error('not queued again');
    await t.services.db
      .update(dispatches)
      .set({ notBefore: new Date(Date.now() - 1000) })
      .where(eq(dispatches.id, again.id));
    const claimed = await t.services.runtime.claimOne(RUNNER, ['claude']);
    expect(claimed?.id).toBe(again.id);
    const ctx = await buildDispatchContext(t.services, claimed as NonNullable<typeof claimed>);
    expect(ctx.retry).toMatchObject({ dispatchId: asked.id, code: 'usage_limit' });
    expect(ctx.trigger?.id).toBe(asked.messageId);
  });
});
