/**
 * Approvals never claim work that didn't happen (docs/decisions/essentials-agents.md EA-02, EA-03, EA-05, EA-06):
 * each action type's outcome, with no simulated executor installed.
 *
 * - refund, an outside message, a deploy without a workflow: refused up front (`request_approval`, `perform_action`)
 *   with a sentence the agent can act on; an old approval of such a type that gets approved fails and says nothing
 *   happened;
 * - custom: a yes is a person's agreement (“Mara approved: …”), never “done”;
 * - create_channel: the real channel, with the people it named;
 * - merge_pr: merged by the person who approved, with the merge rules kept (and a refusal is a failure);
 * - push_shared_branch: a yes lets exactly that push through; the credential handed out completes it; unused, it lapses.
 */
import { turnPrompt } from '@whombat/runner';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openPr, performAction } from '../commands/agent-tools';
import { decideApproval, requestApproval } from '../commands/approvals';
import { recordChecks, reviewPr } from '../commands/prs';
import { defineCommand } from '../commit/types';
import { approvals, dispatches, events, pullRequests } from '../db/schema/index';
import { approvalForViewer, toApproval } from '../read/work';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setGrant, simulateExecutors } from '../test/approvals';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { agentTokenFor } from '../test/tokens';
import { wakeForApproval } from './wake';

const t = useTestServer({ seed: true, app: true, env: signInsEnv() });
const REPO = 'whombat/billing';
const RUNNER = { authorization: 'Bearer dev-runner-token' };

beforeAll(async () => {
  await setGrant(t.services, IDS.dusty, 'refunds.issue', 'ask');
  await setGrant(t.services, IDS.dusty, 'messages.external', 'ask');
  await setGrant(t.services, IDS.dusty, 'merge', 'ask');
  await setGrant(t.services, IDS.dusty, 'branch.shared.push', 'ask');
  // Agents' git runs on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
  await connectGitHubAs(t.services, IDS.mara);
});

async function load(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('missing approval');
  return toApproval(row);
}

async function eventsOf(approvalId: string) {
  return t.services.db.select().from(events).where(eq(events.approvalId, approvalId));
}

const ask = (actorId: string, action: unknown, extra: Record<string, unknown> = {}) =>
  t.commit(actorId, requestApproval, {
    conversationId: IDS.billing,
    action: action as never,
    title: 'x',
    question: 'x?',
    target: '',
    whatHappens: ['Say so in the thread.'],
    explainer: '',
    summary: '',
    ...extra,
  });

async function asked(actorId: string, action: unknown) {
  const res = await ask(actorId, action);
  if (res.status !== 'ok') throw new Error(`request_approval: ${res.status}`);
  return res.result;
}

const approve = (number: number, by: string = IDS.mara) =>
  t.commit(by, decideApproval, { number, decision: 'approve' });

const REFUND = {
  type: 'refund',
  params: { amountCents: 2400, currency: 'EUR', accountId: '3310', reason: 'Double charge' },
};
const MESSAGE = { type: 'message_external', params: { to: 'ops@acme.test', subject: 'Invoice', body: 'Hi' } };
const DEPLOY = {
  type: 'deploy',
  params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
};

