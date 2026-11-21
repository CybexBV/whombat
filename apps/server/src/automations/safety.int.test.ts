/**
 * The safety properties of supervised automations (docs/decisions/bp-automations.md), on a real database with FAKE
 * AGENTS (test/automations.ts): approval races and binding, authority re-checks, cancellation, schedule policies,
 * loop limits, escalation and crash recovery.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { UNCERTAIN_EXECUTION } from '../approvals/engine';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { approvals, automations, dispatches, events, pullRequests } from '../db/schema/index';
import { OutboundError, type OutboundInit, type OutboundResponse } from '../lib/outbound';
import { IDS, useAutomationWorld } from '../test/automations';
import {
  controlAutomationRun,
  publishAutomationDraft,
  reviewAutomationStep,
  runAutomationNow,
  saveAutomationDraft,
} from './commands';
import { acceptAutomationPlan, proposeAutomationPlan } from './plans';
import { STEP_IN_FLIGHT_MS, stepsInFlight } from './store';
import { NO_WEBHOOK_TRIGGER_TEXT } from './webhook-trigger';

// A stand-in for the receiver of `http_callback` steps: when a test sets `answer`, the engine's call gets it instead
// of going out, and every call's headers are kept. Everything else calls out as usual.
const receiver = vi.hoisted(() => ({
  answer: null as null | ((init: OutboundInit) => Promise<OutboundResponse>),
  calls: [] as Record<string, string>[],
}));
vi.mock('../lib/outbound', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/outbound')>();
  return {
    ...real,
    outboundRequest: (
      url: string,
      init: OutboundInit,
      policy?: Parameters<typeof real.outboundRequest>[2],
    ) => {
      if (!receiver.answer) return real.outboundRequest(url, init, policy);
      receiver.calls.push({ ...init.headers });
      return receiver.answer(init);
    },
  };
});
const answered = (status: number): Promise<OutboundResponse> =>
  Promise.resolve({ status, headers: {}, body: Buffer.from('{}') });

const w = useAutomationWorld();
const BILLING = IDS.billing;

const def = (steps: AutomationDefinitionInput['steps'], extra: Partial<AutomationDefinitionInput> = {}) =>
  ({
    version: 1,
    conversationId: BILLING,
    triggers: [{ kind: 'manual' }],
    steps,
    ...extra,
  }) as AutomationDefinitionInput;

async function start(automationId: string, by: string = IDS.mara) {
  const { runId } = await w.ok(by, runAutomationNow, { automationId, test: false });
  await w.settle();
  return runId as string;
}

async function approvalOf(runId: string, stepId: string) {
  const run = await w.run(runId);
  const step = run.steps.find((s) => s.stepId === stepId);
  const [row] = await w.services.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, step?.approvalId ?? ''));
  if (!row) throw new Error(`no approval on ${stepId}`);
  return row;
}

const APPROVE_THEN_POST = def([
  { id: 'approve', kind: 'request_approval', title: 'Go ahead?', details: 'It posts a note.' },
  { id: 'note', kind: 'post_message', text: 'Approved, going on.' },
]);

describe('approvals of automation steps', () => {
  it('two yeses at once: one decision, one continuation', async () => {
    const id = await w.publish(APPROVE_THEN_POST, { name: 'Race' });
    const runId = await start(id);
    const a = await approvalOf(runId, 'approve');
    // The card is in Mara's Chat, hers to decide (automations/rooms.ts): two of her devices answer at once.
    const results = await Promise.allSettled([
      w.ok(IDS.mara, decideApproval, { number: a.number, decision: 'approve' }),
      w.ok(IDS.mara, decideApproval, { number: a.number, decision: 'approve' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(
      /already been decided/,
    );
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    const continued = await w.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'automation.step.approved'), eq(events.approvalId, a.id)));
    expect(continued).toHaveLength(1);
    expect(run.steps[1]?.messageIds).toHaveLength(1);
  });

  it('approve racing cancel: the run stops and nothing after the approval happens', async () => {
    const id = await w.publish(APPROVE_THEN_POST, { name: 'Approve vs cancel' });
    const runId = await start(id);
    const a = await approvalOf(runId, 'approve');
    const run0 = await w.run(runId);
    await Promise.allSettled([
      w.ok(IDS.mara, decideApproval, { number: a.number, decision: 'approve' }),
      w.ok(IDS.mara, controlAutomationRun, { number: run0.number, action: 'cancel' }),
    ]);
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('cancelled');
    expect(run.steps[1]?.messageIds).toHaveLength(0);
    expect(run.steps[1]?.state).not.toBe('succeeded');
  });

  it('a new commit after the approval was asked for refuses it and asks again', async () => {
    const id = await w.publish(
      def([
        {
          id: 'approve',
          kind: 'request_approval',
          title: 'Ship feat/invoice-pdf?',
          details: 'It posts that it shipped.',
          bindBranch: { repo: 'whombat/billing', branch: 'feat/invoice-pdf' },
        },
        { id: 'note', kind: 'post_message', text: 'Shipped.' },
      ]),
      { name: 'Bound to a commit' },
    );
    const runId = await start(id);
    const first = await approvalOf(runId, 'approve');
    expect((first.actionBinding as { commitSha?: string }).commitSha).toBeTruthy();
    // The GitHub mirror sees a new head on the branch (simulated: the PR row moves).
    await w.services.db
      .update(pullRequests)
      .set({ headSha: 'feedfacefeedfacefeedfacefeedfacefeedface' })
      .where(eq(pullRequests.number, 482));
    await w.ok(IDS.mara, decideApproval, { number: first.number, decision: 'approve' });
    const [refused] = await w.services.db.select().from(approvals).where(eq(approvals.id, first.id));
    expect(refused?.execution.state).toBe('failed');
    expect(refused?.execution.error).toMatch(/changed since it was approved/);
    await w.settle();
    let run = await w.run(runId);
    expect(run.steps[0]?.state).toBe('waiting');
    expect(run.steps[0]?.attempt).toBe(1);
    expect(run.steps[1]?.state).toBe('pending');
    const second = await approvalOf(runId, 'approve');
    expect(second.id).not.toBe(first.id);
    expect((second.actionBinding as { commitSha?: string }).commitSha).toBe(
      'feedfacefeedfacefeedfacefeedfacefeedface',
    );
    await w.ok(IDS.mara, decideApproval, { number: second.number, decision: 'approve' });
    await w.settle();
    run = await w.run(runId);
    expect(run.status).toBe('succeeded');
  });

  it('an input changed behind the approval’s back is refused (the signed hash no longer matches)', async () => {
    const id = await w.publish(APPROVE_THEN_POST, { name: 'Tampered' });
    const runId = await start(id);
    const a = await approvalOf(runId, 'approve');
    await w.services.db.execute(
      sql`update approvals set command = jsonb_set(command, '{input,proposal,title}', '"Delete everything?"') where id = ${a.id}`,
    );
    await w.ok(IDS.mara, decideApproval, { number: a.number, decision: 'approve' });
    const [row] = await w.services.db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(row?.execution.state).toBe('failed');
    expect(row?.execution.error).toMatch(/not what was approved/);
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(run.steps[1]?.messageIds).toHaveLength(0);
  });
});

describe('authority', () => {
  it('a trigger from the person or an agent adds nothing: the automation’s own keys still decide', async () => {
    const steps: AutomationDefinitionInput['steps'] = [
      {
        id: 'pr',
        kind: 'open_pull_request',
        repo: 'whombat/billing',
        branch: 'feat/escalate',
        title: 'Escalate?',
        otherwise: 'fail',
      },
    ];
    const triggers = [
      {
        kind: 'message_posted' as const,
        conversationId: BILLING,
        contains: ['escalate-now'],
        includeAgents: true,
      },
    ];
    const limits = { runTimeoutMinutes: 60, maxConcurrentRuns: 2, maxRunsPerDay: 10 };
    const asks = await w.publish(def(steps, { triggers, limits }), {
      name: 'Asks to open',
      grants: [{ keyId: 'pr.open', tier: 'ask' }],
    });
    const none = await w.publish(def(steps, { triggers }), { name: 'No key' });
    await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: 'escalate-now (person)' });
    await w.ok(IDS.dusty, sendMessage, { conversationId: BILLING, text: 'escalate-now (agent)' });
    await w.settle();
    for (const run of await w.runs(asks)) {
      expect(run.steps[0]?.state).toBe('waiting');
      expect(run.steps[0]?.approvalId).toBeTruthy();
      expect(run.steps[0]?.prNumber).toBeNull();
    }
    const blocked = await w.runs(none);
    expect(blocked).toHaveLength(2);
    for (const run of blocked) expect(run.steps[0]?.state).toBe('blocked');
    const [pr] = await w.services.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.branch, 'feat/escalate'));
    expect(pr).toBeUndefined();
  });

  it('an agent can propose an automation but never turn it on', async () => {
    const proposed = await w.ok(IDS.dusty, proposeAutomationPlan, {
      name: 'Agent’s idea',
      description: '',
      definition: def([{ id: 'x', kind: 'post_message', text: 'hi' }]) as never,
      dispatchId: await w.turn(IDS.dusty, def([]).conversationId),
    });
    expect(proposed.problems).toEqual([]);
    const automationId = proposed.automationId as string;
    const res = await w.commit(IDS.dusty, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: await w.draftHash(automationId),
    });
    expect(res.status).toBe('blocked');
    const accept = await w.commit(IDS.dusty, acceptAutomationPlan, { planId: proposed.planId as string });
    expect(accept.status).toBe('blocked');
    const [row] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
    expect(row?.status).toBe('draft');
    expect(row?.currentVersion).toBeNull();
  });
});

describe('webhook triggers (nothing can call one on a box)', () => {
  const hooked = def([{ id: 'x', kind: 'post_message', text: 'hi' }], {
    triggers: [{ kind: 'webhook' }],
  });

  it('refuses saving, importing or proposing one, and publishing a draft that has one from before', async () => {
    const automationId = await w.publish(def([{ id: 'x', kind: 'post_message', text: 'hi' }]));
    const refused = { code: 'bad_request', message: NO_WEBHOOK_TRIGGER_TEXT };
    await expect(
      w.commit(IDS.mara, saveAutomationDraft, { automationId, definition: hooked as never }),
    ).rejects.toMatchObject(refused);
    await expect(w.publish(hooked)).rejects.toMatchObject(refused);
    // The agent's proposal comes back with the reason, as its other problems do.
    const proposed = await w.ok(IDS.dusty, proposeAutomationPlan, {
      name: 'Called from outside',
      description: '',
      definition: hooked as never,
      dispatchId: await w.turn(IDS.dusty, BILLING),
    });
    expect(proposed).toMatchObject({ planId: null, problems: [NO_WEBHOOK_TRIGGER_TEXT] });
    // A draft from before is kept, but can't go live.
    await w.services.db
      .update(automations)
      .set({ draftJson: JSON.parse(JSON.stringify(hooked)) })
      .where(eq(automations.id, automationId));
    const publish = w.commit(IDS.mara, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: await w.draftHash(automationId),
    });
    await expect(publish).rejects.toMatchObject({ code: 'bad_request' });
    await expect(publish).rejects.toThrow(NO_WEBHOOK_TRIGGER_TEXT);
  });
});

describe('cancellation', () => {
  it('cancelling mid-dispatch cancels the agent’s turn', async () => {
    const id = await w.publish(def([{ id: 'ask', kind: 'dispatch_agent', prompt: 'Take a look.' }]), {
      name: 'Cancel me',
    });
    const runId = await start(id);
    const run = await w.run(runId);
    const dispatchId = run.steps[0]?.dispatchId as string;
    // The runner has claimed it and is working.
    await w.services.db
      .update(dispatches)
      .set({ state: 'running', runnerId: 'rnr_test' })
      .where(eq(dispatches.id, dispatchId));
    await w.ok(IDS.mara, controlAutomationRun, { number: run.number, action: 'cancel' });
    const [d] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    expect(d?.state).toBe('cancelled');
    expect(await w.services.runtime.progress(dispatchId, { state: 'running', thinking: false })).toEqual({
      cancel: true,
      reason: 'cancelled',
    });
    expect((await w.run(runId)).status).toBe('cancelled');
  });
});

describe('schedules', () => {
  const scheduled = (overlap: 'skip' | 'queue' | 'cancel_previous', missed: 'skip' | 'run_once' = 'skip') =>
    def([{ id: 'ask', kind: 'dispatch_agent', prompt: 'Scheduled look.' }], {
      triggers: [
        {
          kind: 'schedule',
          schedule: { kind: 'interval', everyMinutes: 5 },
          timeZone: 'Europe/Amsterdam',
          overlap,
          missed,
          maxCatchUp: 3,
        },
      ],
    });

  it('overlap: skip, queue and cancel the previous run', async () => {
    w.setNow('2026-10-01T10:00:00.000Z');
    const skip = await w.publish(scheduled('skip'), { name: 'Overlap skip' });
    const queue = await w.publish(scheduled('queue'), { name: 'Overlap queue' });
    const cancel = await w.publish(scheduled('cancel_previous'), { name: 'Overlap cancel' });
    w.setNow('2026-10-01T10:05:01.000Z');
    await w.settle();
    for (const a of [skip, queue, cancel])
      expect((await w.runs(a)).map((r) => r.status)).toEqual(['waiting']);
    w.setNow('2026-10-01T10:10:01.000Z');
    await w.settle();
    expect((await w.runs(skip)).map((r) => r.status)).toEqual(['waiting', 'skipped']);
    expect((await w.runs(skip))[1]?.error).toBe('The previous run was still going.');
    expect((await w.runs(queue)).map((r) => r.status)).toEqual(['waiting', 'queued']);
    const cancelled = await w.runs(cancel);
    expect(cancelled.map((r) => r.status)).toEqual(['cancelled', 'waiting']);
    const [old] = await w.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, cancelled[0]?.steps[0]?.dispatchId as string));
    expect(old?.state).toBe('cancelled');
    // The queued run starts when the first one finishes.
    const q = await w.runs(queue);
    await w.fakeAgentReply(q[0]?.steps[0]?.dispatchId as string, 'Looked.');
    await w.settle();
    expect((await w.runs(queue)).map((r) => r.status)).toEqual(['succeeded', 'waiting']);
  });

  it('missed runs after downtime: skipped, or one catch-up run', async () => {
    w.setNow('2026-10-02T10:00:00.000Z');
    const skip = await w.publish(scheduled('skip', 'skip'), { name: 'Missed skip' });
    const once = await w.publish(scheduled('skip', 'run_once'), { name: 'Missed once' });
    // Whombat is down for an hour.
    w.setNow('2026-10-02T11:00:30.000Z');
    await w.settle();
    // 11:00 itself is on time (within the grace window); everything before it was missed.
    const skipped = await w.runs(skip);
    expect(skipped.map((r) => r.trigger.scheduledFor)).toEqual(['2026-10-02T11:00:00.000Z']);
    const caught = await w.runs(once);
    expect(caught.map((r) => r.trigger.scheduledFor)).toEqual([
      '2026-10-02T10:55:00.000Z',
      '2026-10-02T11:00:00.000Z',
    ]);
    expect(caught[0]?.trigger.summary).toMatch(/missed while Whombat was down/);
    // The catch-up run is still going when 11:00 is due: the overlap policy (skip) applies to it too.
    expect(caught[1]?.status).toBe('skipped');
    const [a] = await w.services.db.select().from(automations).where(eq(automations.id, skip));
    expect(a?.nextFireAt?.toISOString()).toBe('2026-10-02T11:05:00.000Z');
  });
});

describe('loops', () => {
  // In Mara's Chat, where her automations' runs post (automations/rooms.ts), so what one says can start another.
  const CHAT = IDS.dmDusty;
  const echo = (word: string, reply: string) =>
    def([{ id: 'say', kind: 'post_message', text: reply, thread: 'top' }], {
      conversationId: CHAT,
      triggers: [{ kind: 'message_posted', conversationId: CHAT, contains: [word], includeAgents: true }],
    });

  it('an automation never triggers itself, and chains stop at the causal limit', async () => {
    const self = await w.publish(echo('echo-word', 'echo-word again'), { name: 'Self' });
    const d1 = await w.publish(echo('chain-one', 'chain-two'), { name: 'D1' });
    const d2 = await w.publish(echo('chain-two', 'chain-three'), { name: 'D2' });
    const d3 = await w.publish(echo('chain-three', 'chain-four'), { name: 'D3' });
    const d4 = await w.publish(echo('chain-four', 'chain-five'), { name: 'D4' });
    await w.ok(IDS.mara, sendMessage, { conversationId: CHAT, text: 'echo-word' });
    await w.ok(IDS.mara, sendMessage, { conversationId: CHAT, text: 'chain-one' });
    await w.settle(12);
    expect(await w.runs(self)).toHaveLength(1);
    expect((await w.runs(d1)).map((r) => r.causalDepth)).toEqual([0]);
    expect((await w.runs(d2)).map((r) => r.causalDepth)).toEqual([1]);
    expect((await w.runs(d3)).map((r) => r.causalDepth)).toEqual([2]);
    expect(await w.runs(d4)).toHaveLength(0);
  });

  it('an agent answering an automation does not trigger the same automation again', async () => {
    const id = await w.publish(
      def([{ id: 'ask', kind: 'dispatch_agent', prompt: 'Is loop-bait safe?' }], {
        conversationId: CHAT,
        triggers: [
          {
            kind: 'message_posted',
            conversationId: CHAT,
            contains: ['loop-bait'],
            includeAgents: true,
            includeReplies: true,
          },
        ],
      }),
      { name: 'Agent loop' },
    );
    await w.ok(IDS.mara, sendMessage, { conversationId: CHAT, text: 'loop-bait?' });
    await w.settle();
    const [run] = await w.runs(id);
    await w.fakeAgentReply(run?.steps[0]?.dispatchId as string, 'loop-bait is fine.');
    await w.settle(8);
    expect(await w.runs(id)).toHaveLength(1);
  });
});

describe('recovery after a crash', () => {
  it('an approval decided just before a crash executes at the next boot', async () => {
    const id = await w.publish(APPROVE_THEN_POST, { name: 'Boot re-evaluation' });
    const runId = await start(id);
    const a = await approvalOf(runId, 'approve');
    // The process dies right after the decision commits: its post-commit execution never runs.
    w.services.approvals.reevaluate = async () => {};
    await w.ok(IDS.mara, decideApproval, { number: a.number, decision: 'approve' });
    expect((await approvalOf(runId, 'approve')).execution.state).toBe('idle');
    await w.restart();
    await w.services.automations.bootRecovery();
    await w.settle();
    expect((await approvalOf(runId, 'approve')).executedAt).not.toBeNull();
    expect((await w.run(runId)).status).toBe('succeeded');
  });

  it('an execution left running is continued once when it provably did not happen', async () => {
    const id = await w.publish(APPROVE_THEN_POST, { name: 'Stuck continue' });
    const runId = await start(id);
    const a = await approvalOf(runId, 'approve');
    await w.services.db
      .update(approvals)
      .set({
        state: 'approved',
        decidedById: IDS.mara,
        decidedAt: w.now(),
        execution: {
          state: 'running',
          startedAt: new Date(w.now().getTime() - 60_000).toISOString(),
          finishedAt: null,
          durationMs: null,
          resultUrl: null,
          error: null,
        },
      })
      .where(eq(approvals.id, a.id));
    await w.restart();
    await w.services.automations.bootRecovery();
    await w.settle();
    expect((await approvalOf(runId, 'approve')).execution.state).toBe('succeeded');
    const continued = await w.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'automation.step.approved'), eq(events.approvalId, a.id)));
    expect(continued).toHaveLength(1);
    expect((await w.run(runId)).status).toBe('succeeded');
  });

  it('an execution left running without a way to check is failed as uncertain, never run twice', async () => {
    const [seeded] = await w.services.db.select().from(approvals).where(eq(approvals.requesterId, IDS.dusty));
    expect(seeded).toBeTruthy();
    await w.services.db
      .update(approvals)
      .set({
        state: 'approved',
        decidedById: IDS.mara,
        decidedAt: w.now(),
        execution: {
          state: 'running',
          startedAt: new Date(w.now().getTime() - 60_000).toISOString(),
          finishedAt: null,
          durationMs: null,
          resultUrl: null,
          error: null,
        },
      })
      .where(eq(approvals.id, seeded?.id as string));
    await w.restart();
    let executed = 0;
    w.services.approvals.setExecutor('deploy', async () => {
      executed++;
      return { ok: true };
    });
    await w.services.automations.bootRecovery();
    const [after] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, seeded?.id as string));
    expect(after?.execution.state).toBe('failed');
    expect(after?.execution.error).toBe(UNCERTAIN_EXECUTION);
    expect(after?.executedAt).toBeNull();
    expect(executed).toBe(0);
  });

  /** A run whose pull request step was about to open it (marked running) when Whombat stopped, restarted. */
  async function prStepCutShort(branch: string) {
    const repo = 'whombat/billing';
    const id = await w.publish(
      def([
        { id: 'pr', kind: 'open_pull_request', repo, branch, title: 'Fix the totals', otherwise: 'fail' },
      ]),
      { name: `Cut short ${branch}`, grants: [{ keyId: 'pr.open', tier: 'can', repos: [repo] }] },
    );
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false });
    await w.services.db.execute(
      sql`update automation_runs set status = 'running', started_at = now() where id = ${runId as string}`,
    );
    await w.services.db.execute(
      sql`update automation_run_steps s set state = 'running', attempt = 0, started_at = now(),
        output = jsonb_build_object('branch', ${branch}::text, 'title', 'Fix the totals', 'command', jsonb_build_object(
          'name', 'open_pr', 'input', jsonb_build_object('repo', ${repo}::text, 'branch', ${branch}::text, 'base', 'main',
          'title', 'Fix the totals', 'body', '', 'conversationId', r.conversation_id)))
        from automation_runs r where r.id = s.run_id and s.run_id = ${runId as string}`,
    );
    await w.restart();
    return runId as string;
  }

  async function openFrom(branch: string) {
    const open = await w.services.github.fake?.openPullRequests('whombat/billing', []);
    return open?.modified ? open.data.filter((p) => p.headRef === branch) : [];
  }

  it('a pull request step an update cut short opens it when GitHub has none from its branch', async () => {
    const runId = await prStepCutShort('feat/cut-short');
    await w.services.automations.bootRecovery();
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({ state: 'succeeded', output: { opened: true } });
    const opened = await openFrom('feat/cut-short');
    expect(opened.map((p) => p.number)).toEqual([run.steps[0]?.output.prNumber]);
  });

  it('a pull request step an update cut short takes the one GitHub opened just before', async () => {
    const runId = await prStepCutShort('feat/cut-late');
    // GitHub opened it; the commit that would have recorded it never happened.
    const pr = await w.services.github.fake?.createPullRequest({
      repo: 'whombat/billing',
      head: 'feat/cut-late',
      base: 'main',
      title: 'Fix the totals',
      body: '',
    });
    await w.services.automations.bootRecovery();
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({
      state: 'succeeded',
      output: { opened: true, prNumber: pr?.number },
    });
    expect(await openFrom('feat/cut-late')).toHaveLength(1);
  });

  it('an external step caught mid-flight by a crash needs a person to say what happened', async () => {
    w.setNow('2026-10-03T10:00:00.000Z');
    const id = await w.publish(
      def([{ id: 'call', kind: 'http_callback', url: 'https://hooks.example.com/whombat', body: '{}' }]),
      {
        name: 'Uncertain call',
        grants: [{ keyId: 'messages.external', tier: 'can' }],
      },
    );
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false });
    // The engine marked the call running, then the process died before the answer was recorded.
    await w.services.db.execute(
      sql`update automation_runs set status = 'running', started_at = now() where id = ${runId as string}`,
    );
    await w.services.db.execute(
      sql`update automation_run_steps set state = 'running', attempt = 0, started_at = now(), idempotency_key = ${`${runId}:call`} where run_id = ${runId as string}`,
    );
    await w.restart();
    await w.services.automations.bootRecovery();
    await w.settle();
    const run = await w.run(runId as string);
    expect(run.status).toBe('needs_review');
    expect(run.steps[0]?.state).toBe('uncertain');
  });
});

