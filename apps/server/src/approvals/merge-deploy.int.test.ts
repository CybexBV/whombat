/**
 * Merge and Deploy in three states (docs/decisions/runs-approvals.md MDS-01…MDS-07): an agent's Merge and Deploy rows,
 * Off · Ask · On, decide what its merge and deploy calls do. Off is blocked (and the agent may ask for the key, which a
 * person gives at Ask); Ask posts an approval card in the conversation and in the approver's Needs you, and a yes
 * carries it out; On runs without a card. Starts from Dusty's grants as they were on DEV (2026-10-01), with the stale
 * `merge.main: cannot` / `deploy: cannot` Configure's three-state rows have to overrule. Pushing to main from a
 * checkout stays refused whatever the Merge row says: it is the Push to main row's (agent-computer.md AC-41, AC-50), Off
 * by default, which the agent may now hold — at Ask a push of one commit waits for a person, at On it goes through.
 */
import {
  type ApprovalAction,
  configureGrants,
  configureKeyState,
  configureKeyTiers,
  type GrantInput,
  type KeyRowTiers,
  keyRowTier,
  runnerApi,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { performAction } from '../commands/agent-tools';
import { setAgentKeys } from '../commands/agents';
import { decideApproval, requestApproval } from '../commands/approvals';
import { reviewPr } from '../commands/prs';
import { approvals, dispatches, events, messages, pullRequests } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { callTool } from '../mcp/server';
import { loadGrants, loadPrincipalRow } from '../read/principals';
import { toApproval } from '../read/work';
import { workOverview } from '../read/work-overview';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, fakeOf, signInsEnv, syncGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { simulatedExecutor } from './engine';

const t = useTestServer({ seed: true, app: true, env: signInsEnv() });
const REPO = 'whombat/billing';
const RUNNER = { authorization: 'Bearer dev-runner-token' };

/** Dusty's keys on DEV when John couldn't give it Merge or Deploy (2026-10-01). */
const BANJO_DEV: GrantInput[] = [
  { keyId: 'branch.feature.readwrite', tier: 'can' },
  { keyId: 'tests.run', tier: 'can' },
  { keyId: 'pr.open', tier: 'can' },
  { keyId: 'branch.shared.push', tier: 'ask' },
  { keyId: 'merge.main', tier: 'cannot' },
  { keyId: 'deploy', tier: 'cannot' },
  { keyId: 'web.browse', tier: 'can' },
];

async function setKeys(grants: GrantInput[]) {
  const res = await t.commit(IDS.mara, setAgentKeys, { grants });
  expect(res.status).toBe('ok');
}

/** What Configure saves when a person moves one row (web and Android: `configureGrants` with the row's tiers). */
async function configureRow(row: keyof KeyRowTiers, tier: 'cannot' | 'ask' | 'can') {
  const held = await loadGrants(t.services.db, IDS.dusty);
  const state = configureKeyState(held);
  const baseTiers = configureKeyTiers(held);
  const next = configureGrants(held, {
    baseKeys: state,
    keys: state,
    baseTiers,
    tiers: { ...baseTiers, [row]: tier },
  });
  if (!next) throw new Error('Configure saved nothing');
  await setKeys(next);
}

/** A running turn of Dusty's in #billing-v2, queued as a mention: what asks the runner's routes for credentials. */
async function runningDispatch(): Promise<string> {
  const [queued] = await enqueueDispatches(t.services, {
    burrowId: t.burrowId,
    causedById: IDS.mara,
    conversationId: IDS.billing,
    messageId: null,
    threadRootId: null,
    requests: [{ agentId: IDS.dusty, trigger: 'mention', mode: 'reply' }],
    at: new Date(),
  });
  const id = queued?.dispatchId ?? '';
  await t.services.db
    .update(dispatches)
    .set({ state: 'running', runnerId: LEASE.runnerId, attempts: LEASE.attempt })
    .where(eq(dispatches.id, id));
  return id;
}

/** The runner holding a running turn: every call carries its lease whole (managed-sandbox.md MSB-10). */
const LEASE = { runnerId: 'rnr_merge-deploy', attempt: 1 };
const MAIN_SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';

/** The runner asks for credentials to push `MAIN_SHA` to main in that turn. */
const pushToMain = (dispatchId: string) =>
  t.api.inject({
    method: 'POST',
    url: `/internal/runner/dispatches/${dispatchId}/git-credentials`,
    headers: RUNNER,
    payload: { repo: REPO, branch: 'main', operation: 'push', sha: MAIN_SHA, ...LEASE },
  });

const mainRunInput = {
  conversationId: IDS.billing,
  title: 'Hotfix on main',
  repo: REPO,
  branch: 'main',
  steps: [{ title: 'Patch', detail: '' }],
};

const tiersOf = async () => {
  const grants = await loadGrants(t.services.db, IDS.dusty);
  return { merge: keyRowTier(grants, 'merge'), deploy: keyRowTier(grants, 'deploy') };
};

async function tool(name: string, args: Record<string, unknown>, conversationId: string = IDS.billing) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, conversationId);
  const auth: AgentAuth = { dispatchId, agentId: IDS.dusty, burrowId: t.burrowId };
  const res = await callTool(t.services, auth, name, args);
  return res.structuredContent as Record<string, unknown> & { error?: { code: string; message: string } };
}

