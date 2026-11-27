/**
 * Coding work in automation runs (docs/decisions/bp-automations.md BP-C26…C29), on a real database with FAKE AGENTS
 * (test/automations.ts) and the in-memory FakeGitHub: the developer's branch key decides before it is asked (can /
 * asks → a person, and the push runs under that approval / no → Blocked); a coding step succeeds only with new
 * commits; a verdict step needs “Approve” or “Changes needed”; a pull request that can't be opened is posted for a
 * person; failures say so once in the thread the run started from; a report in a thread works, and replies in a
 * thread the automation is working on start nothing new. Plus: an approved `start_run` wakes its agent.
 */
import { type AutomationDefinitionInput, newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { approvals, automations, dispatches, events, grants, pullRequests, runs } from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import { authorizeGit } from '../runtime/git';
import { IDS, useAutomationWorld } from '../test/automations';
import { controlAutomationRun } from './commands';
import { approvedPushFor } from './workspace';

const w = useAutomationWorld();
const BILLING = IDS.billing;
const REPO = 'whombat/billing';

async function setBanjo(keyId: string, tier: 'can' | 'ask' | 'cannot') {
  await w.services.db
    .update(grants)
    .set({ tier })
    .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, keyId)));
}

/** A reported bug (keyword `word`) → the developer fixes it on `feat/<word>-<run>` → a message with the result. */
function fixDefinition(word: string, room: string = BILLING): AutomationDefinitionInput {
  return {
    version: 1,
    conversationId: room,
    triggers: [{ kind: 'message_posted', conversationId: room, contains: [word], includeReplies: true }],
    steps: [
      {
        id: 'implement',
        kind: 'dispatch_agent',
        prompt: 'Fix it: {{trigger.text}}',
        workspace: { repo: REPO, branch: `feat/${word}-{{run.number}}`, access: 'write' },
      },
      { id: 'done', kind: 'post_message', text: 'Fixed: {{steps.implement.text}}' },
    ],
    limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
  };
}

