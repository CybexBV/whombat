/**
 * An agent's gh through Whombat against a real Postgres and the fake GitHub (docs/decisions/agent-gh.md):
 * `runner.ghAuthorize` end to end — a read runs with the agent's token and the repo, a write goes by the plan's key
 * (On runs and signs `github.gh`, Off is Blocked and 126, Ask is one card in the turn's thread and 125, the yes lets the
 * identical command run once), `gh pr create`, `merge` and `review` are Whombat's own commands, refusals, a lost lease,
 * `DispatchContext.gh` (AGH-12) and the commands' guard leaving gh alone (AGH-11).
 */
import { type KeyId, keyRowTier, newId, type Tier } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyAgain } from '../agent-commands/commands';
import { liveDispatch, RUNNER, runnerCall, threadRoot } from '../agent-commands/testing';
import { decideApproval, requestApproval } from '../commands/approvals';
import { approvals, dispatches, events, grants, messages, repos } from '../db/schema/index';
import { loadGrants } from '../read/principals';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import type { Services } from '../services';
import { setGrant } from '../test/approvals';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { waitFor } from '../test/runner';
import { ghHash } from './agent-gh';
import { agentGhOn, ghContextFor, useAgentGhForTests } from './agent-gh-context';
import { FAKE_LOGIN } from './fake';

const t = useTestServer({ seed: true, app: true, env: signInsEnv() });
const REPO = 'whombat/billing';
let root = '';

async function grant(keyId: KeyId, tier: Tier) {
  await setGrant(t.services, IDS.dusty, keyId, tier);
}

function gh(
  dispatchId: string,
  args: string[],
  more: { files?: { path: string; base64: string }[]; stdin?: string | null; attempt?: number } = {},
) {
  return runnerCall(
    t,
    'POST',
    '/dispatches/:dispatchId/gh',
    { dispatchId },
    {
      runnerId: RUNNER,
      attempt: more.attempt ?? 1,
      args,
      files: more.files ?? [],
      stdin: more.stdin ?? null,
    },
  );
}

const ghEvents = () =>
  t.services.db.select().from(events).where(eq(events.type, 'github.gh')).orderBy(desc(events.seq));

async function approvalByNumber(number: number) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.number, number));
  if (!row) throw new Error('no approval');
  return row;
}

const numberIn = (stderr: unknown) => Number(/approval #(\d+)/.exec(String(stderr))?.[1]);

beforeAll(async () => {
  useAgentGhForTests(t.services);
  // The burrow's GitHub is Mara's own sign-in (HE-S166): agents' gh runs with its token.
  await connectGitHubAs(t.services, IDS.mara, { login: FAKE_LOGIN, token: 'gho_fake_mara' });
  // The test world's Dusty also holds “Change code” (the same key as “Write code”) at cannot: the cases set Write code.
  await t.services.db
    .delete(grants)
    .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'code.change')));
  root = await threadRoot(t, IDS.mara, IDS.billing, '@Dusty please tidy the billing issues');
});

describe('DispatchContext.gh (AGH-12)', () => {
  it('a turn gets the switched-on GitHub repositories and the default one', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const context = await buildDispatchContext(t.services, d);
    expect(context.gh).toEqual({ repos: [REPO], defaultRepo: REPO });
  });

  it('not for a Feedback assessment, a search answer or a read-only checkout; connected is enough (AR-02)', async () => {
    const row = { burrowId: t.burrowId, trigger: 'mention' as const, search: null };
    expect(await ghContextFor(t.services, { ...row, trigger: 'feedback' }, null)).toBeNull();
    expect(
      await ghContextFor(t.services, { ...row, search: { query: 'x', answerId: 'ans_1' } }, null),
    ).toBeNull();
    const readOnly = {
      repo: REPO,
      branch: 'main',
      baseBranch: 'main',
      defaultBranch: 'main',
      cloneUrl: '',
      access: 'read' as const,
      writeApproved: false,
    };
    expect(await ghContextFor(t.services, row, readOnly)).toBeNull();
    expect(await ghContextFor(t.services, row, { ...readOnly, access: 'write' })).toEqual({
      repos: [REPO],
      defaultRepo: REPO,
    });
    await t.services.db.update(repos).set({ enabled: false }).where(eq(repos.fullName, REPO));
    try {
      // No switched-on repository yet: gh is there, and a repository it names is added (agent-repos.md AGR-01).
      expect(await ghContextFor(t.services, row, null)).toEqual({ repos: [], defaultRepo: null });
    } finally {
      await t.services.db.update(repos).set({ enabled: true }).where(eq(repos.fullName, REPO));
    }
  });

  it('with GitHub mode gh only (the fake only behind the test seam)', () => {
    const fake = (mode: string) =>
      ({ config: { NODE_ENV: 'test' }, github: { mode, fake: null } }) as unknown as Services;
    expect(agentGhOn(fake('gh'))).toBe(true);
    expect(agentGhOn(fake('fake'))).toBe(false);
    expect(agentGhOn(fake('off'))).toBe(false);
  });

  it('a turn without it is told so', async () => {
    const d = await liveDispatch(t, { threadRootId: root, trigger: 'feedback' });
    const res = await gh(d.id, ['pr', 'list']);
    expect(res.body).toEqual({
      outcome: 'done',
      exitCode: 1,
      stdout: '',
      stderr: 'gh doesn’t go through Whombat in this turn.\n',
    });
  });
});

