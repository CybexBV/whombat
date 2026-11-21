/**
 * A step waiting for a person's yes to its own request (`step-ops.ts` `awaitingYes`, shared by agent branches,
 * comments, merges and tracker writes and replies), on a real database with the in-memory FakeGitHub: a
 * `github_comment` step whose key asks. A no follows the step's `otherwise` — the step is skipped and the run goes on,
 * or the run fails — and names who said no; nobody deciding by the step's deadline fails it. Nothing is commented.
 */
import type { AutomationDefinitionInput, AutomationRun } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decideApproval } from '../../commands/approvals';
import { approvals } from '../../db/schema/index';
import type { FakeGitHub } from '../../github/fake';
import { IDS, useAutomationWorld } from '../../test/automations';
import { deleteAutomation } from '../commands';

const w = useAutomationWorld();
const REPO = 'whombat/billing';

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

/** One poll cycle of the burrow's repos, then the engine until nothing moves. */
async function poll() {
  const report = await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  if (report.errors.length) throw new Error(report.errors.join('; '));
  await w.settle();
}

/** Comments on every new issue of the repo once a person says yes, then posts in its room; published. */
async function asking(otherwise: 'skip' | 'fail'): Promise<string> {
  const definition: AutomationDefinitionInput = {
    version: 1,
    conversationId: IDS.billing,
    triggers: [{ kind: 'github', event: 'issue_opened', repo: REPO }],
    steps: [
      {
        id: 'comment',
        kind: 'github_comment',
        repo: REPO,
        number: '{{trigger.number}}',
        text: 'Seen: {{trigger.title}}',
        otherwise,
      },
      { id: 'after', kind: 'post_message', text: 'On to the next one.' },
    ],
  };
  const id = await w.publish(definition, {
    name: `Asks before commenting (${otherwise})`,
    grants: [{ keyId: 'pr.comment', tier: 'ask', repos: [REPO] }],
  });
  // The baseline: issues from before it listened start nothing.
  await poll();
  return id;
}

/** A new issue, and its run waiting for a person's yes to the comment. */
async function waiting(automationId: string, title: string) {
  const n = await fake().simulateOpenIssue({ repo: REPO, title, login: 'jdoe' });
  await poll();
  const run = (await w.runs(automationId)).at(-1) as AutomationRun;
  expect(run.steps[0]?.state).toBe('waiting');
  const [approval] = await w.services.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, run.steps[0]?.approvalId as string));
  if (!approval) throw new Error('no approval');
  expect(approval).toMatchObject({ keyId: 'pr.comment', state: 'pending' });
  return { n, runId: run.id, approval };
}

const done = (automationId: string) => w.ok(IDS.mara, deleteAutomation, { automationId });

describe('a step waiting for a person’s yes to its own request', () => {
  it('skips the step on a no and goes on, saying who said no', async () => {
    const id = await asking('skip');
    const comments = fake().comments.length;
    const { n, runId, approval } = await waiting(id, 'Totals are off');
    await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'decline' });
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => s.state)).toEqual(['skipped', 'succeeded']);
    expect(run.steps[0]?.inputSummary).toContain('Mara');
    expect(run.steps[0]?.inputSummary).toContain(`${REPO}#${n}`);
    expect(fake().comments).toHaveLength(comments);
    await done(id);
  });

  it('fails the run on a no when its otherwise is fail', async () => {
    const id = await asking('fail');
    const comments = fake().comments.length;
    const { n, runId, approval } = await waiting(id, 'Wrong currency');
    await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'decline' });
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.state).toBe('failed');
    expect(run.steps[0]?.error).toContain('Mara');
    expect(run.steps[0]?.error).toContain(`${REPO}#${n}`);
    expect(run.steps[1]?.state).not.toBe('succeeded');
    expect(fake().comments).toHaveLength(comments);
    await done(id);
  });

  it('fails the step when nobody decides by its deadline', async () => {
    const id = await asking('skip');
    const comments = fake().comments.length;
    const { runId } = await waiting(id, 'Export is slow');
    // Still waiting just before the comment step's own deadline (5 minutes by default)…
    w.advance(4 * 60_000);
    await w.settle();
    expect((await w.run(runId)).steps[0]?.state).toBe('waiting');
    // …and failed once it has passed, whatever its otherwise says.
    w.advance(2 * 60_000);
    await w.settle();
    const run = await w.run(runId);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.state).toBe('failed');
    expect(fake().comments).toHaveLength(comments);
    await done(id);
  });
});
