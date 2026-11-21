/**
 * Agent efficiency on the server (docs/decisions/agent-efficiency.md AE-05), against a real Postgres and the MCP
 * server over HTTP:
 *
 *  - AE-05: `start_run` with the number of an open pull request runs on that pull request's branch, whatever `branch`
 *    says — the key is asked for that branch, the approval names it and covers the run, the tool says which branch, and
 *    the run turn's checkout is that branch's; a closed or unknown pull request changes nothing;
 *  - system principals (GitHub, Feedback) aren't teammates in the burrow facts.
 */
import { type KeyId, newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { decideApproval } from '../commands/approvals';
import { approvals, dispatches, grants, pullRequests, runs } from '../db/schema/index';
import { feedbackPrincipal } from '../feedback/principal';
import { systemPrincipal } from '../github/actors';
import { IDS } from '../seed/test-world';
import { setGrant } from '../test/approvals';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { waitFor } from '../test/runner';
import { agentTokenFor } from '../test/tokens';
import { buildDispatchContext, runStartApproved } from './context';

const t = useTestServer({ seed: true, listen: true, env: signInsEnv() });
// Runs need a checkout: agents' git runs on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
const REPO = 'whombat/billing';
const PR_BRANCH = 'feat/invoice-pdf';
const FEATURE: KeyId = 'branch.feature.readwrite';
const clients: TestMcp[] = [];

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

/** Dusty in a turn of his in `conversationId` without a checkout (a mention in a channel). */
async function banjoTurn(conversationId: string = IDS.billing) {
  const { token, dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, conversationId);
  const mcp = await mcpClient(t.baseUrl, token);
  clients.push(mcp);
  return Object.assign(mcp, { dispatchId });
}

const steps = [{ title: 'Do it', detail: '' }];

async function runRow(number: number) {
  const [row] = await t.services.db
    .select()
    .from(runs)
    .where(and(eq(runs.burrowId, t.burrowId), eq(runs.number, number)));
  if (!row) throw new Error(`no run #${number}`);
  return row;
}

describe('AE-05 · a run on an open pull request works on its branch', () => {
  it('uses the pull request’s branch whatever branch says, says so, and its run turn checks that branch out', async () => {
    const banjo = await banjoTurn();
    const started = await banjo.call('start_run', {
      conversationId: IDS.billing,
      title: 'Deploy the PDF export to staging',
      repo: REPO,
      branch: 'feat/deploy-invoice-pdf',
      prNumber: 482,
      steps,
    });
    expect(started.body).toMatchObject({ status: 'ok', branch: PR_BRANCH });
    const run = await runRow(started.body.number as number);
    expect(run).toMatchObject({ branch: PR_BRANCH, prNumber: 482 });

    // The turn that started it had no checkout: the run goes on in a run turn on the pull request's branch (RC-01).
    const queued = await waitFor(
      async () => {
        const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.runId, run.id));
        return d ?? null;
      },
      10_000,
      'the run turn',
    );
    const ctx = await buildDispatchContext(t.services, queued);
    expect(ctx.workspace).toMatchObject({
      repo: REPO,
      branch: PR_BRANCH,
      baseBranch: 'main',
      access: 'write',
    });
    // The head the server knows for the branch (turn-efficiency.md TE-10): the pull request's, when it is a full sha.
    expect(ctx.workspace?.headSha ?? null).toBeNull();
    const head = `${'a'.repeat(39)}B`;
    const [pr] = await t.services.db
      .update(pullRequests)
      .set({ headSha: head })
      .where(eq(pullRequests.number, 482))
      .returning();
    expect(pr).toBeDefined();
    expect((await buildDispatchContext(t.services, queued)).workspace?.headSha).toBe(head.toLowerCase());
  });

  it('asks the key for the pull request’s branch: main named with PR #482 is not a run on main', async () => {
    const banjo = await banjoTurn();
    const onPr = await banjo.call('start_run', {
      conversationId: IDS.billing,
      title: 'Re-run the PDF snapshot',
      repo: REPO,
      branch: 'main',
      prNumber: 482,
      steps,
    });
    expect(onPr.body).toMatchObject({ status: 'ok', branch: PR_BRANCH });
    const requirement = await startRun.requiredKey?.(
      {
        conversationId: IDS.billing,
        title: 'x',
        repo: REPO,
        branch: 'main',
        prNumber: 482,
        steps,
      },
      { db: t.services.db, services: t.services, burrow: { id: t.burrowId } as never, actor: {} as never },
    );
    expect(requirement).toMatchObject({
      keyId: FEATURE,
      scope: { branch: PR_BRANCH, repo: REPO },
      attempt: `start a run on ${PR_BRANCH}`,
    });
  });

  it('keeps the branch asked for with a closed or unknown pull request', async () => {
    await t.services.db.insert(pullRequests).values({
      id: newId('pullRequest'),
      burrowId: t.burrowId,
      repoId: 'rep_billing',
      number: 470,
      branch: 'feat/old-export',
      baseBranch: 'main',
      title: 'Old export',
      state: 'closed',
      headSha: 'abc1234',
      conversationId: IDS.billing,
      openedAt: t.services.clock(),
    });
    const banjo = await banjoTurn();
    const closed = await banjo.call('start_run', {
      conversationId: IDS.billing,
      title: 'Start the export again',
      repo: REPO,
      branch: 'feat/export-again',
      prNumber: 470,
      steps,
    });
    expect(closed.body).toMatchObject({ status: 'ok', branch: 'feat/export-again' });
    expect(await runRow(closed.body.number as number)).toMatchObject({
      branch: 'feat/export-again',
      prNumber: 470,
    });
    const unknown = await banjo.call('start_run', {
      conversationId: IDS.billing,
      title: 'Hotfix',
      repo: REPO,
      branch: 'main',
      prNumber: 999,
      steps,
    });
    expect(unknown.body).toMatchObject({ status: 'blocked', keyNeeded: { id: 'branch.main.push' } });
  });

  it('an approval names the pull request’s branch, and its yes covers the run on it (BP-C37)', async () => {
    const [before] = await t.services.db
      .select({ tier: grants.tier })
      .from(grants)
      .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, FEATURE)));
    await setGrant(t.services, IDS.dusty, FEATURE, 'ask');
    try {
      const banjo = await banjoTurn();
      const asked = await banjo.call('start_run', {
        conversationId: IDS.billing,
        title: 'Address Dusty’s second review',
        repo: REPO,
        branch: 'feat/review-2',
        prNumber: 482,
        steps,
      });
      expect(asked.body).toMatchObject({ status: 'pending_approval' });
      const [approval] = await t.services.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, asked.body.approvalId as string));
      expect(approval).toMatchObject({ keyId: FEATURE, state: 'pending' });
      expect(approval?.command).toMatchObject({
        name: 'start_run',
        input: { branch: PR_BRANCH, prNumber: 482 },
      });
      expect(`${approval?.title} ${approval?.target}`).toContain(PR_BRANCH);

      await t.services.db
        .update(dispatches)
        .set({ state: 'done' })
        .where(eq(dispatches.id, banjo.dispatchId));
      const decided = await t.commit(IDS.mara, decideApproval, {
        number: asked.body.approvalNumber as number,
        decision: 'approve',
      });
      expect(decided.status).toBe('ok');
      const run = await waitFor(
        async () => {
          const [r] = await t.services.db
            .select()
            .from(runs)
            .where(eq(runs.title, 'Address Dusty’s second review'));
          return r ?? null;
        },
        10_000,
        'the approved run',
      );
      expect(run).toMatchObject({ branch: PR_BRANCH, prNumber: 482 });
      expect(await runStartApproved(t.services.db, run.id, REPO)).toBe(true);
    } finally {
      await setGrant(t.services, IDS.dusty, FEATURE, before?.tier ?? 'can');
    }
  });
});

describe('the burrow facts (agent-efficiency.md AE-DR05, turn-efficiency.md TE-02)', () => {
  it('who is who: the facts name the person without a role, never Whombat’s own signers', async () => {
    await systemPrincipal(t.services, t.burrowId);
    await feedbackPrincipal(t.services, t.burrowId);
    const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, {
      state: 'claimed',
    });
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    if (!row) throw new Error('no dispatch');
    const ctx = await buildDispatchContext(t.services, row);
    // One agent (one-agent.md OA-01): no teammates, no “Agents:” fact; the person, with no role (one-person.md OP-S07).
    const people = ctx.facts.find((f) => f.startsWith('People: ')) ?? '';
    expect(people).toContain('Mara Okafor');
    expect(people).not.toContain(', owner');
    expect(people).not.toContain('GitHub');
    expect(ctx.facts.some((f) => f.startsWith('Agents: '))).toBe(false);
    // Their names still resolve where they wrote something (pull request events, reports).
    expect(ctx.principals.map((p) => p.name)).toEqual(expect.arrayContaining(['GitHub', 'Feedback']));
  });
});