async function approvalById(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('no approval');
  return toApproval(row);
}

/** An open PR of Dusty's into main on the fake GitHub, green and approved by Dusty: ready to merge. */
async function readyPr(branch: string): Promise<number> {
  const opened = await tool('open_pull_request', {
    repo: REPO,
    branch,
    base: 'main',
    title: `Ship ${branch}`,
    body: '',
  });
  expect(opened.status, JSON.stringify(opened)).toBe('ok');
  const number = opened.number as number;
  // A person reviews it: the agent never approves its own pull request (one-agent.md OA-01).
  const review = await t.commit(IDS.mara, reviewPr, {
    prNumber: number,
    decision: 'approve',
    body: '',
    comments: [],
  });
  expect(review.status).toBe('ok');
  return number;
}

const prState = async (number: number) =>
  (await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number)))[0];

const mergedEvents = async (number: number) =>
  (await t.services.db.select().from(events).where(eq(events.type, 'pr.merged'))).filter(
    (e) => (e.payload as { number?: number }).number === number,
  );

beforeAll(async () => {
  await setKeys(BANJO_DEV);
  // Agents' git runs on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
  await connectGitHubAs(t.services, IDS.mara);
});

describe('Merge (MD-03), from Dusty’s grants on DEV', () => {
  it('Off: blocked, naming the key; an approved key request gives the row at Ask (MD-04)', async () => {
    expect(await tiersOf()).toEqual({ merge: 'cannot', deploy: 'cannot' });
    const pr = await readyPr('feat/off');
    const blocked = await tool('merge_pull_request', { prNumber: pr });
    expect(blocked).toMatchObject({ status: 'blocked', keyNeeded: { id: 'merge.main' } });

    const asked = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: { type: 'grant_key', params: { keyId: 'merge.main' } },
      whatHappens: ['Merge my pull request into main'],
      explainer: '',
      summary: 'Mara asked me to merge my PR.',
    });
    if (asked.status !== 'ok') throw new Error(asked.status);
    await t.commit(IDS.mara, decideApproval, { number: asked.result.number, decision: 'approve' });
    expect(await tiersOf()).toEqual({ merge: 'ask', deploy: 'cannot' });
    const now = await tool('merge_pull_request', { prNumber: pr });
    expect(now).toMatchObject({ status: 'pending_approval' });
    await t.commit(IDS.mara, decideApproval, { number: now.approvalNumber as number, decision: 'decline' });
    expect((await prState(pr))?.state).toBe('open');
    await setKeys(BANJO_DEV);
  });

  it('Ask over the stale merge.main: cannot: a card in the conversation and Needs you; a yes merges on GitHub', async () => {
    await configureRow('merge', 'ask');
    const grants = await loadGrants(t.services.db, IDS.dusty);
    expect(grants.filter((g) => g.keyId.startsWith('merge')).map((g) => [g.keyId, g.tier])).toEqual(
      expect.arrayContaining([
        ['merge', 'ask'],
        ['merge.main', 'ask'],
      ]),
    );
    expect(await tiersOf()).toEqual({ merge: 'ask', deploy: 'cannot' });

    const pr = await readyPr('feat/ask');
    const res = await tool('merge_pull_request', { prNumber: pr });
    expect(res).toMatchObject({ status: 'pending_approval' });
    const approval = await approvalById(res.approvalId as string);
    expect(approval).toMatchObject({
      state: 'pending',
      requesterId: IDS.dusty,
      keyId: 'merge.main',
      action: { type: 'merge_pr', params: { prNumber: pr, repo: REPO, base: 'main' } },
      // Where Dusty was asked.
      conversationId: IDS.billing,
    });
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, approval.messageId ?? ''));
    expect(card).toMatchObject({ conversationId: IDS.billing, authorId: IDS.dusty });
    const mara = await loadPrincipalRow(t.services.db, IDS.mara);
    if (!mara) throw new Error('no Mara');
    const overview = await workOverview(t.services, mara, t.burrowId);
    const needsYou = overview.sections.find((s) => s.section === 'needs_you')?.items ?? [];
    expect(needsYou.map((i) => i.refs?.approvalId)).toContain(approval.id);
    expect((await prState(pr))?.state).toBe('open');

    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    const done = await approvalById(approval.id);
    expect(done.execution.state).toBe('succeeded');
    expect(await prState(pr)).toMatchObject({ state: 'merged', mergedById: IDS.mara });
    expect(fakeOf(t).repos.get(REPO)?.prs.get(pr)).toMatchObject({ state: 'closed', merged: true });
    // The person who said yes merges (EA-02, MDS-D02); Dusty is woken under the card.
    expect((await mergedEvents(pr)).map((e) => [e.actorId, e.text])).toEqual([
      [IDS.mara, `Merged PR #${pr} into main`],
    ]);
  });

  it('On: merges without a card; pushing to main from a checkout is still refused', async () => {
    await configureRow('merge', 'can');
    expect(await tiersOf()).toEqual({ merge: 'can', deploy: 'cannot' });
    const pr = await readyPr('feat/on');
    const before = (await t.services.db.select().from(approvals)).length;
    const res = await tool('merge_pull_request', { prNumber: pr });
    expect(res).toMatchObject({ status: 'ok', merged: true });
    expect((await t.services.db.select().from(approvals)).length).toBe(before);
    expect(await prState(pr)).toMatchObject({ state: 'merged', mergedById: IDS.dusty });
    expect(fakeOf(t).repos.get(REPO)?.prs.get(pr)).toMatchObject({ state: 'closed', merged: true });
    expect((await mergedEvents(pr)).map((e) => [e.actorId, e.text])).toEqual([
      [IDS.dusty, `Merged PR #${pr} into main`],
    ]);

    // Nobody but the person, whose account Whombat acts as on GitHub, could review it: an unreviewed PR merges at On
    // (MOA-02).
    const opened = await tool('open_pull_request', {
      repo: REPO,
      branch: 'feat/unreviewed',
      base: 'main',
      title: 'Unreviewed',
      body: '',
    });
    expect(await tool('merge_pull_request', { prNumber: opened.number as number })).toMatchObject({
      status: 'ok',
      merged: true,
    });

    // Merge On is not “Push to main”: with that row Off the runner gets no credentials for main, and no run starts on
    // it (MDS-D07).
    expect(keyRowTier(await loadGrants(t.services.db, IDS.dusty), 'branch.main.push')).toBe('cannot');
    const push = await pushToMain(await runningDispatch());
    expect(push.statusCode).toBe(403);
    expect(push.json()).toMatchObject({ blocked: true, keyNeeded: { id: 'branch.main.push' } });
    const run = await tool('start_run', mainRunInput);
    expect(run).toMatchObject({ status: 'blocked', keyNeeded: { id: 'branch.main.push' } });
  });

  it('Push to main (AC-41): On gives credentials for main and a run on it; Ask is a card for that commit; Off blocks', async () => {
    await configureRow('branch.main.push', 'can');
    const on = await pushToMain(await runningDispatch());
    expect(on.statusCode, on.body).toBe(200);
    expect(runnerApi.gitCredentials.response.parse(on.json()).remoteUrl).toContain(REPO);
    const run = await tool('start_run', mainRunInput);
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'ok' });

    // At Ask the push of exactly this commit waits for a person (EA-05): the card stays where it was asked (OP-S62).
    await configureRow('branch.main.push', 'ask');
    const ask = await pushToMain(await runningDispatch());
    expect(ask.statusCode, ask.body).toBe(202);
    expect(ask.json()).toMatchObject({ approvalRequired: true });
    const approval = await approvalById((ask.json() as { approvalId: string }).approvalId);
    expect(approval).toMatchObject({
      state: 'pending',
      requesterId: IDS.dusty,
      keyId: 'branch.main.push',
      conversationId: IDS.billing,
      action: { type: 'push_shared_branch', params: { repo: REPO, branch: 'main', sha: MAIN_SHA } },
    });
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'decline' });

    await configureRow('branch.main.push', 'cannot');
    const off = await pushToMain(await runningDispatch());
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ blocked: true, keyNeeded: { id: 'branch.main.push' } });
    await setKeys(BANJO_DEV);
  });

  it('a person merging the seeded PR is unchanged: checks and review first', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/prs/482/merge',
      headers: { cookie },
      payload: { method: 'squash' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { details: { mergeBlock: 'checks' } } });
  });

  it('Ask on a PR whose checks still run waits for them: approved in advance, it merges once green (MDS-D03)', async () => {
    await configureRow('merge', 'ask');
    const pr = await readyPr('feat/checks');
    const fake = fakeOf(t);
    const head = fake.repos.get(REPO)?.prs.get(pr)?.headSha ?? '';
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', conclusion: null });
    await syncGitHub(t);
    const res = await tool('merge_pull_request', { prNumber: pr });
    expect(res).toMatchObject({ status: 'pending_approval' });
    const approval = await approvalById(res.approvalId as string);
    expect(approval.conditions.map((c) => c.kind)).toEqual(['checks_pass', 'person_approves']);
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    expect((await approvalById(approval.id)).execution.state).toBe('idle');
    expect((await prState(pr))?.state).toBe('open');
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'unit', conclusion: 'success' });
    await syncGitHub(t);
    await t.services.approvals.reevaluate(t.burrowId);
    expect((await approvalById(approval.id)).execution.state).toBe('succeeded');
    expect(await prState(pr)).toMatchObject({ state: 'merged', mergedById: IDS.mara });
  });
});

