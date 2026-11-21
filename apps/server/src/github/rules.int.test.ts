/**
 * The rules around GitHub: only switched-on repos exist for agents (DispatchContext, search, MCP tools, git
 * credentials); git credentials are the token of the GitHub sign-in the burrow was connected with (Mara's own, EA-10)
 * and a push token needs the branch key (main is Blocked, the grant says which agent pushed); "Merge into main" goes
 * through GitHub for the person, is blocked for an agent without the Merge key and disabled until checks and review
 * pass.
 */
import { api, buildPath } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { setRepoEnabled } from '../commands/burrows';
import { reviewPr } from '../commands/prs';
import { loadBurrowRow } from '../commit/pipeline';
import {
  dispatches,
  events,
  githubIdentities,
  githubPushGrants,
  prReviewers,
  pullRequests,
  repos,
} from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { callTool } from '../mcp/server';
import { loadPrincipalRow } from '../read/principals';
import { search } from '../read/search';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setGrant } from '../test/approvals';
import { connectGitHubAs, fakeOf, signInsEnv, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true, env: signInsEnv() });
const REPO = 'whombat/billing';
/** Mara's own GitHub token, the burrow's connection (`connectGitHubAs`). */
const TOKEN = 'github_pat_rules';
const RUNNER = { authorization: 'Bearer dev-runner-token' };
/** The lease the runner holds a dispatch with: every runner call carries it whole (managed-sandbox.md MSB-10). */
const LEASE = { runnerId: 'rnr_rules-test', attempt: 1 };
let mara = '';

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  // The burrow's GitHub, connected as Mara's own sign-in (`whombat` on GitHub): every agent's git runs on it.
  await connectGitHubAs(t.services, IDS.mara, { token: TOKEN });
  // Nobody's GitHub login is linked to `whombat` yet: the merge cases below link it themselves.
  await t.services.db.delete(githubIdentities).where(eq(githubIdentities.login, 'whombat'));
});

async function setBilling(enabled: boolean) {
  const [repo] = await t.services.db.select().from(repos).where(eq(repos.fullName, REPO));
  if (!repo) throw new Error('no billing repo');
  const res = await t.commit(IDS.mara, setRepoEnabled, { repoId: repo.id, enabled });
  expect(res.status).toBe('ok');
}

/** A queued dispatch for an agent, as the runner would claim it. */
async function dispatchFor(agentId: string, conversationId: string, runId?: string) {
  const [queued] = await enqueueDispatches(t.services, {
    burrowId: t.burrowId,
    causedById: IDS.mara,
    conversationId,
    messageId: null,
    threadRootId: null,
    requests: [{ agentId, trigger: runId ? 'run_control' : 'mention', mode: runId ? 'run' : 'reply' }],
    at: new Date(),
    ...(runId ? { runId } : {}),
  });
  const [row] = await t.services.db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, queued?.dispatchId ?? ''));
  if (!row) throw new Error('no dispatch');
  // Nobody claims in this file: mark it running under the test's lease so tokens and credentials treat it as live.
  await t.services.db
    .update(dispatches)
    .set({ state: 'running', runnerId: LEASE.runnerId, attempts: LEASE.attempt })
    .where(eq(dispatches.id, row.id));
  return { ...row, state: 'running' as const };
}

async function tool(agentId: string, conversationId: string, name: string, args: Record<string, unknown>) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, agentId, conversationId);
  const auth: AgentAuth = { dispatchId, agentId, burrowId: t.burrowId };
  const res = await callTool(t.services, auth, name, args);
  return res.structuredContent as Record<string, unknown> & { error?: { code: string } };
}

async function credentials(dispatchId: string, body: Record<string, unknown>) {
  return t.api.inject({
    method: 'POST',
    url: `/internal/runner/dispatches/${dispatchId}/git-credentials`,
    headers: RUNNER,
    payload: { ...LEASE, ...body },
  });
}