describe('an update', () => {
  it('waits for a step out talking to GitHub, never for one stuck longer than a call takes', async () => {
    const repo = 'whombat/billing';
    const id = await w.publish(
      def([
        {
          id: 'pr',
          kind: 'open_pull_request',
          repo,
          branch: 'feat/in-flight',
          title: 'Fix it',
          otherwise: 'fail',
        },
      ]),
      { name: 'In flight', grants: [{ keyId: 'pr.open', tier: 'can', repos: [repo] }] },
    );
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false });
    await w.services.db.execute(
      sql`update automation_run_steps set state = 'running', updated_at = ${w.now().toISOString()}::timestamptz
        where run_id = ${runId as string}`,
    );
    const inFlight = async (at: Date) => (await stepsInFlight(w.services.db, at)).map((s) => s.runId);
    expect(await inFlight(w.now())).toContain(runId);
    expect(await inFlight(new Date(w.now().getTime() + STEP_IN_FLIGHT_MS + 1_000))).not.toContain(runId);
    await w.services.db.execute(
      sql`update automation_run_steps set state = 'failed' where run_id = ${runId as string}`,
    );
    await w.services.db.execute(
      sql`update automation_runs set status = 'cancelled' where id = ${runId as string}`,
    );
  });
});

describe('calls to a URL', () => {
  const CALL = 'https://hooks.example.com/whombat';
  const callAutomation = (name: string, retries: number) =>
    w.publish(def([{ id: 'call', kind: 'http_callback', url: CALL, body: '{}', retries }]), {
      name,
      grants: [{ keyId: 'messages.external', tier: 'can' }],
    });
  /** Runs the step until it settles, past each retry's wait. */
  async function callUntilSettled(runId: string) {
    for (let i = 0; i < 6; i++) {
      await w.settle();
      const step = (await w.run(runId)).steps[0];
      if (step?.state !== 'pending') return;
      w.advance(60 * 60_000);
    }
  }

  it('retries carry the same idempotency key as the first try', async () => {
    receiver.calls = [];
    const statuses = [429, 409, 200];
    receiver.answer = () => answered(statuses.shift() ?? 200);
    try {
      const id = await callAutomation('Same key', 2);
      const runId = await start(id);
      await callUntilSettled(runId);
      const run = await w.run(runId);
      expect(run.steps[0]?.state).toBe('succeeded');
      expect(receiver.calls).toHaveLength(3);
      const keys = new Set(receiver.calls.map((h) => h['idempotency-key']));
      expect(keys.size).toBe(1);
      expect([...keys][0]).toContain(runId);
    } finally {
      receiver.answer = null;
    }
  });

  it('a 5xx after the call went out is uncertain for a person, never sent again on its own', async () => {
    receiver.calls = [];
    receiver.answer = () => answered(500);
    try {
      const id = await callAutomation('Server error', 3);
      const runId = await start(id);
      await callUntilSettled(runId);
      const run = await w.run(runId);
      expect(receiver.calls).toHaveLength(1);
      expect(run.status).toBe('needs_review');
      expect(run.steps[0]?.state).toBe('uncertain');
      expect(run.steps[0]?.error).toContain('500');

      // “Try it again” is the same operation: the receiver sees the same key and can tell.
      receiver.answer = () => answered(200);
      await w.ok(IDS.mara, reviewAutomationStep, {
        number: run.number,
        stepId: 'call',
        resolution: 'retry',
      });
      await callUntilSettled(runId);
      expect((await w.run(runId)).steps[0]?.state).toBe('succeeded');
      expect(receiver.calls).toHaveLength(2);
      expect(receiver.calls[1]?.['idempotency-key']).toBe(receiver.calls[0]?.['idempotency-key']);
    } finally {
      receiver.answer = null;
    }
  });

  it('no answer (a timeout, a dropped connection) is uncertain; refused before connecting is a failed try', async () => {
    receiver.calls = [];
    receiver.answer = () => Promise.reject(new OutboundError('timeout', 'The request timed out.'));
    try {
      const runId = await start(await callAutomation('No answer', 3));
      await callUntilSettled(runId);
      expect(receiver.calls).toHaveLength(1);
      expect((await w.run(runId)).steps[0]?.state).toBe('uncertain');

      receiver.calls = [];
      receiver.answer = () =>
        Promise.reject(new OutboundError('private_address', 'That address is private.'));
      const refused = await start(await callAutomation('Refused', 1));
      await callUntilSettled(refused);
      expect(receiver.calls).toHaveLength(2);
      expect((await w.run(refused)).steps[0]?.state).toBe('failed');
    } finally {
      receiver.answer = null;
    }
  });
});

