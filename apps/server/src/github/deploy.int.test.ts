/**
 * The real deploy executor against FakeGitHub: with `GITHUB_DEPLOY_WORKFLOW` set, an approved deploy runs the
 * configured workflow through `workflow_dispatch` and completes when the poller sees the run end — succeeded
 * (DEPLOYED, with the run's URL and duration) or failed (DEPLOY FAILED with GitHub's conclusion).
 */
import { approvalView } from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decideApproval, requestApproval } from '../commands/approvals';
import { reviewPr } from '../commands/prs';
import { deployments, events, githubDeploys, messages, pullRequests } from '../db/schema/index';
import { approvalByNumber, toApproval } from '../read/work';
import { IDS, TEST_TZ } from '../seed/test-world';
import { fakeOf, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';

const t = useTestServer({
  seed: true,
  app: true,
  env: { GITHUB_DEPLOY_WORKFLOW: 'whombat/billing:staging=deploy-staging.yml, *=deploy.yml' },
});
const REPO = 'whombat/billing';

async function approval(number: number) {
  const row = await approvalByNumber(t.services.db, t.burrowId, number);
  if (!row) throw new Error(`no approval #${number}`);
  return toApproval(row);
}

describe('deploys through GitHub Actions', () => {
  it('an approved staging deploy runs the staging workflow and completes when its run ends', async () => {
    const fake = fakeOf(t);
    fake.options.workflowDelayMs = 40;
    // Approve in advance; the deploy waits for green checks and Dusty's review.
    expect((await t.commit(IDS.mara, decideApproval, { number: 12, decision: 'approve' })).status).toBe('ok');
    expect(fake.dispatched).toEqual([]);
    const [pr] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, 482));
    for (const name of ['unit · billing', 'pdf-snapshot'])
      await fake.simulateCheckRun({ repo: REPO, sha: pr?.headSha ?? '', name, conclusion: 'success' });
    await syncGitHub(t);
    await t.commit(IDS.dusty, reviewPr, { prNumber: 482, decision: 'approve', body: '', comments: [] });

    const deployed = await waitFor(
      async () => {
        await syncGitHub(t);
        const a = await approval(12);
        return a.execution.state === 'succeeded' ? a : null;
      },
      10_000,
      'the deploy workflow',
    );
    expect(fake.dispatched).toMatchObject([
      {
        repo: REPO,
        workflow: 'deploy-staging.yml',
        ref: 'feat/invoice-pdf',
        inputs: {
          environment: 'staging',
          ref: 'feat/invoice-pdf',
          service: 'billing-api',
          whombat_approval: deployed.id,
        },
      },
    ]);
    expect(deployed.execution.resultUrl).toMatch(/\/whombat\/billing\/actions\/runs\/\d+$/);
    expect(deployed.execution.durationMs).toBeGreaterThanOrEqual(1);
    expect(deployed.executedAt).not.toBeNull();
    const view = approvalView(deployed, {
      names: () => undefined,
      now: deployed.executedAt ?? '',
      timeZone: TEST_TZ,
    });
    expect(view.label).toBe('DEPLOYED');
    const [row] = await t.services.db
      .select()
      .from(githubDeploys)
      .where(eq(githubDeploys.approvalId, deployed.id));
    expect(row).toMatchObject({ state: 'succeeded', workflow: 'deploy-staging.yml' });
    const [executed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'approval.executed'), eq(events.actorId, IDS.dusty)))
      .orderBy(desc(events.seq));
    expect(executed?.text).toBe('Deployed feat/invoice-pdf to staging');
    // On the Deploys board, by the person whose yes ran it, its card where the approval card is (RF-02).
    const [recorded] = await t.services.db
      .select()
      .from(deployments)
      .where(eq(deployments.approvalId, deployed.id));
    expect(recorded).toMatchObject({
      environment: 'staging',
      service: 'billing-api',
      status: 'succeeded',
      how: 'github_actions',
      repo: REPO,
      ref: 'feat/invoice-pdf',
      byId: IDS.mara,
      conversationId: deployed.conversationId,
      previousId: null,
    });
    expect(recorded?.summary).toBe('The deploy-staging.yml workflow on GitHub Actions finished.');
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, recorded?.messageId ?? ''));
    expect(card).toMatchObject({
      authorId: IDS.dusty,
      text: 'Deployed billing-api to staging',
      card: { kind: 'deploy', deploymentId: recorded?.id, status: 'succeeded' },
    });
    // Seen again by the poller: still one.
    await syncGitHub(t);
    expect(
      await t.services.db.select().from(deployments).where(eq(deployments.approvalId, deployed.id)),
    ).toHaveLength(1);
  });

  it('a failed workflow run fails the deploy with GitHub’s conclusion', async () => {
    const fake = fakeOf(t);
    fake.options.workflowConclusion = 'failure';
    const asked = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'deploy',
        params: { environment: 'production', service: 'billing-api', ref: 'main', sha: null, repo: REPO },
      },
      title: 'Deploy main to production',
      question: 'Deploy main to production?',
      target: 'production · billing-api',
      whatHappens: ['Roll billing-api to production'],
      explainer: '',
      summary: '',
    });
    if (asked.status !== 'ok') throw new Error(`request_approval: ${asked.status}`);
    await t.commit(IDS.mara, decideApproval, { number: asked.result.number, decision: 'approve' });
    const failed = await waitFor(
      async () => {
        await syncGitHub(t);
        const a = await approval(asked.result.number);
        return a.execution.state === 'failed' ? a : null;
      },
      10_000,
      'the failed deploy',
    );
    expect(fake.dispatched.at(-1)).toMatchObject({ workflow: 'deploy.yml', ref: 'main' });
    expect(failed.execution.error).toBe('the deploy.yml run ended failure');
    expect(failed.executedAt).toBeNull();
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'approval.failed'))
      .orderBy(desc(events.seq));
    expect(event?.text).toBe('Couldn’t deploy main to production: the deploy.yml run ended failure');
    const [recorded] = await t.services.db
      .select()
      .from(deployments)
      .where(eq(deployments.approvalId, failed.id));
    expect(recorded).toMatchObject({
      environment: 'production',
      status: 'failed',
      how: 'github_actions',
      ref: 'main',
      byId: IDS.mara,
    });
    expect(recorded?.summary).toBe('The deploy.yml run on GitHub Actions failed.');
  });

  it('never gives a retry the run of the deploy before it, nor a run another approval’s title names', async () => {
    const deploys = t.services.github.deploys;
    const at = Date.now();
    const run = (id: number, title: string, createdAt: number, status = 'completed') => ({
      id,
      name: 'deploy.yml',
      displayTitle: title,
      path: '.github/workflows/deploy.yml',
      event: 'workflow_dispatch',
      status,
      conclusion: status === 'completed' ? 'failure' : null,
      headBranch: 'main',
      url: `https://github.fake.whombat.local/${REPO}/actions/runs/${id}`,
      createdAt: new Date(createdAt).toISOString(),
      runStartedAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(createdAt + 18_000).toISOString(),
    });
    const base = {
      burrowId: t.burrowId,
      repo: REPO,
      workflow: 'deploy.yml',
      ref: 'main',
      environment: 'production',
    };
    // Deploy A's run failed in 20 s; the retry B was dispatched 30 s after that.
    await t.services.db.insert(githubDeploys).values([
      {
        ...base,
        approvalId: 'apr_firsttry01',
        state: 'failed',
        runId: 7001,
        dispatchedAt: new Date(at),
        completedAt: new Date(at + 20_000),
      },
      { ...base, approvalId: 'apr_secondtry2', state: 'dispatched', dispatchedAt: new Date(at + 50_000) },
    ]);
    const retry = async () => {
      const [row] = await t.services.db
        .select()
        .from(githubDeploys)
        .where(eq(githubDeploys.approvalId, 'apr_secondtry2'));
      return row;
    };
    try {
      expect(
        await deploys.onWorkflowRun(t.burrowId, REPO, run(7001, 'Deploy apr_firsttry01', at + 2_000)),
      ).toBe(false);
      // A's run with its id not recorded yet: its title still says whose it is.
      await t.services.db
        .update(githubDeploys)
        .set({ runId: null })
        .where(eq(githubDeploys.approvalId, 'apr_firsttry01'));
      expect(
        await deploys.onWorkflowRun(t.burrowId, REPO, run(7001, 'Deploy apr_firsttry01', at + 2_000)),
      ).toBe(false);
      // Another burrow's (or instance's) deploy of the same repo.
      expect(
        await deploys.onWorkflowRun(
          t.burrowId,
          REPO,
          run(7005, 'Deploy apr_elsewhere99', at + 51_000, 'queued'),
        ),
      ).toBe(false);
      expect(await retry()).toMatchObject({ state: 'dispatched', runId: null });
      // B's own run.
      expect(
        await deploys.onWorkflowRun(
          t.burrowId,
          REPO,
          run(7002, 'Deploy apr_secondtry2', at + 52_000, 'queued'),
        ),
      ).toBe(true);
      expect(await retry()).toMatchObject({ state: 'running', runId: 7002 });
    } finally {
      await t.services.db
        .delete(githubDeploys)
        .where(inArray(githubDeploys.approvalId, ['apr_firsttry01', 'apr_secondtry2']));
    }
  });
});