describe('switched-off repos do not exist for agents', () => {
  it('no workspace in the DispatchContext, none in a branch room either', async () => {
    const run = await dispatchFor(IDS.dusty, IDS.billing, 'run_1907');
    const room = await dispatchFor(IDS.dusty, IDS.pr482);
    expect((await buildDispatchContext(t.services, run)).workspace).toMatchObject({
      repo: REPO,
      branch: 'feat/invoice-pdf',
      cloneUrl: 'https://github.fake.whombat.local/whombat/billing.git',
    });
    expect((await buildDispatchContext(t.services, room)).workspace).toMatchObject({
      repo: REPO,
      branch: 'feat/invoice-pdf',
      baseBranch: 'main',
    });
    await setBilling(false);
    try {
      const ctx = await buildDispatchContext(t.services, run);
      expect(ctx.workspace).toBeNull();
      expect(ctx.facts).not.toContain(expect.stringContaining(REPO));
      expect((await buildDispatchContext(t.services, room)).workspace).toBeNull();
    } finally {
      await setBilling(true);
    }
  });

  it('search drops the repo’s branch room hits for agents, not for people', async () => {
    const burrow = await loadBurrowRow(t.services.db, t.burrowId);
    const banjo = await loadPrincipalRow(t.services.db, IDS.dusty);
    const maraRow = await loadPrincipalRow(t.services.db, IDS.mara);
    if (!burrow || !banjo || !maraRow) throw new Error('seed');
    const find = async (viewer: typeof banjo) =>
      (
        await search(
          t.services.db,
          viewer,
          burrow,
          { q: 'pdf_export flag', type: 'all', limit: 50 },
          new Date(),
        )
      ).results.map((r) => r.id);
    expect(await find(banjo)).toContain('msg_pr482-banjo-1048');
    await setBilling(false);
    try {
      expect(await find(banjo)).not.toContain('msg_pr482-banjo-1048');
      expect(await find(maraRow)).toContain('msg_pr482-banjo-1048');
    } finally {
      await setBilling(true);
    }
  });

  it('MCP tools answer “not found” for anything in the repo', async () => {
    await setBilling(false);
    try {
      expect(
        await tool(IDS.dusty, IDS.billing, 'read_conversation', { conversationId: IDS.pr482 }),
      ).toMatchObject({
        error: { code: 'not_found' },
      });
      expect(
        await tool(IDS.dusty, IDS.pr482, 'post_message', { conversationId: IDS.pr482, text: 'Still here?' }),
      ).toMatchObject({ error: { code: 'not_found' } });
      expect(
        await tool(IDS.dusty, IDS.billing, 'review_pull_request', {
          prNumber: 482,
          decision: 'approve',
          body: '',
          comments: [],
        }),
      ).toMatchObject({ error: { code: 'not_found' } });
      expect(
        await tool(IDS.dusty, IDS.billing, 'open_pull_request', {
          repo: REPO,
          branch: 'feat/hidden',
          title: 'Hidden',
        }),
      ).toMatchObject({ error: { code: 'not_found' } });
      const d = await dispatchFor(IDS.dusty, IDS.billing);
      expect((await credentials(d.id, { repo: REPO, branch: 'feat/x', operation: 'fetch' })).statusCode).toBe(
        404,
      );
    } finally {
      await setBilling(true);
    }
    // Switched on again, the branch room reads as before — from a dispatch whose people all read it (from billing-v2
    // it was refused while someone in it wasn't in the branch room, bp-automations BP-C35).
    expect(
      await tool(IDS.dusty, IDS.pr482, 'read_conversation', { conversationId: IDS.pr482 }),
    ).toMatchObject({
      status: 'ok',
    });
  });
});