describe('actions nobody here carries out', () => {
  it.each([
    [
      'a refund',
      REFUND,
      'Whombat can’t issue refunds here: no payment system is connected. Ask a person to do it, and say what exactly.',
    ],
    [
      'an outside message',
      MESSAGE,
      'Whombat can’t send messages outside this Whombat here: nothing is connected to send them. Ask a person to send it, and say what exactly.',
    ],
    ['a deploy without a workflow', DEPLOY, expect.stringContaining('no deploy workflow')],
  ])('%s is refused up front, asked or performed', async (_what, action, sentence) => {
    const before = (await t.services.db.select().from(approvals)).length;
    await expect(ask(IDS.dusty, action)).rejects.toMatchObject({ code: 'bad_request', message: sentence });
    await expect(
      t.commit(IDS.dusty, performAction, {
        conversationId: IDS.billing,
        action: action as never,
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'bad_request', message: sentence });
    expect(await t.services.db.select().from(approvals)).toHaveLength(before);
  });

  it('an old refund approval that gets approved fails and says no refund was issued', async () => {
    // Asked while something could carry it out; by the time a person says yes nothing can.
    simulateExecutors(t.services, 'refund');
    const { approvalId, number } = await asked(IDS.dusty, REFUND);
    t.services.approvals.removeExecutor('refund');
    expect((await approve(number)).status).toBe('ok');
    const done = await load(approvalId);
    expect(done.execution.state).toBe('failed');
    expect(done.executedAt).toBeNull();
    const texts = (await eventsOf(approvalId)).map((e) => [e.type, e.text]);
    expect(texts).toContainEqual([
      'approval.failed',
      'Couldn’t refund €24,00 on account 3310: no payment system is connected to Whombat, so no refund was issued.',
    ]);
    expect(texts.map(([type]) => type)).not.toContain('approval.executed');
  });

  it('an old approval of a command this Whombat no longer has (a pack tool call) fails: nothing happened (SST-12)', async () => {
    // A command that asks first and runs after the yes, as `call_pack_tool` did before pack tools went (SST-09).
    const useTool = defineCommand({
      name: 'test_use_tool',
      schema: z.object({ tool: z.string(), conversationId: z.string() }),
      requiredKey: async (input) => ({
        keyId: 'refunds.issue',
        attempt: `use the ${input.tool} tool`,
        conversationId: input.conversationId,
      }),
      apply: async () => ({ ran: true }),
    });
    t.services.pipeline.register(useTool);
    const res = await t.commit(IDS.dusty, useTool, { tool: 'close_ticket', conversationId: IDS.billing });
    if (res.status !== 'pending_approval') throw new Error(`expected an approval, got ${res.status}`);
    // The release that had the command is gone: its name means nothing here any more.
    const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, res.approvalId));
    if (!row?.command) throw new Error('the approval holds no command');
    await t.services.db
      .update(approvals)
      .set({ command: { ...row.command, name: 'call_retired_tool' } })
      .where(eq(approvals.id, res.approvalId));
    // It renders as it was asked: the arguments' lines for the room, the outside lines for anyone else (SEC-PACK-ARGS).
    await t.services.db
      .update(approvals)
      .set({
        whatHappens: ['Dusty calls close_ticket with {"ticket":42}'],
        whatHappensOutside: ['Dusty calls close_ticket. Only people in #billing-v2 see its arguments.'],
      })
      .where(eq(approvals.id, res.approvalId));
    const [stored] = await t.services.db.select().from(approvals).where(eq(approvals.id, res.approvalId));
    if (!stored) throw new Error('missing approval');
    expect((await approvalForViewer(t.services.db, IDS.mara, stored)).whatHappens.join(' ')).toContain(
      '"ticket"',
    );
    expect((await approve(res.approvalNumber)).status).toBe('ok');
    const done = await load(res.approvalId);
    expect(done.execution.state).toBe('failed');
    expect((await eventsOf(res.approvalId)).find((e) => e.type === 'approval.failed')?.text).toContain(
      'nothing happened',
    );
  });

  it('the seeded staging deploy, approved with checks and review green, fails: nothing was deployed', async () => {
    expect((await approve(12)).status).toBe('ok');
    await t.commit(IDS.dusty, recordChecks, {
      prNumber: 482,
      headSha: '7be20f',
      checks: [{ name: 'unit', state: 'passed', note: '41/41', durationMs: 1, tests: null, url: null }],
    });
    await t.commit(IDS.dusty, reviewPr, {
      prNumber: 482,
      decision: 'approve',
      body: 'Approved.',
      comments: [],
    });
    const done = await load('apr_staging-482');
    expect(done.execution.state).toBe('failed');
    expect(done.executedAt).toBeNull();
    expect((await eventsOf(done.id)).map((e) => e.text)).toContain(
      'Couldn’t deploy feat/invoice-pdf to staging: no deploy workflow is set up on this Whombat, so nothing was deployed.',
    );
  });
});

