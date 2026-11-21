/**
 * Both shipped templates end to end on a real database, with FAKE AGENTS (test/automations.ts): the suspected-bug
 * template pauses for a person's approval, survives a restart and does not replay what it already did; the
 * scheduled repository check posts a report only when the agent's answer is actionable.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { approvals, automations, pullRequests } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';

const w = useAutomationWorld();
const BILLING = IDS.billing;

async function waitingDispatch(runId: string, stepId: string) {
  const run = await w.run(runId);
  const step = run.steps.find((s) => s.stepId === stepId);
  if (!step?.dispatchId || step.state !== 'waiting') throw new Error(`step ${stepId} is ${step?.state}`);
  return step.dispatchId;
}

describe('the “Suspected bug” template', () => {
  it('investigates, waits for approval across a restart, then fixes, reviews and prepares the PR once', async () => {
    const automationId = await w.publishTemplate(
      {
        template: 'suspected_bug',
        conversationId: BILLING,
        repo: 'whombat/billing',
      },
      { grants: [{ keyId: 'pr.open', tier: 'can', repos: ['whombat/billing'] }] },
    );
    const [automation] = await w.services.db
      .select()
      .from(automations)
      .where(eq(automations.id, automationId));
    const principalId = automation?.principalId as string;

    // A person reports a bug in the channel.
    await w.ok(IDS.mara, sendMessage, {
      conversationId: BILLING,
      text: 'The invoice PDF is broken for Belgian VAT',
    });
    await w.settle();
    let [run] = await w.runs(automationId);
    expect(run?.trigger.kind).toBe('message_posted');
    expect(run?.steps[0]?.state).toBe('waiting');
    const runId = run?.id as string;

    // FAKE AGENT: the investigator answers in the thread.
    await w.fakeAgentReply(
      await waitingDispatch(runId, 'investigate'),
      'Rounding happens after formatting in pdf.ts.',
    );
    await w.settle();
    run = await w.run(runId);
    expect(run.steps.map((s) => s.state)).toEqual([
      'succeeded',
      'succeeded',
      'waiting',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(run.status).toBe('waiting');
    const approvalId = run.steps[2]?.approvalId as string;
    const [approval] = await w.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.state).toBe('pending');
    expect(approval?.actionHash).toMatch(/^[0-9a-f]{64}$/);

    // Crash and restart: a new server and engine on the same database.
    const beforeMessages = (await w.messagesBy(principalId)).length;
    const beforeDispatches = (await w.dispatchesOf('automation')).length;
    await w.restart();
    await w.services.automations.bootRecovery();
    await w.settle();
    expect((await w.messagesBy(principalId)).length).toBe(beforeMessages);
    expect((await w.dispatchesOf('automation')).length).toBe(beforeDispatches);

    // A person approves: the run continues (the approval runs the automation's continue step).
    await w.ok(IDS.mara, decideApproval, { number: approval?.number as number, decision: 'approve' });
    await w.settle();
    run = await w.run(runId);
    expect(run.steps[2]?.state).toBe('succeeded');
    expect(run.steps[2]?.output.decision).toBe('approved');
    // FAKE AGENT at work: its commits reach GitHub (the runner pushes them), then it replies.
    const implementing = await waitingDispatch(runId, 'implement');
    await w.fakePush('whombat/billing', `feat/bug-${run.number}`, 'Round before formatting');
    await w.fakeAgentReply(implementing, 'Fixed: rounding before formatting, with a test.');
    await w.settle();
    run = await w.run(runId);
    expect(run.steps[3]?.output.commits).toBe(1);
    await w.fakeAgentReply(await waitingDispatch(runId, 'review'), 'Approve. Rounds first, and has a test.');
    await w.settle();

    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.steps.every((s) => s.state === 'succeeded')).toBe(true);
    expect(run.steps[4]?.output.verdict).toBe('approve');
    const pr = run.steps[6];
    expect(pr?.prNumber).toBeGreaterThan(0);
    const [opened] = await w.services.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.number, pr?.prNumber as number));
    expect(opened?.branch).toBe(`feat/bug-${run.number}`);
    expect(opened?.authorId).toBe(principalId);

    // Every effect happened exactly once: 3 turns of the agent, one per step (the review a fresh one, OA-15), and the
    // automation's posts in the run's room, Mara's Chat (3 prompts, evidence, report).
    const dispatched = (await w.dispatchesOf('automation')).filter((d) =>
      run.steps.some((s) => s.dispatchId === d.id),
    );
    expect(dispatched.map((d) => d.agentId)).toEqual([IDS.dusty, IDS.dusty, IDS.dusty]);
    expect(new Set(dispatched.map((d) => d.id)).size).toBe(3);
    expect(run.conversationId).toBe(IDS.dmDusty);
    const posts = (await w.messagesBy(principalId)).filter((m) => m.conversationId === run.conversationId);
    expect(posts.filter((m) => m.text.startsWith('@Dusty'))).toHaveLength(3);
    expect(posts.filter((m) => m.text.startsWith('Here’s what the investigation found'))).toHaveLength(1);
    expect(posts.filter((m) => m.text.startsWith('Done: PR #'))).toHaveLength(1);
    // The report is in the run's thread.
    const report = posts.find((m) => m.text.startsWith('Done: PR #'));
    expect(report?.threadRootId).toBe(run.threadRootId);
  });

  it('stops when a person declines, and the fix is never asked for', async () => {
    const automationId = await w.publishTemplate({
      template: 'suspected_bug',
      conversationId: BILLING,
      repo: 'whombat/billing',
      keywords: ['regression'],
    });
    await w.ok(IDS.mara, sendMessage, {
      conversationId: BILLING,
      text: 'Looks like a regression in totals',
    });
    await w.settle();
    const [run] = await w.runs(automationId);
    await w.fakeAgentReply(
      await waitingDispatch(run?.id as string, 'investigate'),
      'Totals double-count discounts.',
    );
    await w.settle();
    const waiting = await w.run(run?.id as string);
    await w.ok(IDS.mara, decideApproval, {
      number: waiting.steps[2]?.approvalNumber as number,
      decision: 'decline',
    });
    await w.settle();
    const done = await w.run(run?.id as string);
    expect(done.status).toBe('cancelled');
    expect(done.error).toBe('Mara declined, so it stopped.');
    expect(done.steps[2]?.output.decision).toBe('declined');
    expect(done.steps.slice(3).every((s) => s.state === 'pending' || s.state === 'cancelled')).toBe(true);
    expect(done.steps[3]?.dispatchId).toBeNull();
  });
});

describe('the “Scheduled repository check” template', () => {
  it('asks on schedule and reports only when there is something to act on', async () => {
    w.setNow('2026-09-28T06:30:00.000Z'); // Monday 08:30 in Amsterdam
    const automationId = await w.publishTemplate({
      template: 'repo_check',
      conversationId: IDS.general,
      agentConversationId: BILLING,
      repo: 'whombat/billing',
    });
    const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
    expect(a?.nextFireAt?.toISOString()).toBe('2026-09-28T07:00:00.000Z');
    const principalId = a?.principalId as string;

    await w.settle();
    expect(await w.runs(automationId)).toHaveLength(0);

    // 09:00 Monday: the check runs; the agent finds something.
    w.setNow('2026-09-28T07:00:05.000Z');
    await w.settle();
    let runs = await w.runs(automationId);
    expect(runs).toHaveLength(1);
    await w.fakeAgentReply(
      runs[0]?.steps[0]?.dispatchId as string,
      'ACTIONABLE: checks fail on main (2 tests).',
    );
    await w.settle();
    runs = await w.runs(automationId);
    expect(runs[0]?.status).toBe('succeeded');
    expect(runs[0]?.steps.map((s) => s.state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const reports = (await w.messagesBy(principalId)).filter((m) => m.conversationId === IDS.general);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('Repository check for whombat/billing');

    // 09:00 Tuesday: nothing to report, so nothing is posted.
    w.setNow('2026-09-29T07:00:05.000Z');
    await w.settle();
    runs = await w.runs(automationId);
    expect(runs).toHaveLength(2);
    await w.fakeAgentReply(runs[1]?.steps[0]?.dispatchId as string, 'NOTHING TO REPORT');
    await w.settle();
    runs = await w.runs(automationId);
    expect(runs[1]?.status).toBe('succeeded');
    expect(runs[1]?.steps.map((s) => s.state)).toEqual(['succeeded', 'succeeded', 'skipped']);
    expect(runs[1]?.steps[1]?.output.result).toBe(false);
    expect((await w.messagesBy(principalId)).filter((m) => m.conversationId === IDS.general)).toHaveLength(1);
  });
});