describe('reads (AGH-06)', () => {
  it('run with the agent’s token and the repo, -R taken out', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, ['pr', 'list', '-R', 'WHOMBAT/billing', '--state', 'open']);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'run', args: ['pr', 'list', '--state', 'open'], repo: REPO });
    expect(String(res.body.token)).toMatch(/^gho_fake_/);
    // Reads sign nothing.
    expect(await ghEvents()).toHaveLength(0);
  });

  it('a repository the connection reaches is added for agents the first time one names it (agent-repos.md AR-01)', async () => {
    await t.services.github.fake?.addRepo({ fullName: 'whombat/docs', defaultBranch: 'main' });
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, ['issue', 'list', '-R', 'whombat/docs']);
    expect(res.body).toMatchObject({ outcome: 'run', args: ['issue', 'list'], repo: 'whombat/docs' });
    const [row] = await t.services.db.select().from(repos).where(eq(repos.fullName, 'whombat/docs'));
    expect(row).toMatchObject({ enabled: true, source: 'github' });
    const [added] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'repo.added'), eq(events.where, 'whombat/docs')));
    expect(added).toMatchObject({ actorId: IDS.dusty, text: 'Added whombat/docs' });
    // The next turn has it among its repositories.
    const next = await buildDispatchContext(t.services, await liveDispatch(t, { threadRootId: root }));
    expect(next.gh?.repos).toContain('whombat/docs');
    // The other tests expect the seeded burrow's one switched-on repository.
    await t.services.db.delete(repos).where(eq(repos.fullName, 'whombat/docs'));
  });

  it('help runs with no repo', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['issue', 'comment', '--help'])).body).toMatchObject({
      outcome: 'run',
      args: ['help', 'issue', 'comment'],
      repo: null,
    });
  });
});

describe('refusals (AGH-04, AGH-05, AGH-08)', () => {
  it('a repo that isn’t switched on, a repo kept on this Whombat, a refused command', async () => {
    await t.services.db.insert(repos).values({
      id: newId('repo'),
      burrowId: t.burrowId,
      fullName: 'local/notes',
      enabled: true,
      source: 'local',
      position: 9,
    });
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['issue', 'list', '-R', 'whombat/web'])).body).toEqual({
      outcome: 'done',
      exitCode: 1,
      stdout: '',
      stderr:
        'whombat/web isn’t one this Whombat’s GitHub sign-in works on. A public repository still clones with git.\n',
    });
    // Switched off by a person: it stays off (agent-repos.md AGR-03).
    const [web] = await t.services.db.select().from(repos).where(eq(repos.fullName, 'whombat/web'));
    expect(web?.enabled).toBe(false);
    // Not the burrow's and not one the connection can push to: used as it is, nothing added (AGH-23); GitHub says
    // whether it exists.
    expect((await gh(d.id, ['issue', 'list', '-R', 'evil/x'])).body).toMatchObject({
      outcome: 'run',
      args: ['issue', 'list'],
      repo: 'evil/x',
    });
    expect(await t.services.db.select().from(repos).where(eq(repos.fullName, 'evil/x'))).toEqual([]);
    expect((await gh(d.id, ['issue', 'list', '-R', 'local/notes'])).body).toMatchObject({
      exitCode: 1,
      stderr: 'local/notes is kept on this Whombat, not on GitHub: use git and open_pull_request.\n',
    });
    expect((await gh(d.id, ['auth', 'token'])).body).toMatchObject({
      exitCode: 1,
      stderr:
        'gh is already signed in through Whombat as this Whombat’s GitHub connection; its token stays with Whombat.\n',
    });
  });

  it('more than 1 MiB of files and stdin is refused', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const big = Buffer.alloc(1024 * 1024 + 1, 'a').toString('base64');
    expect(
      (await gh(d.id, ['issue', 'comment', '1', '-F', 'a.md'], { files: [{ path: 'a.md', base64: big }] }))
        .body,
    ).toMatchObject({ exitCode: 1, stderr: 'gh can read at most 1 MiB of files and stdin together here.\n' });
  });

  it('a runner that lost the dispatch gets a 409', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['pr', 'list'], { attempt: 2 })).status).toBe(409);
  });
});