describe('perform_action runs only what Whombat does', () => {
  it('refuses a custom action and a push with what to do instead', async () => {
    await expect(
      t.commit(IDS.dusty, performAction, {
        conversationId: IDS.billing,
        action: { type: 'custom', params: { name: 'Run CI', keyId: 'ci.run', data: {} } },
        reason: '',
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message:
        'Whombat has nothing to run for “Run CI”. If you hold its key, do it yourself; if it needs a person’s yes, ask with request_approval.',
    });
    await expect(
      t.commit(IDS.dusty, performAction, {
        conversationId: IDS.billing,
        action: { type: 'push_shared_branch', params: { repo: REPO, branch: 'release/2.1', sha: 'abc1234' } },
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('custom', () => {
  it('a yes is a person’s agreement, signed as such — never “done”', async () => {
    const { approvalId, number } = await asked(IDS.dusty, {
      type: 'custom',
      params: { name: 'rotate the staging API key', keyId: 'deploy.staging', data: {} },
    });
    expect((await approve(number)).status).toBe('ok');
    const done = await load(approvalId);
    expect(done.execution.state).toBe('succeeded');
    const executed = (await eventsOf(approvalId)).find((e) => e.type === 'approval.executed');
    expect(executed).toMatchObject({ actorId: IDS.dusty, text: 'Mara approved: Rotate the staging API key' });
  });

  it('wakes the agent that asked, under the card, for the person it asked for — once', async () => {
    const { approvalId, number, messageId } = await asked(IDS.dusty, {
      type: 'custom',
      params: { name: 'restart the billing worker', keyId: 'deploy.staging', data: {} },
    });
    const [request] = await t.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect((await approve(number)).status).toBe('ok');
    const woken = await t.services.db.select().from(dispatches).where(eq(dispatches.approvalId, approvalId));
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      agentId: IDS.dusty,
      trigger: 'approval_granted',
      state: 'queued',
      conversationId: IDS.billing,
      threadRootId: messageId,
      messageId: null,
      onBehalfOfAccountId: request?.onBehalfOfAccountId ?? null,
    });
    // Waking again while that turn is live answers with it.
    const again = await t.commit(IDS.mara, wakeForApproval, { approvalId });
    expect(again.status === 'ok' && again.result).toEqual({ dispatchId: woken[0]?.id, created: false });
    // Its context carries the approval, and the prompt agents get says what the agent may do now (resourceful-agents.md
    // RA-10: the runner's builder, which names a person by first name).
    const ctx = await buildDispatchContext(t.services, woken[0] as NonNullable<(typeof woken)[number]>);
    expect(ctx.grantedApproval).toMatchObject({ id: approvalId, state: 'approved', decidedById: IDS.mara });
    expect(turnPrompt(ctx)).toContain(
      `Mara approved: Restart the billing worker (request #${number}). You may do it yourself now`,
    );
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.approvalId, approvalId));
  });
});

describe('merge_pr', () => {
  let prNumber = 0;

  beforeAll(async () => {
    // The release branch exists on (fake) GitHub.
    await t.services.github.fake?.simulatePush({
      repo: REPO,
      branch: 'release/2.1',
      commits: [{ sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', message: 'Release 2.1' }],
    });
    const opened = await t.commit(IDS.dusty, openPr, {
      repo: REPO,
      branch: 'feat/tax-table',
      base: 'release/2.1',
      title: 'Tax table for 2027',
      body: '',
    });
    if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
    prNumber = opened.result.number;
  });

  const MERGE = () => ({ type: 'merge_pr', params: { prNumber, repo: REPO, base: 'release/2.1' } });

  it('fails honestly when the merge rules refuse it (changes requested)', async () => {
    // The person's yes is the review of an agent's PR under their own account (MOA-01): what still holds it is a
    // change someone asked for.
    await t.commit(IDS.dusty, reviewPr, {
      prNumber,
      repo: REPO,
      decision: 'request_changes',
      body: 'Not yet.',
      comments: [],
    });
    const { approvalId, number } = await asked(IDS.dusty, MERGE());
    expect((await approve(number)).status).toBe('ok');
    const done = await load(approvalId);
    expect(done.execution.state).toBe('failed');
    const [pr] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, prNumber));
    expect(pr?.state).toBe('open');
    expect((await eventsOf(approvalId)).find((e) => e.type === 'approval.failed')?.text).toMatch(
      new RegExp(`^Couldn’t merge PR #${prNumber} into release/2.1`),
    );
  });

  it('merges as the person who approved once the review approves', async () => {
    await t.commit(IDS.dusty, reviewPr, {
      prNumber,
      repo: REPO,
      decision: 'approve',
      body: 'Fine.',
      comments: [],
    });
    // The agent asked for a merge commit (agent-gh.md AGH-22): the yes merges that way.
    const merge = MERGE();
    const { approvalId, number } = await asked(IDS.dusty, {
      ...merge,
      params: { ...merge.params, method: 'merge' },
    });
    expect((await approve(number, IDS.mara)).status).toBe('ok');
    expect(t.services.github.fake?.merges.at(-1)).toEqual({ repo: REPO, number: prNumber, method: 'merge' });
    const [pr] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, prNumber));
    expect(pr).toMatchObject({ state: 'merged', mergedById: IDS.mara });
    const merged = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'pr.merged'), eq(events.actorId, IDS.mara)));
    expect(merged.map((e) => e.text)).toContain(`Merged PR #${prNumber} into release/2.1`);
    expect((await load(approvalId)).execution.state).toBe('succeeded');
    expect((await eventsOf(approvalId)).find((e) => e.type === 'approval.executed')?.text).toBeNull();
  });
});