describe('Deploy (MD-03, MD-05)', () => {
  const deploy: ApprovalAction = {
    type: 'deploy',
    params: {
      environment: 'staging',
      service: 'billing-api',
      ref: 'feat/invoice-pdf',
      sha: null,
      repo: REPO,
    },
  };
  const perform = () =>
    t.commit(IDS.dusty, performAction, { action: deploy, conversationId: IDS.billing, reason: 'Mara asked' });
  const hostInfo = async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/host',
      headers: { cookie },
    });
    return res.json() as { deployWorkflow?: boolean };
  };

  it('without a deploy workflow: the row can be set, host.info says so, a deploy answers as before', async () => {
    t.services.approvals.removeExecutor('deploy');
    expect((await hostInfo()).deployWorkflow).toBe(false);
    await configureRow('deploy', 'can');
    expect((await tiersOf()).deploy).toBe('can');
    await expect(perform()).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('no deploy workflow'),
    });
  });

  it('Off is blocked; Ask is a card a yes carries out; On deploys without one', async () => {
    t.services.approvals.setExecutor('deploy', simulatedExecutor);
    expect((await hostInfo()).deployWorkflow).toBe(true);

    await configureRow('deploy', 'cannot');
    const off = await perform();
    expect(off).toMatchObject({ status: 'blocked', keyNeeded: { id: 'deploy.staging' } });

    await configureRow('deploy', 'ask');
    expect((await tiersOf()).deploy).toBe('ask');
    const ask = await perform();
    if (ask.status !== 'pending_approval') throw new Error(ask.status);
    const approval = await approvalById(ask.approvalId);
    expect(approval).toMatchObject({
      state: 'pending',
      conversationId: IDS.billing,
      keyId: 'deploy.staging',
    });
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    expect((await approvalById(approval.id)).execution.state).toBe('succeeded');

    await configureRow('deploy', 'can');
    const before = (await t.services.db.select().from(approvals)).length;
    const on = await perform();
    expect(on).toMatchObject({ status: 'ok', result: { result: 'Deployed feat/invoice-pdf to staging' } });
    expect((await t.services.db.select().from(approvals)).length).toBe(before);
    const [performed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'action.performed'), eq(events.actorId, IDS.dusty)));
    expect(performed?.text).toBe('Deployed feat/invoice-pdf to staging');
  });
});