describe('writes go by the agent’s keys (AGH-06, AGH-13)', () => {
  it('On: runs, the body signed, and signs github.gh first', async () => {
    await grant('pr.comment', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, ['issue', 'comment', '12', '-b', 'Fixed in #13.']);
    expect(res.body).toMatchObject({
      outcome: 'run',
      args: ['issue', 'comment', '12', '-b', 'Fixed in #13.\n\n— Dusty via Whombat'],
      repo: REPO,
    });
    const [event] = await ghEvents();
    expect(event).toMatchObject({
      actorId: IDS.dusty,
      kind: 'Code',
      text: 'Ran gh issue comment 12 on whombat/billing',
      where: REPO,
      payload: { repo: REPO, words: ['issue', 'comment', '12'], keyId: 'pr.comment' },
    });
    expect(event?.payload).not.toHaveProperty('approvalId');
    expect(String(event?.payload.ghHash)).toMatch(/^[0-9a-f]{64}$/);
    // The body never reaches the log.
    expect(JSON.stringify(event)).not.toContain('Fixed in #13');
  });

  it('Off: a signed Blocked event and exit 126 with the pipeline’s sentence', async () => {
    await grant('pipelines.retry', 'cannot');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, ['run', 'rerun', '99']);
    expect(res.body).toMatchObject({ outcome: 'done', exitCode: 126, stdout: '' });
    expect(String(res.body.stderr)).toMatch(/Dusty can’t use|not one of Dusty’s keys/);
    const [blocked] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.kind, 'Blocked'), eq(events.actorId, IDS.dusty)))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(blocked).toMatchObject({ text: 'Tried to re-run workflow run 99 in whombat/billing. Blocked.' });
    expect(blocked?.payload).toMatchObject({ command: 'github.gh', keyId: 'pipelines.retry' });
  });

  it('Ask: one card in the turn’s thread, 125; the yes wakes the agent and lets the same command run once', async () => {
    await grant('pr.comment', 'ask');
    // Mara's own turn in her Chat: the card is in its thread (one-agent.md OA-S12).
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    const chatRoot = await threadRoot(t, IDS.mara, chat, 'Close issue 7 please');
    const d = await liveDispatch(t, { conversationId: chat, threadRootId: chatRoot });
    const args = ['issue', 'close', '7', '-c', 'Done here.'];
    const asked = await gh(d.id, args);
    expect(asked.body).toMatchObject({ outcome: 'done', exitCode: 125, stdout: '' });
    expect(String(asked.body.stderr)).toMatch(
      /^I asked Mara on a card in this thread \(approval #\d+\)\. When they say yes you are woken: run the same gh command again\.\n$/,
    );
    const approval = await approvalByNumber(numberIn(asked.body.stderr));
    expect(approval).toMatchObject({
      requesterId: IDS.dusty,
      keyId: 'pr.comment',
      state: 'pending',
      conversationId: chat,
      title: 'Close issue #7 in whombat/billing',
      command: null,
    });
    expect(approval.action).toMatchObject({
      type: 'custom',
      params: { name: 'close issue #7 in whombat/billing', keyId: 'pr.comment' },
    });
    // Only the hash: the words stay with the agent.
    expect(Object.keys((approval.action as { params: { data: object } }).params.data)).toEqual(['ghHash']);
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, approval.messageId as string));
    expect(card?.threadRootId).toBe(chatRoot);

    // Asking again while it waits answers with the same card.
    expect(numberIn((await gh(d.id, args)).body.stderr)).toBe(approval.number);
    // Nothing ran yet.
    expect((await ghEvents()).filter((e) => e.payload.approvalId)).toHaveLength(0);

    expect(
      (await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' })).status,
    ).toBe('ok');
    // The yes wakes Dusty (a turn carrying the approval; a queued reply turn there takes it over) and runs nothing.
    await waitFor(
      async () =>
        (await t.services.db.select().from(dispatches).where(eq(dispatches.approvalId, approval.id)))[0],
      5000,
      'the wake',
    );
    expect((await ghEvents()).filter((e) => e.payload.approvalId)).toHaveLength(0);

    // A different command still asks.
    expect((await gh(d.id, ['issue', 'close', '7', '-c', 'Other text.'])).body).toMatchObject({
      exitCode: 125,
    });

    // The identical command (here with -R) runs once, under the yes.
    const ran = await gh(d.id, [...args, '-R', REPO]);
    expect(ran.body).toMatchObject({
      outcome: 'run',
      args: ['issue', 'close', '7', '-c', 'Done here.\n\n— Dusty via Whombat'],
    });
    const [event] = await ghEvents();
    expect(event?.payload).toMatchObject({ approvalId: approval.id, words: ['issue', 'close', '7'] });

    // A second run asks again: a new card.
    const again = await gh(d.id, args);
    expect(again.body).toMatchObject({ exitCode: 125 });
    expect(numberIn(again.body.stderr)).not.toBe(approval.number);
  });
});