describe('push_shared_branch', () => {
  const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
  const PUSH = { type: 'push_shared_branch', params: { repo: REPO, branch: 'release/2.1', sha: SHA } };

  /** The runner holding Dusty's turn: every call carries its lease whole (managed-sandbox.md MSB-10). */
  const LEASE = { runnerId: 'rnr_truthful', attempt: 1 };
  const credentials = (dispatchId: string, sha: string) =>
    t.api.inject({
      method: 'POST',
      url: `/internal/runner/dispatches/${dispatchId}/git-credentials`,
      headers: RUNNER,
      payload: { repo: REPO, branch: 'release/2.1', operation: 'push', sha, ...LEASE },
    });

  it('a yes lets exactly that push through, and the credential handed out completes it', async () => {
    const { approvalId, number } = await asked(IDS.dusty, PUSH);
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    await t.services.db
      .update(dispatches)
      .set({ runnerId: LEASE.runnerId, attempts: LEASE.attempt })
      .where(eq(dispatches.id, turn.dispatchId));
    // Before the yes the push asks (and answers with the waiting request).
    const before = await credentials(turn.dispatchId, SHA);
    expect(before.statusCode).toBe(202);
    expect((before.json() as { approvalId: string }).approvalId).toBe(approvalId);

    expect((await approve(number)).status).toBe('ok');
    const waiting = await load(approvalId);
    expect(waiting.execution.state).toBe('running');
    expect(waiting.executedAt).toBeNull();

    // Another commit is not what was approved: it asks again.
    const other = await credentials(turn.dispatchId, 'beef000000000000000000000000000000000000');
    expect(other.statusCode).toBe(202);
    expect((other.json() as { approvalId: string }).approvalId).not.toBe(approvalId);

    const res = await credentials(turn.dispatchId, SHA);
    expect(res.statusCode).toBe(200);
    const done = await load(approvalId);
    expect(done.execution.state).toBe('succeeded');
    expect(done.executedAt).not.toBeNull();
    expect((await eventsOf(approvalId)).find((e) => e.type === 'approval.executed')).toMatchObject({
      actorId: IDS.dusty,
      text: 'Allowed Dusty to push release/2.1',
    });
    // Used once: the next push of the branch asks again.
    const next = await credentials(turn.dispatchId, SHA);
    expect(next.statusCode).toBe(202);
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.dispatchId));
  });

  it('lapses a day after the yes when the agent never pushed', async () => {
    const { approvalId, number } = await asked(IDS.dusty, {
      ...PUSH,
      params: { ...PUSH.params, branch: 'release/2.2' },
    });
    expect((await approve(number)).status).toBe('ok');
    expect((await load(approvalId)).execution.state).toBe('running');
    const real = t.services.clock;
    t.services.clock = () => new Date(real().getTime() + 25 * 60 * 60_000);
    try {
      await t.services.approvals.recover();
    } finally {
      t.services.clock = real;
    }
    const lapsed = await load(approvalId);
    expect(lapsed.execution.state).toBe('failed');
    expect((await eventsOf(approvalId)).find((e) => e.type === 'approval.failed')?.text).toBe(
      'Couldn’t push c0ffee to release/2.2: Dusty didn’t push c0ffee to release/2.2 within a day of the yes, so nothing was pushed. Ask Dusty again.',
    );
  });
});