async function report(text: string, threadRootId?: string, by: string = IDS.mara, room: string = BILLING) {
  const sent = await w.ok(by, sendMessage, {
    conversationId: room,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  await w.settle();
  return sent.id;
}

async function onlyRun(automationId: string) {
  const all = await w.runs(automationId);
  expect(all).toHaveLength(1);
  return all[0] as NonNullable<(typeof all)[number]>;
}

/** The automation's posts in its run's thread (in the publisher's Chat, where the run posts). */
async function threadPosts(automationId: string, runId: string) {
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  return w.runThread(runId, a?.principalId as string);
}

describe('a coding step', () => {
  it('asks a person when the developer’s branch key asks; the push then runs under that approval', async () => {
    await setBanjo('branch.feature.readwrite', 'ask');
    const id = await w.publish(fixDefinition('kaput'), { name: 'Fix on ask' });
    await report('The totals are kaput again');
    let run = await onlyRun(id);
    // Nobody was asked yet: the step waits for a person, with the branch key's own label.
    expect(run.steps[0]?.state).toBe('waiting');
    expect(run.steps[0]?.dispatchId).toBeNull();
    const [asked] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, run.steps[0]?.approvalId as string));
    expect(asked?.keyId).toBe('branch.feature.readwrite');
    expect(asked?.title).toBe(`Let Dusty work on feat/kaput-${run.number} in ${REPO}`);
    expect((await w.dispatchesOf('automation')).filter((d) => d.agentId === IDS.dusty)).toHaveLength(0);

    await w.ok(IDS.mara, decideApproval, { number: asked?.number as number, decision: 'approve' });
    await w.settle();
    run = await w.run(run.id);
    expect(run.steps[0]?.state).toBe('waiting');
    const dispatchId = run.steps[0]?.dispatchId as string;
    expect(dispatchId).toBeTruthy();
    expect(run.steps[0]?.output.workspace).toEqual({
      repo: REPO,
      branch: `feat/kaput-${run.number}`,
      baseBranch: 'main',
      defaultBranch: 'main',
      access: 'write',
    });

    // The push the agent's key asks for runs under this approval — for exactly this dispatch, repo and branch.
    const branch = `feat/kaput-${run.number}`;
    expect(await approvedPushFor(w.services.db, dispatchId, REPO, branch)).toBe(asked?.id);
    expect(await approvedPushFor(w.services.db, dispatchId, REPO, 'feat/other')).toBeNull();
    const push = { repo: REPO, branch, operation: 'push' as const };
    const withApproval = await w.commit(IDS.dusty, authorizeGit, {
      ...push,
      stepApproval: { dispatchId, approvalId: asked?.id as string },
    });
    expect(withApproval.status).toBe('ok');
    // The approval covers that branch only.
    await expect(
      w.commit(IDS.dusty, authorizeGit, {
        ...push,
        branch: 'feat/other',
        stepApproval: { dispatchId, approvalId: asked?.id as string },
      }),
    ).rejects.toThrow('A person has to approve this push first.');
    // Without the step's approval (and without a commit to ask about) the push doesn't go through (EA-05).
    await expect(w.commit(IDS.dusty, authorizeGit, push)).rejects.toThrow(
      'A person has to approve this push first.',
    );

    await w.fakePush(REPO, branch, 'Round per line');
    await w.fakeAgentReply(dispatchId, 'Rounded per line, with a test.');
    await w.settle();
    run = await w.run(run.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output.commits).toBe(1);
    expect((await threadPosts(id, run.id)).map((m) => m.text)).toContain(
      'Fixed: Rounded per line, with a test.',
    );
    await setBanjo('branch.feature.readwrite', 'can');
  });

  it('classifies the branch against the repository’s default branch, not the step’s base (BP-C36)', async () => {
    // `main` with a base of another branch is still main: pushing to main is for people (“Push to main”, runs-approvals.md
    // MDS-01), so the step is Blocked (before, `branchWriteKey(main, base)` made it a shared branch the agent might hold).
    const shared = and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'branch.shared.push'));
    const [kept] = await w.services.db.select().from(grants).where(shared);
    if (kept) await w.services.db.update(grants).set({ tier: 'can' }).where(shared);
    else
      await w.services.db.insert(grants).values({
        burrowId: w.burrowId,
        agentId: IDS.dusty,
        keyId: 'branch.shared.push',
        tier: 'can',
        position: 98,
      });
    const dispatchesBefore = (await w.dispatchesOf('automation')).filter(
      (d) => d.agentId === IDS.dusty,
    ).length;
    const def = fixDefinition('mainly');
    const step = def.steps[0];
    if (step?.kind !== 'dispatch_agent' || !step.workspace) throw new Error('fixture');
    step.workspace = { repo: REPO, branch: 'main', base: 'feat/elsewhere', access: 'write' };
    const id = await w.publish(def, { name: 'Write main' });
    await report('Mainly broken');
    const run = await onlyRun(id);
    expect(run.steps[0]?.state).toBe('blocked');
    expect(run.error).toBe('Dusty may not work on main: it doesn’t hold “Push to main”.');
    const dispatchesAfter = (await w.dispatchesOf('automation')).filter(
      (d) => d.agentId === IDS.dusty,
    ).length;
    expect(dispatchesAfter).toBe(dispatchesBefore);
    if (kept) await w.services.db.update(grants).set({ tier: kept.tier }).where(shared);
    else await w.services.db.delete(grants).where(shared);
  });

  it('is Blocked when the developer may not write the branch, and says so once in the thread', async () => {
    await setBanjo('branch.feature.readwrite', 'cannot');
    const id = await w.publish(fixDefinition('smashed'), { name: 'Fix on no' });
    await report('Invoices are smashed');
    const run = await onlyRun(id);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.state).toBe('blocked');
    expect(run.error).toBe(
      'Dusty may not work on feat/smashed-' +
        run.number +
        ': it doesn’t hold “Read and write feat/* branches”.',
    );
    const blocked = await w.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'action.blocked'), eq(events.aboutId, IDS.dusty)));
    expect(blocked.length).toBeGreaterThan(0);
    await w.settle();
    const notices = (await threadPosts(id, run.id)).filter((m) => m.text.startsWith('“Fix on no”'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('didn’t finish');
    expect(notices[0]?.text).toContain(String(run.error));
    expect(notices[0]?.text).toContain(`(http://localhost:5180/burrow-hq/automation-runs/${run.number})`);
    expect((await w.dispatchesOf('automation')).filter((d) => d.agentId === IDS.dusty)).toHaveLength(1);
    await setBanjo('branch.feature.readwrite', 'can');
  });

  it('fails when the developer committed nothing, with what it said, once in the thread', async () => {
    const id = await w.publish(fixDefinition('wonky'), { name: 'Fix or say why' });
    await report('The PDF totals look wonky');
    let run = await onlyRun(id);
    await w.fakeAgentReply(
      run.steps[0]?.dispatchId as string,
      'I can’t reproduce it on main.\nThe totals match finance.',
    );
    await w.settle();
    run = await w.run(run.id);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.error).toBe(
      `Dusty finished without new commits on feat/wonky-${run.number}. It said: “I can’t reproduce it on main.”`,
    );
    await w.settle();
    const notices = (await threadPosts(id, run.id)).filter((m) => m.text.startsWith('“Fix or say why”'));
    expect(notices).toHaveLength(1);
    const [notice] = notices.map((m) => m.text);
    expect(notice).not.toContain(`#${run.number}`);
    expect(notice).toContain(`feat/wonky-${run.number}`);
    expect(notice).toContain(`/burrow-hq/automation-runs/${run.number}`);
  });
});