describe('a yes covers only a card that says what the command does (AGH-09)', () => {
  it('the agent’s own request carrying the same hash under another name lets nothing run', async () => {
    await grant('pr.comment', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const args = ['issue', 'reopen', '8'];
    const hash = ghHash(REPO, args, { files: [], stdin: null });
    const forged = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: { type: 'custom', params: { name: 'say hello', keyId: 'pr.comment', data: { ghHash: hash } } },
      whatHappens: ['Hello.'],
      explainer: 'Just saying hello.',
      summary: 'Hello.',
    });
    expect(forged.status).toBe('ok');
    const number = (forged as { result: { number: number } }).result.number;
    expect((await t.commit(IDS.mara, decideApproval, { number, decision: 'approve' })).status).toBe('ok');
    await waitFor(async () => (await approvalByNumber(number)).state === 'approved', 5000, 'the yes');
    expect((await gh(d.id, args)).body).toMatchObject({ outcome: 'done', exitCode: 125 });
  });
});

describe('“Always allow” on a gh card (AGH-24)', () => {
  it('approves, turns the key’s row On, and the same kind of command runs from then on without a card', async () => {
    for (const key of ['deploy', 'deploy.staging', 'deploy.production'] as const) await grant(key, 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const args = ['release', 'edit', 'v1.0.10', '--notes', 'The ISO is out.'];
    const asked = await gh(d.id, args);
    expect(asked.body).toMatchObject({ exitCode: 125 });
    const approval = await approvalByNumber(numberIn(asked.body.stderr));
    expect(approval).toMatchObject({ keyId: 'deploy', state: 'pending' });

    const decided = await t.commit(IDS.mara, decideApproval, {
      number: approval.number,
      decision: 'approve',
      scope: 'agent',
    });
    expect(decided.status).toBe('ok');
    expect(await approvalByNumber(approval.number)).toMatchObject({ state: 'approved', scope: 'agent' });
    expect(keyRowTier(await loadGrants(t.services.db, IDS.dusty), 'deploy')).toBe('can');

    // The same command, and another release edit, run without asking.
    const before = (await t.services.db.select().from(approvals)).length;
    expect((await gh(d.id, args)).body).toMatchObject({ outcome: 'run' });
    expect((await gh(d.id, ['release', 'edit', 'v1.0.9', '--notes', 'See 1.0.10.'])).body).toMatchObject({
      outcome: 'run',
    });
    expect((await t.services.db.select().from(approvals)).length).toBe(before);
  });
});

describe('Whombat’s own commands (AGH-05)', () => {
  it('gh pr create opens the pull request the Whombat way and prints its URL', async () => {
    await grant('pr.open', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, [
      'pr',
      'create',
      '-t',
      'Tidy invoices',
      '-b',
      'Small cleanup.',
      '-H',
      'feat/tidy',
    ]);
    expect(res.body).toMatchObject({ outcome: 'done', exitCode: 0, stderr: '' });
    expect(String(res.body.stdout)).toMatch(/\/pull\/\d+\n$/);
    const [opened] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'pr.opened'), eq(events.actorId, IDS.dusty)))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(opened?.text).toMatch(/^Opened PR #\d+ · Tidy invoices$/);
  });

  it('gh pr review approves as the agent', async () => {
    await grant('pr.approve', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['pr', 'review', '482', '--approve'])).body).toEqual({
      outcome: 'done',
      exitCode: 0,
      stdout: '✓ Approved pull request #482\n',
      stderr: '',
    });
  });

  it('gh pr merge goes by the Merge key: Off is blocked, Ask is the merge card', async () => {
    await grant('merge.main', 'cannot');
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['pr', 'merge', '482', '--squash'])).body).toMatchObject({ exitCode: 126 });
    await grant('merge.main', 'ask');
    // The method the agent says rides on the card, so the yes merges that way (AGH-22).
    const res = await gh(d.id, ['pr', 'merge', 'feat/invoice-pdf', '--merge']);
    expect(res.body).toMatchObject({ outcome: 'done', exitCode: 125, stdout: '' });
    expect(String(res.body.stderr)).toMatch(
      /When they say yes, Whombat does it: don’t run the command again\.\n$/,
    );
    const approval = await approvalByNumber(numberIn(res.body.stderr));
    expect(approval.action).toMatchObject({
      type: 'merge_pr',
      params: { prNumber: 482, repo: REPO, method: 'merge' },
    });
  });

  it('a branch with no open pull request is said', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['pr', 'merge', 'feat/nothing'])).body).toMatchObject({
      exitCode: 1,
      stderr: 'No open pull request for feat/nothing in whombat/billing.\n',
    });
  });
});