describe('git credentials', () => {
  it('fetch: the connection’s token for a switched-on repo; push: only with the branch key', async () => {
    const d = await dispatchFor(IDS.dusty, IDS.billing);
    const fetch = await credentials(d.id, { repo: REPO, branch: 'feat/invoice-pdf', operation: 'fetch' });
    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({
      token: TOKEN,
      remoteUrl: 'https://github.fake.whombat.local/whombat/billing.git',
    });

    const sha = 'AB12'.padEnd(40, 'c');
    const push = await credentials(d.id, { repo: REPO, branch: 'feat/invoice-pdf', operation: 'push', sha });
    expect(push.statusCode).toBe(200);
    expect(push.json().token).toBe(fetch.json().token);
    // The push goes out as the connection's account: the grant says the commit it sends is Dusty's, for Mara in billing-v2.
    const [grant] = await t.services.db
      .select()
      .from(githubPushGrants)
      .where(and(eq(githubPushGrants.agentId, IDS.dusty), eq(githubPushGrants.dispatchId, d.id)));
    expect(grant).toMatchObject({ repo: REPO, branch: 'feat/invoice-pdf', sha: sha.toLowerCase() });
    expect(
      (await credentials(d.id, { repo: REPO, branch: 'feat/invoice-pdf', operation: 'push', sha: 'abc1234' }))
        .statusCode,
    ).toBe(400);

    const main = await credentials(d.id, { repo: REPO, branch: 'main', operation: 'push' });
    expect(main.statusCode).toBe(403);
    expect(main.json()).toMatchObject({ blocked: true, keyNeeded: { id: 'branch.main.push' } });

    // Without the branch key, no push.
    await setGrant(t.services, IDS.dusty, 'branch.feature.readwrite', 'cannot');
    try {
      const denied = await credentials(d.id, {
        repo: REPO,
        branch: 'feat/invoice-pdf',
        operation: 'push',
        sha,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ blocked: true });
    } finally {
      await setGrant(t.services, IDS.dusty, 'branch.feature.readwrite', 'can');
    }

    // Only live dispatches get credentials.
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.id));
    expect(
      (await credentials(d.id, { repo: REPO, branch: 'feat/invoice-pdf', operation: 'fetch' })).statusCode,
    ).toBe(409);
  });
});

describe('git in a conversation turn (resourceful-agents.md RA-DS72, RA-DS73)', () => {
  it('fetches as the turn’s gh does — what the runner’s git transport asks — and leaves nothing to push with', async () => {
    // A mention: no checkout, no run.
    const d = await dispatchFor(IDS.dusty, IDS.billing);
    const fetch = await credentials(d.id, { repo: REPO, branch: 'HEAD', operation: 'fetch' });
    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({ token: TOKEN });
    // Signed as the agent like any fetch, where it is the repository's.
    const [issued] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'git.credentials_issued'), eq(events.actorId, IDS.dusty)))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(issued).toMatchObject({
      where: `${REPO} · HEAD`,
      payload: { repo: REPO, branch: 'HEAD', operation: 'fetch' },
    });
    // A fetch makes no push grant: a push of that turn's would be no agent's.
    expect(
      await t.services.db.select().from(githubPushGrants).where(eq(githubPushGrants.dispatchId, d.id)),
    ).toEqual([]);
    // A repository that isn't switched on gets nothing, as for gh.
    expect(
      (await credentials(d.id, { repo: 'whombat/elsewhere', branch: 'HEAD', operation: 'fetch' })).statusCode,
    ).toBe(404);
  });
});