describe('a person’s Cancel', () => {
  it('is said once in the thread, by the automation', async () => {
    const id = await w.publish(fixDefinition('janky'), { name: 'Fix, then stop' });
    await report('The totals page is janky');
    const run = await onlyRun(id);
    await w.ok(IDS.mara, controlAutomationRun, { number: run.number, action: 'cancel' });
    await w.settle();
    expect((await w.run(run.id)).status).toBe('cancelled');
    const notices = (await threadPosts(id, run.id)).filter((m) => m.text.startsWith('“Fix, then stop”'));
    expect(notices.map((m) => m.text)).toEqual([
      `“Fix, then stop” was stopped. Cancelled by Mara. [See what happened](http://localhost:5180/burrow-hq/automation-runs/${run.number})`,
    ]);
  });
});

describe('a review step', () => {
  function reviewDefinition(word: string): AutomationDefinitionInput {
    return {
      version: 1,
      conversationId: BILLING,
      triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: [word] }],
      steps: [
        {
          id: 'review',
          kind: 'dispatch_agent',
          prompt: 'Review feat/x.',
          workspace: { repo: REPO, branch: 'feat/x', access: 'read' },
          verdict: true,
        },
        { id: 'ok', kind: 'condition', if: 'steps.review.verdict == "approve"', else: 'stop' },
        { id: 'ship', kind: 'post_message', text: 'Shipping it.' },
      ],
      limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
    };
  }

  it('reads a read-only checkout and stops without shipping when the reviewer asks for changes', async () => {
    const id = await w.publish(reviewDefinition('glitchy'), { name: 'Review' });
    await report('The export looks glitchy');
    let run = await onlyRun(id);
    expect(run.steps[0]?.output.workspace).toMatchObject({ branch: 'feat/x', access: 'read' });
    await w.fakeAgentReply(run.steps[0]?.dispatchId as string, 'Changes needed: the test never fails.');
    await w.settle();
    run = await w.run(run.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output.verdict).toBe('changes_needed');
    expect(run.steps.map((s) => s.state)).toEqual(['succeeded', 'succeeded', 'skipped']);
  });

  it('fails when the reviewer gives no verdict', async () => {
    const id = await w.publish(reviewDefinition('flaky'), { name: 'Review strictly' });
    await report('Checkout is flaky');
    let run = await onlyRun(id);
    await w.fakeAgentReply(run.steps[0]?.dispatchId as string, 'Looks fine to me.');
    await w.settle();
    run = await w.run(run.id);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.error).toBe(
      'Dusty didn’t start its reply with “Approve” or “Changes needed”. It said: “Looks fine to me.”',
    );
  });
});