describe('gh repo create: Whombat makes it as the connection (AGH-19, AGH-20)', () => {
  const repoRow = async (fullName: string) =>
    (await t.services.db.select().from(repos).where(eq(repos.fullName, fullName)))[0];

  it('private, by Write code: made in the connection’s account, switched on, printed like gh', async () => {
    await grant('code.write', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, ['repo', 'create', 'notes', '--private', '--add-readme']);
    const full = `${FAKE_LOGIN}/notes`;
    expect(res.body).toEqual({
      outcome: 'done',
      exitCode: 0,
      stdout: `✓ Created repository ${full} on github.com\n  https://github.com/${full}\n`,
      stderr: '',
    });
    expect(await repoRow(full)).toMatchObject({ enabled: true, source: 'github', defaultBranch: 'main' });
    const [added] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'repo.added'), eq(events.where, full)));
    expect(added).toMatchObject({
      actorId: IDS.dusty,
      text: `Created the private repository ${full} on GitHub`,
    });
    const [event] = await ghEvents();
    expect(event).toMatchObject({
      text: `Ran gh repo create on ${full}`,
      payload: { repo: full, words: ['repo', 'create'], keyId: 'code.write', creates: true },
    });
    // The next turn has it.
    const next = await buildDispatchContext(t.services, await liveDispatch(t, { threadRootId: root }));
    expect(next.gh?.repos).toContain(full);
    // A second time it is the burrow's already; GitHub's own refusal is printed as it said.
    expect((await gh(d.id, ['repo', 'create', 'notes', '--private'])).body).toMatchObject({
      exitCode: 1,
      stderr: `${full} is already one of this Whombat’s repositories: use it.\n`,
    });
    await t.services.db.delete(repos).where(eq(repos.fullName, full));
    expect((await gh(d.id, ['repo', 'create', 'notes', '--private'])).body).toMatchObject({
      exitCode: 1,
      stderr: expect.stringMatching(/whombat\/notes already exists/),
    });
  });

  it('public, by Deploy: one card naming it; the yes lets the same command make it once, from the template', async () => {
    await grant('deploy', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const args = ['repo', 'create', 'whombat/site', '--public', '--template', REPO];
    const asked = await gh(d.id, args);
    expect(asked.body).toMatchObject({ outcome: 'done', exitCode: 125, stdout: '' });
    const approval = await approvalByNumber(numberIn(asked.body.stderr));
    expect(approval).toMatchObject({
      keyId: 'deploy',
      state: 'pending',
      title: 'Create the public repository whombat/site',
    });
    expect(await repoRow('whombat/site')).toBeUndefined();
    expect(
      (await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' })).status,
    ).toBe('ok');
    const made = await gh(d.id, args);
    expect(made.body).toMatchObject({
      exitCode: 0,
      stdout: expect.stringMatching(/^✓ Created repository whombat\/site/),
    });
    expect(await repoRow('whombat/site')).toMatchObject({ enabled: true });
    const [event] = await ghEvents();
    expect(event?.payload).toMatchObject({ approvalId: approval.id, creates: true, keyId: 'deploy' });
    await t.services.db.delete(repos).where(eq(repos.fullName, 'whombat/site'));
  });

  it('Off: Blocked, nothing made', async () => {
    await grant('deploy', 'cannot');
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['repo', 'create', 'open-site', '--public'])).body).toMatchObject({
      exitCode: 126,
    });
    expect(await t.services.github.fake?.getRepo(`${FAKE_LOGIN}/open-site`).catch(() => null)).toBeNull();
  });
});

