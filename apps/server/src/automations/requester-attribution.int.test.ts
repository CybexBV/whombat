/**
 * The person's work is the person's (docs/decisions/provider-subscriptions.md SUB-27…SUB-31; security review
 * REQ-1…REQ-6; one-person.md OP-S41): Run now and Resume run for the person, and an approved key request wakes the
 * agent for the person it asked for.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { decideApproval, requestApproval } from '../commands/approvals';
import { pauseRun, resumeRun } from '../commands/runs';
import {
  approvals,
  automationRunSteps,
  dispatches,
  grants,
  messages,
  principals,
  runs,
} from '../db/schema/index';
import { runInDispatchScope } from '../runtime/dispatch-scope';
import { TEST_BURROW_ID } from '../seed/test-world';
import { IDS, useAutomationWorld } from '../test/automations';
import { runAutomationNow } from './commands';

const w = useAutomationWorld({ env: { WHOMBAT_MODE: 'managed' } });

const manual = (_agentId: string) =>
  ({
    version: 1,
    conversationId: IDS.general,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'ask', kind: 'dispatch_agent', prompt: 'Status? {{trigger.text}}' }],
  }) as AutomationDefinitionInput;

async function setSource(agentId: string, source: unknown) {
  const [row] = await w.services.db.select().from(principals).where(eq(principals.id, agentId));
  await w.services.db
    .update(principals)
    .set({ runtime: { ...(row?.runtime ?? {}), credentialSource: source } as never })
    .where(eq(principals.id, agentId));
}

const acct = async (id: string) =>
  (await w.services.db.select().from(principals).where(eq(principals.id, id)))[0]?.accountId ?? null;

/** The dispatch of a run's agent step, once the engine has started it. */
async function dispatchOfRun(runId: string | null) {
  if (!runId) throw new Error('no run');
  await w.settle();
  const [step] = await w.services.db
    .select({ dispatchId: automationRunSteps.dispatchId })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.runId, runId));
  if (!step?.dispatchId) throw new Error(`run ${runId} has no dispatch`);
  const [row] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, step.dispatchId));
  return row;
}

beforeEach(async () => {
  await w.services.db.delete(dispatches);
  await setSource(IDS.dusty, { kind: 'requester', fallback: null });
});

describe('Run now (REQ-1, SUB-27)', () => {
  it('the person’s Run now is their own request: the dispatch is for them', async () => {
    const id = await w.publish(manual(IDS.dusty), { by: IDS.mara, name: 'Status requester' });
    // The publisher's own Run now stays theirs.
    const mine = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false, text: 'mine' });
    const theirs = await dispatchOfRun(mine.runId);
    expect(theirs?.onBehalfOfAccountId).toBe(await acct(IDS.mara));
    await w.fakeAgentReply(theirs?.id ?? '', 'All fine.');
    await w.settle();
  });

  it('Run now on the person’s own sign-in is never refused, and is for them (OA-S17)', async () => {
    await setSource(IDS.dusty, { kind: 'member', accountId: await acct(IDS.mara) });
    const id = await w.publish(manual(IDS.dusty), { by: IDS.mara, name: 'Status on Mara' });
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false, text: 'x' });
    const dispatch = await dispatchOfRun(runId);
    expect(dispatch?.onBehalfOfAccountId).toBe(await acct(IDS.mara));
    await w.fakeAgentReply(dispatch?.id ?? '', 'All fine.');
    await w.settle();
  });
});

describe('an approved key request (REQ-5, SUB-28)', () => {
  it('records the person the agent asked for, and wakes it for them — not for the approver', async () => {
    const mara = await acct(IDS.mara);
    // Without it, nor “Use a web browser”, which brings it in, so it can ask for it.
    await w.services.db
      .delete(grants)
      .where(and(eq(grants.agentId, IDS.dusty), inArray(grants.keyId, ['web.browse', 'browser.use'])));
    const asked = await runInDispatchScope(
      { dispatchId: 'dsp_for_mara', agentId: IDS.dusty, onBehalfOfAccountId: mara },
      () =>
        w.ok(IDS.dusty, requestApproval, {
          conversationId: IDS.billing,
          action: { type: 'grant_key', params: { keyId: 'web.browse' } },
          whatHappens: ['Read the tax office’s page'],
          explainer: '',
          summary: '',
        }),
    );
    const [row] = await w.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    expect(row?.onBehalfOfAccountId).toBe(mara);

    await w.ok(IDS.mara, decideApproval, { number: asked.number, decision: 'approve' });
    const [reply] = await w.services.db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, asked.messageId))
      .orderBy(asc(messages.createdAt));
    expect(reply?.authorId).toBe(IDS.mara);
    expect(reply?.text).toContain('Browse the web');
    const [woken] = await w.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.messageId, reply?.id ?? '')));
    expect(woken?.onBehalfOfAccountId).toBe(mara);
  });
});

describe('resuming a paused run (REQ-3, SUB-29)', () => {
  it('the person’s Resume goes on for them', async () => {
    const [run] = await w.services.db.select().from(runs).limit(1);
    if (!run) throw new Error('no run in seed');
    const mara = await acct(IDS.mara);
    await w.services.db.insert(dispatches).values({
      id: 'dsp_origin_mara',
      burrowId: TEST_BURROW_ID,
      agentId: run.agentId,
      trigger: 'mention',
      mode: 'reply',
      conversationId: run.conversationId,
      state: 'done',
      onBehalfOfAccountId: mara,
      createdAt: w.now(),
    });
    await w.services.db
      .update(runs)
      .set({ status: 'live', dispatchId: 'dsp_origin_mara' })
      .where(eq(runs.id, run.id));
    const control = () =>
      w.services.db
        .select()
        .from(dispatches)
        .where(and(eq(dispatches.trigger, 'run_control'), eq(dispatches.state, 'queued')));

    await w.ok(IDS.mara, pauseRun, { number: run.number });
    await w.ok(IDS.mara, resumeRun, { number: run.number });
    expect((await control()).map((r) => r.onBehalfOfAccountId)).toEqual([mara]);
  });
});