describe('limits and visibility', () => {
  it('a run over its token budget stops before asking an agent again', async () => {
    const id = await w.publish(
      def(
        [
          { id: 'first', kind: 'dispatch_agent', prompt: 'First look.' },
          { id: 'second', kind: 'dispatch_agent', prompt: 'Second look.' },
        ],
        { limits: { runTimeoutMinutes: 60, maxConcurrentRuns: 1, maxRunsPerDay: 10, maxTokensPerRun: 1000 } },
      ),
      { name: 'Budget' },
    );
    const runId = await start(id);
    const dispatchId = (await w.run(runId)).steps[0]?.dispatchId as string;
    // The provider reports what the turn used (FAKE AGENT reply, then the usage the runner would send).
    await w.services.db
      .update(dispatches)
      .set({ usage: { inputTokens: 4000, outputTokens: 800 } })
      .where(eq(dispatches.id, dispatchId));
    await w.fakeAgentReply(dispatchId, 'Looked.');
    await w.settle();
    const run = await w.run(runId);
    expect(run.tokens).toBe(4800);
    expect(run.status).toBe('failed');
    expect(run.steps[1]?.state).toBe('blocked');
    expect(run.steps[1]?.dispatchId).toBeNull();
  });

  it('a run counts against the automation’s runs for the day', async () => {
    const id = await w.publish(
      def([{ id: 'note', kind: 'post_message', text: 'daily-cap note' }], {
        triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: ['daily-cap'] }],
        limits: { runTimeoutMinutes: 60, maxConcurrentRuns: 1, maxRunsPerDay: 2 },
      }),
      { name: 'Daily cap' },
    );
    for (const n of [1, 2, 3])
      await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: `daily-cap ${n}` });
    await w.settle();
    expect(await w.runs(id)).toHaveLength(2);
  });

  it('run frames name the run’s room', async () => {
    const id = await w.publish(def([{ id: 'note', kind: 'post_message', text: 'Room-only.' }]), {
      name: 'Frames',
    });
    const runId = await start(id);
    // The run's room is Mara's Chat (automations/rooms.ts).
    expect((await w.run(runId)).conversationId).toBe(IDS.dmDusty);
    const frames = await w.services.db.execute<{ room: string | null }>(
      sql`select event->'run'->>'conversationId' as room from outbox where event->>'type' = 'automation.run.updated' and event->'run'->>'id' = ${runId}`,
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.room).toBe(IDS.dmDusty);
  });
});