describe('everything gh does, by the agent’s keys (AGH-23)', () => {
  it('someone else’s repository: a comment on its issue goes by Comment, signed, the repository not added', async () => {
    await grant('pr.comment', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await gh(d.id, [
      'issue',
      'comment',
      '7',
      '-R',
      'MorpheApp/morphe-patches',
      '-b',
      'Works here.',
    ]);
    expect(res.body).toMatchObject({
      outcome: 'run',
      repo: 'MorpheApp/morphe-patches',
      args: ['issue', 'comment', '7', '-b', 'Works here.\n\n— Dusty via Whombat'],
    });
    const [event] = await ghEvents();
    expect(event).toMatchObject({
      text: 'Ran gh issue comment 7 on MorpheApp/morphe-patches',
      payload: { repo: 'MorpheApp/morphe-patches', foreign: true, keyId: 'pr.comment' },
    });
    expect(
      await t.services.db.select().from(repos).where(eq(repos.fullName, 'MorpheApp/morphe-patches')),
    ).toEqual([]);
  });

  it('a repository a person switched off stays off, for writes too', async () => {
    await grant('code.write', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['repo', 'edit', 'whombat/web', '--description', 'x'])).body).toMatchObject({
      exitCode: 1,
      stderr: expect.stringMatching(/^whombat\/web isn’t one this Whombat’s GitHub sign-in works on/),
    });
  });

  it('a repository setting by Write code; the account’s keys by Push to main, asked on a card', async () => {
    await grant('code.write', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const setting = await gh(d.id, [
      'api',
      '-X',
      'PUT',
      'repos/{owner}/{repo}/actions/permissions/workflow',
      '-F',
      'can_approve_pull_request_reviews=true',
    ]);
    expect(setting.body).toMatchObject({ outcome: 'run', repo: REPO });
    await grant('branch.main.push', 'ask');
    const key = await gh(d.id, ['api', 'user/keys', '-f', 'title=box', '-f', 'key=ssh-ed25519 AAAA']);
    expect(key.body).toMatchObject({ outcome: 'done', exitCode: 125 });
    const approval = await approvalByNumber(numberIn(key.body.stderr));
    expect(approval).toMatchObject({ keyId: 'branch.main.push', title: 'Add a key to the GitHub account' });
  });

  it('deleting goes by Destructive commands: Off is Blocked', async () => {
    await grant('commands.destructive', 'cannot');
    const d = await liveDispatch(t, { threadRootId: root });
    expect((await gh(d.id, ['release', 'delete', 'v1', '--yes'])).body).toMatchObject({ exitCode: 126 });
  });
});

describe('the commands’ guard leaves gh alone where it goes through Whombat (AGH-11)', () => {
  it('classifyAgain with ghThroughWhombat keeps what the runner asked', async () => {
    const asked = { command: 'gh pr merge 12', category: 'message_external' as const, target: null };
    expect((await classifyAgain(t.services, t.burrowId, asked)).category).toBe('merge');
    expect((await classifyAgain(t.services, t.burrowId, asked, { ghThroughWhombat: true })).category).toBe(
      'message_external',
    );
  });
});