describe('a pull request that can’t be opened', () => {
  it('is posted for a person in the thread, with why', async () => {
    const id = await w.publish(
      {
        version: 1,
        conversationId: BILLING,
        triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: ['busted'] }],
        steps: [
          {
            id: 'pr',
            kind: 'open_pull_request',
            repo: REPO,
            branch: 'feat/busted',
            base: 'release/none',
            title: 'Fix the busted totals',
          },
          { id: 'report', kind: 'post_message', text: 'Done: {{steps.pr.text}}' },
        ],
        limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
      },
      { name: 'Open it', grants: [{ keyId: 'pr.open', tier: 'can', repos: [REPO] }] },
    );
    await report('Totals are busted');
    const run = await onlyRun(id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output.opened).toBe(false);
    const posts = (await threadPosts(id, run.id)).map((m) => m.text);
    expect(posts[0]).toMatch(
      /^The pull request is ready to open \(opening it failed: Validation Failed: base release\/none\):\n\nFrom feat\/busted into release\/none\nTitle: Fix the busted totals/,
    );
    expect(posts[1]).toMatch(
      /^Done: the pull request from feat\/busted into whombat\/billing is ready for a person to open \(opening it failed: /,
    );
  });
});

describe('GitHub failing for a moment while the pull request opens', () => {
  function openDefinition(word: string): AutomationDefinitionInput {
    return {
      version: 1,
      conversationId: BILLING,
      triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: [word] }],
      steps: [
        {
          id: 'pr',
          kind: 'open_pull_request',
          repo: REPO,
          branch: `feat/${word}`,
          title: `Fix the ${word} totals`,
          body: 'Rounds once.',
          otherwise: 'post_payload',
        },
        { id: 'report', kind: 'post_message', text: 'Done: {{steps.pr.text}}' },
      ],
      limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
    };
  }

  const fake = () => {
    const f = w.services.github.fake;
    if (!f) throw new Error('no FakeGitHub');
    return f;
  };

  async function started(word: string) {
    const id = await w.publish(openDefinition(word), {
      name: `Open it (${word})`,
      grants: [{ keyId: 'pr.open', tier: 'can', repos: [REPO] }],
    });
    await report(`Totals are ${word}`);
    return { id, run: await onlyRun(id) };
  }

  it('opens it on the next try after a 500', async () => {
    fake().failOpens.push({ error: new GitHubError('HTTP 500', 500) });
    const { run: first } = await started('wonky');
    expect(first.steps[0]).toMatchObject({ state: 'pending', error: expect.stringContaining('tried again') });
    w.advance(30_000);
    await w.settle();
    const run = await w.run(first.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output).toMatchObject({ opened: true, githubRetries: { open: 1 } });
    expect(run.steps[0]?.output.alreadyOpen).toBeUndefined();
    expect(
      await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, 'feat/wonky')),
    ).toHaveLength(1);
  });

  it('finds the pull request GitHub opened although it answered 500, and doesn’t post its body again', async () => {
    fake().failOpens.push({ error: new GitHubError('HTTP 502', 502), afterOpening: true });
    const comments = fake().comments.length;
    const { run: first } = await started('lumpy');
    expect(first.steps[0]?.state).toBe('pending');
    // The mirror reads the repository before the next try.
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    w.advance(30_000);
    await w.settle();
    const run = await w.run(first.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output).toMatchObject({ opened: true, alreadyOpen: true });
    expect(fake().comments.length).toBe(comments);
    expect(
      await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, 'feat/lumpy')),
    ).toHaveLength(1);
  });

  it('is posted for a person after three tries that GitHub didn’t answer', async () => {
    for (let i = 0; i < 3; i++) fake().failOpens.push({ error: new GitHubError('HTTP 503', 503) });
    const { id, run: first } = await started('soggy');
    expect(first.steps[0]?.state).toBe('pending');
    w.advance(30_000);
    await w.settle();
    expect((await w.run(first.id)).steps[0]?.state).toBe('pending');
    w.advance(2 * 60_000);
    await w.settle();
    const run = await w.run(first.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output).toMatchObject({ opened: false });
    expect(fake().failOpens).toHaveLength(0);
    expect((await threadPosts(id, run.id))[0]?.text).toContain('opening it failed: HTTP 503');
  });

  it('is posted for a person at once when GitHub refuses it', async () => {
    fake().failOpens.push({ error: new GitHubError('Validation Failed', 422) });
    const { id, run } = await started('crumbly');
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output).toMatchObject({ opened: false });
    expect(run.steps[0]?.output.githubRetries).toBeUndefined();
    expect((await threadPosts(id, run.id))[0]?.text).toContain('opening it failed: Validation Failed');
  });
});