describe('merge into main', () => {
  const mergeUrl = `${api.prs.merge.base}${buildPath(api.prs.merge.path, { burrow: 'burrow-hq', number: 482 })}`;
  const merge = () =>
    t.api.inject({ method: 'POST', url: mergeUrl, headers: { cookie: mara }, payload: { method: 'squash' } });

  // Dusty's Merge row is Off (merge.main: cannot); On and Ask are merge-deploy.int.test.ts (runs-approvals.md MDS-03).
  it('is blocked for an agent whose Merge row is Off', async () => {
    const res = await tool(IDS.dusty, IDS.pr482, 'merge_pull_request', { prNumber: 482 });
    expect(res).toMatchObject({ status: 'blocked', keyNeeded: { id: 'merge.main' } });
  });

  it('is disabled until checks and review pass', async () => {
    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { details: { mergeBlock: 'checks' } } });
    const fake = fakeOf(t);
    const [row] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, 482));
    for (const name of ['unit · billing', 'pdf-snapshot'])
      await fake.simulateCheckRun({ repo: REPO, sha: row?.headSha ?? '', name, conclusion: 'success' });
    await syncGitHub(t);
    const review = await merge();
    expect(review.json()).toMatchObject({ error: { details: { mergeBlock: 'review' } } });
  });

  it('counts the person’s merge as the review of an agent’s PR GitHub shows as their own (MA-01)', async () => {
    // Dusty opened #482; Whombat acts on GitHub as `whombat`. Without Dusty's “changes requested” (a review nobody
    // gave), linked to Dusty, Mara's merge still needs a review.
    const [pr] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, 482));
    const reviews = await t.services.db
      .select()
      .from(prReviewers)
      .where(eq(prReviewers.prId, pr?.id ?? ''));
    await t.services.db.delete(prReviewers).where(eq(prReviewers.prId, pr?.id ?? ''));
    const link = (principalId: string) =>
      t.services.db
        .insert(githubIdentities)
        .values({ burrowId: t.burrowId, login: 'whombat', principalId })
        .onConflictDoUpdate({
          target: [githubIdentities.burrowId, githubIdentities.login],
          set: { principalId },
        });
    await link(IDS.dusty);
    expect((await merge()).json()).toMatchObject({ error: { details: { mergeBlock: 'review' } } });
    // Linked to Mara, the PR is hers on GitHub, where she can't approve it: her merge goes on to GitHub (here refused
    // for a stale head, so nothing merges yet).
    await link(IDS.mara);
    const onGitHub = fakeOf(t).repos.get(REPO)?.prs.get(482);
    if (!onGitHub) throw new Error('the fake has no PR #482');
    const head = onGitHub.headSha;
    onGitHub.headSha = 'beef'.repeat(10);
    const went = await merge();
    expect(went.statusCode).toBe(409);
    expect(went.json().error.message).toContain('Head branch was modified');
    onGitHub.headSha = head;
    await t.services.db.delete(githubIdentities).where(eq(githubIdentities.login, 'whombat'));
    await t.services.db.insert(prReviewers).values(reviews);
  });

  it('merges on GitHub for the person once green; a refusal there changes nothing', async () => {
    const approved = await t.commit(IDS.dusty, reviewPr, {
      prNumber: 482,
      decision: 'approve',
      body: '',
      comments: [],
    });
    expect(approved.status).toBe('ok');
    const fake = fakeOf(t);
    const onGitHub = fake.repos.get(REPO)?.prs.get(482);
    if (!onGitHub) throw new Error('the fake has no PR #482');

    // Someone pushed on GitHub meanwhile: GitHub refuses a merge of a stale head.
    const head = onGitHub.headSha;
    onGitHub.headSha = 'f00d'.repeat(10);
    const refused = await merge();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('Head branch was modified');
    const [still] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, 482));
    expect(still?.state).toBe('open');
    onGitHub.headSha = head;

    const res = await merge();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pr: { state: 'merged', mergedById: IDS.mara } });
    expect(onGitHub).toMatchObject({ state: 'closed', merged: true });
    // The next poll sees it closed on GitHub and does not merge it twice.
    await syncGitHub(t);
    const merged = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'pr.merged')));
    expect(merged.map((e) => [e.actorId, e.text])).toEqual([[IDS.mara, 'Merged PR #482 into main']]);
    expect(merged[0]?.payload).toMatchObject({ onGitHub: true });
  });
});
