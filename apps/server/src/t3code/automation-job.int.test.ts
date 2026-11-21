/**
 * The pull request an automation opens is the job of the T3 Code thread that worked on its branch (t3code.md T3-47),
 * on a real database with FAKE AGENTS and the in-memory FakeGitHub: the run's fix step handed the work to a T3 Code
 * thread on `fix/<word>`, its `open_pull_request` step opens the pull request from that branch, and the job shows it,
 * then its checks and its merge, read from GitHub after the thread's own part ended. Postgres because the run, the watch
 * and the link are commits.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections, dispatches, t3Watches } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { conversationHandoffs } from './handoffs';
import { progressOf } from './progress';
import { T3Watcher } from './watch';

const w = useAutomationWorld();
const BILLING = IDS.billing;
const REPO = 'whombat/billing';
const CONNECTION = 'cnc_t3_automation_jobs';

/** A reported bug (keyword `word`) → Dusty has T3 Code fix it on `fix/<word>` → the automation opens the PR. */
function fixDefinition(word: string): AutomationDefinitionInput {
  return {
    version: 1,
    conversationId: BILLING,
    triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: [word] }],
    steps: [
      {
        id: 'fix',
        kind: 'dispatch_agent',
        prompt: 'Have T3 Code fix it on fix/{{run.id}}: {{trigger.text}}',
      },
      {
        id: 'pr',
        kind: 'open_pull_request',
        repo: REPO,
        branch: `fix/${word}`,
        title: `Fix the ${word} totals`,
        otherwise: 'post_payload',
      },
    ],
    limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
  };
}

beforeAll(async () => {
  await w.services.db.insert(catalogConnections).values({
    id: CONNECTION,
    burrowId: w.burrowId,
    catalogId: 't3code',
    label: 'thetitan',
    handle: 't3',
    transport: 'mcp',
    signIn: 'password',
    baseUrl: 'http://t3.invalid',
  });
});

describe('a pull request an automation opens from its thread’s branch', () => {
  it('is the job’s, with its checks and its merge', async () => {
    const id = await w.publish(fixDefinition('lopsided'), {
      name: 'Fix it in T3 Code',
      grants: [{ keyId: 'pr.open', tier: 'can', repos: [REPO] }],
    });
    const { sendMessage } = await import('../commands/messages');
    await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: 'The totals are lopsided' });
    await w.settle();
    const [run] = await w.runs(id);
    if (!run) throw new Error('no run');
    const [turn] = await w.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, run.steps[0]?.dispatchId as string));
    if (!turn) throw new Error('no turn');

    // The fix step's turn handed the work to a T3 Code thread on fix/lopsided, which ended (as the watcher left it);
    // another thread of the same conversation worked on another branch.
    const at = w.now();
    const job = (threadId: string, branch: string) => ({
      burrowId: w.burrowId,
      connectionId: CONNECTION,
      threadId,
      title: 'Dusty - Fix the lopsided totals',
      conversationId: turn.conversationId,
      threadRootId: turn.threadRootId,
      agentId: turn.agentId,
      wakes: false,
      state: 'idle' as const,
      armedAt: at,
      status: 'completed',
      runStartedAt: at,
      runEndedAt: at,
      progress: {
        stage: 'tests',
        stages: [{ stage: 'tests', startedAt: at.toISOString(), endedAt: at.toISOString() }],
        receipt: { summary: 'Fixed it.', tests: 'passed', durationMs: 60_000, screenshot: null },
        receiptRun: 'run:1',
        branch,
        readTo: 40,
      },
    });
    await w.services.db
      .insert(t3Watches)
      .values([job('mcp:thread-fix', 'fix/lopsided'), job('mcp:thread-other', 'fix/elsewhere')]);
    await w.fakePush(REPO, 'fix/lopsided');
    await w.fakeAgentReply(turn.id, 'T3 Code fixed it and pushed fix/lopsided.');
    await w.settle();

    const done = await w.run(run.id);
    expect(done.status).toBe('succeeded');
    const number = done.steps[1]?.prNumber as number;
    expect(number).toBeGreaterThan(0);
    const shown = async (threadId: string) =>
      (await conversationHandoffs(w.services.db, w.burrowId, turn.conversationId, w.now())).find(
        (h) => h.id === threadId,
      );
    expect(await shown('mcp:thread-fix')).toMatchObject({
      state: 'ended',
      stage: 'pull_request',
      pullRequest: { number, state: 'open' },
    });
    const [other] = await w.services.db
      .select()
      .from(t3Watches)
      .where(eq(t3Watches.threadId, 'mcp:thread-other'));
    expect(progressOf(other?.progress).pullRequest).toBeNull();

    // Its checks and its merge come from GitHub, though the thread's own part is over.
    const fake = w.services.github.fake;
    if (!fake) throw new Error('no FakeGitHub');
    const head = (await fake.getPullRequest(REPO, number)).headSha;
    await fake.simulateCheckRun({ repo: REPO, sha: head, name: 'check', conclusion: 'success' });
    await new T3Watcher(w.services).pass();
    expect(await shown('mcp:thread-fix')).toMatchObject({
      stage: 'checks',
      checks: { runs: [{ name: 'check', state: 'passed' }] },
    });
    await fake.simulateClose({ repo: REPO, number, login: 'mara', merged: true });
    w.advance(61_000);
    await new T3Watcher(w.services).pass();
    expect(await shown('mcp:thread-fix')).toMatchObject({
      stage: 'merged',
      pullRequest: { number, state: 'merged' },
    });
  });
});