describe('a pull request that is already open from the branch (AR-41)', () => {
  function prDefinition(word: string): AutomationDefinitionInput {
    return {
      version: 1,
      conversationId: BILLING,
      triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: [word] }],
      steps: [
        {
          id: 'pr',
          kind: 'open_pull_request',
          repo: REPO,
          branch: `feat/${word}`,
          title: `Fix the ${word} totals`,
          otherwise: 'post_payload',
        },
        { id: 'report', kind: 'post_message', text: 'Done: {{steps.pr.text}}' },
      ],
      limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
    };
  }

  /** The pull request the developer agent opened itself during its turn. */
  async function openedByTheAgent(branch: string, number: number) {
    await w.services.db.insert(pullRequests).values({
      id: newId('pullRequest'),
      burrowId: w.burrowId,
      repoId: 'rep_billing',
      number,
      branch,
      baseBranch: 'main',
      title: 'Opened by Dusty',
      state: 'open',
      headSha: 'abc1234',
      authorId: IDS.dusty,
      conversationId: BILLING,
      openedAt: w.services.clock(),
      url: `https://github.com/${REPO}/pull/${number}`,
    });
  }

  async function prsFrom(branch: string) {
    return w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
  }

  it('is the step’s pull request: nothing is opened, nothing posted for a person', async () => {
    const id = await w.publish(prDefinition('wobbly'), {
      name: 'Open it',
      grants: [{ keyId: 'pr.open', tier: 'can', repos: [REPO] }],
    });
    await openedByTheAgent('feat/wobbly', 812);
    await report('Totals are wobbly');
    const run = await onlyRun(id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({
      state: 'succeeded',
      prNumber: 812,
      inputSummary: 'PR #812 was already open from feat/wobbly',
    });
    expect(run.steps[0]?.output).toMatchObject({
      opened: true,
      alreadyOpen: true,
      prNumber: 812,
      text: `PR #812 is open: https://github.com/${REPO}/pull/812`,
    });
    expect(await prsFrom('feat/wobbly')).toHaveLength(1);
    // The step says where it is (RN-S4); no body to comment, so nothing goes on GitHub (RN-S3d).
    expect((await threadPosts(id, run.id)).map((m) => m.text)).toEqual([
      `[PR #812](https://github.com/${REPO}/pull/812) was already open.`,
      `Done: PR #812 is open: https://github.com/${REPO}/pull/812`,
    ]);
  });

  it('needs no key to use it', async () => {
    const id = await w.publish(prDefinition('jumpy'), { name: 'Open it without a key' });
    await openedByTheAgent('feat/jumpy', 813);
    await report('Totals are jumpy');
    const run = await onlyRun(id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output).toMatchObject({ alreadyOpen: true, prNumber: 813 });
  });

  it('opened while a person decided: their yes uses it', async () => {
    const id = await w.publish(prDefinition('shaky'), {
      name: 'Ask to open it',
      grants: [{ keyId: 'pr.open', tier: 'ask', repos: [REPO] }],
    });
    await report('Totals are shaky');
    let run = await onlyRun(id);
    expect(run.steps[0]?.state).toBe('waiting');
    const [asked] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, run.steps[0]?.approvalId as string));
    await openedByTheAgent('feat/shaky', 814);
    await w.ok(IDS.mara, decideApproval, { number: asked?.number as number, decision: 'approve' });
    await w.settle();
    run = await w.run(run.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({ state: 'succeeded', prNumber: 814 });
    expect(run.steps[0]?.output).toMatchObject({ opened: true, alreadyOpen: true, prNumber: 814 });
    expect(await prsFrom('feat/shaky')).toHaveLength(1);
    expect((await threadPosts(id, run.id)).map((m) => m.text)).toEqual([
      'I need a person to say yes before I go on: Open a pull request from feat/shaky',
      `[PR #814](https://github.com/${REPO}/pull/814) was already open.`,
      `Done: PR #814 is open: https://github.com/${REPO}/pull/814`,
    ]);
  });
});

describe('reports in threads', () => {
  it('start a run in their thread of the publisher’s Chat; replies there while it runs start nothing new', async () => {
    // A run keeps the thread it was started from in its publisher's own room (automations/rooms.ts).
    const CHAT = IDS.dmDusty;
    const id = await w.publish(fixDefinition('borked', CHAT), { name: 'Thread reports' });
    const topic = await w.ok(IDS.mara, sendMessage, { conversationId: CHAT, text: 'Invoice run today' });
    const rootId = topic.id;
    await report('The Belgian invoices are borked', rootId, IDS.mara, CHAT);
    const run = await onlyRun(id);
    expect(run.conversationId).toBe(CHAT);
    expect(run.threadRootId).toBe(rootId);
    // The agent is asked in that thread.
    const [d] = await w.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, run.steps[0]?.dispatchId as string));
    expect(d?.threadRootId).toBe(rootId);
    await report('Still borked for Dutch ones too', rootId, IDS.mara, CHAT);
    expect(await w.runs(id)).toHaveLength(1);
  });

  it('in another room: the run posts in the publisher’s Chat, and replies in the report’s thread start nothing new', async () => {
    const id = await w.publish(fixDefinition('mangled'), { name: 'Thread reports elsewhere' });
    const topic = await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: 'Credit notes today' });
    await report('The credit notes are mangled', topic.id);
    const run = await onlyRun(id);
    expect(run.conversationId).toBe(IDS.dmDusty);
    expect(run.threadRootId).not.toBe(topic.id);
    await report('Still mangled for refunds too', topic.id);
    expect(await w.runs(id)).toHaveLength(1);
  });
});

describe('an approved start_run', () => {
  it('wakes the agent on its run (outside automations too)', async () => {
    const res = await w.commit(IDS.dusty, startRun, {
      conversationId: BILLING,
      title: 'Hotfix the release totals',
      repo: REPO,
      branch: 'release/2.4',
      steps: [{ title: 'Fix it', detail: '' }],
    });
    expect(res.status).toBe('pending_approval');
    if (res.status !== 'pending_approval') return;
    await w.ok(IDS.mara, decideApproval, { number: res.approvalNumber, decision: 'approve' });
    let run: typeof runs.$inferSelect | undefined;
    for (let i = 0; i < 50 && !run; i++) {
      [run] = await w.services.db.select().from(runs).where(eq(runs.branch, 'release/2.4'));
      if (!run) await new Promise((r) => setTimeout(r, 100));
    }
    expect(run?.status).toBe('live');
    let woken: (typeof dispatches.$inferSelect)[] = [];
    for (let i = 0; i < 50 && woken.length === 0; i++) {
      woken = await w.services.db
        .select()
        .from(dispatches)
        .where(and(eq(dispatches.runId, run?.id as string), eq(dispatches.agentId, IDS.dusty)));
      if (!woken.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(woken.map((d) => [d.mode, d.trigger, d.state])).toEqual([['run', 'run_control', 'queued']]);
  });
});
