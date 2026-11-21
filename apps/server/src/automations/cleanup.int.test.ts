/**
 * After the work is done (docs/decisions/automation-recipes.md AR-42), on a real database with the in-memory FakeGitHub:
 * the branch of a pull request an automation opened goes once the pull request merges on GitHub, signed by the
 * automation; a branch with commits after the merge, one already gone, a protected one, a closed-not-merged pull
 * request and a merge outside the window are left alone, and each branch is looked at once.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { automations, events, pullRequests } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { BRANCH_CLEANUP_WINDOW_MS, cleanUpMergedBranches } from './cleanup';

const w = useAutomationWorld();
const BILLING = IDS.billing;
const REPO = 'whombat/billing';

function fake() {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
}

/** An automation that opens a pull request from `feat/<word>` when someone posts `<word>`. */
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
        title: `Tidy the ${word} totals`,
        otherwise: 'fail',
      },
    ],
    limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
  };
}

/** The automation's pull request from `feat/<word>`, opened: its run and number. */
async function opened(word: string) {
  await w.fakePush(REPO, `feat/${word}`, `Tidy ${word}`);
  const id = await w.publish(prDefinition(word), {
    name: `Open ${word}`,
    grants: [{ keyId: 'pr.open', tier: 'can', repos: [REPO] }],
  });
  await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: `Please ${word} it` });
  await w.settle();
  const [run] = await w.runs(id);
  expect(run?.status).toBe('succeeded');
  const number = run?.steps[0]?.prNumber as number;
  expect(number).toBeGreaterThan(0);
  // The poller reads the list with it open, as it would long before anyone merges it.
  await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  return { id, run: run as NonNullable<typeof run>, number };
}

async function mergeOnGitHub(number: number) {
  await fake().simulateClose({ repo: REPO, number, login: 'mara-gh', merged: true });
  await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
  expect(pr?.state).toBe('merged');
}

const cleanUp = () => cleanUpMergedBranches(w.services, w.now(), new Map());

/** Branches the fake deleted (its log is the file's, across tests). */
const deleted = (branch: string) => fake().deletedBranches.filter((b) => b.branch === branch);

async function branchCleanup(runId: string) {
  return (await w.run(runId)).steps[0]?.output.branchCleanup as
    | { outcome: string; branch: string; detail: string }
    | undefined;
}

async function head(branch: string) {
  const read = await fake().branchHead(REPO, branch, null);
  return read.modified ? read.data : 'unchanged';
}

describe('an automation’s branch after its pull request merged', () => {
  it('is deleted on GitHub, signed by the automation, and only once', async () => {
    const { id, run, number } = await opened('tidy');
    expect(await cleanUp()).toBe(0); // still open: nothing to do
    await mergeOnGitHub(number);
    expect(await cleanUp()).toBe(1);
    expect(await head('feat/tidy')).toBeNull();
    expect(deleted('feat/tidy')).toEqual([{ repo: REPO, branch: 'feat/tidy' }]);
    expect(await branchCleanup(run.id)).toMatchObject({
      outcome: 'deleted',
      branch: 'feat/tidy',
      detail: `Deleted feat/tidy: PR #${number} was merged.`,
    });
    const [a] = await w.services.db.select().from(automations).where(eq(automations.id, id));
    const [signed] = await w.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'automation.branch_deleted'), eq(events.actorId, a?.principalId as string)));
    expect(signed?.text).toBe(`Deleted feat/tidy in ${REPO}: PR #${number} was merged`);
    // Looked at once: a second pass changes nothing.
    expect(await cleanUp()).toBe(0);
    expect(deleted('feat/tidy')).toHaveLength(1);
  });

  it('stays when someone pushed to it after the merge', async () => {
    const { run, number } = await opened('later');
    await mergeOnGitHub(number);
    await w.fakePush(REPO, 'feat/later', 'Another change');
    expect(await cleanUp()).toBe(1);
    expect(await head('feat/later')).not.toBeNull();
    expect(deleted('feat/later')).toEqual([]);
    expect(await branchCleanup(run.id)).toMatchObject({
      outcome: 'moved',
      detail: `Kept feat/later: it has commits that came after PR #${number}.`,
    });
  });

  it('is noted as gone when someone deleted it already', async () => {
    const { run, number } = await opened('gone');
    await mergeOnGitHub(number);
    await fake().deleteBranch(REPO, 'feat/gone');
    expect(await cleanUp()).toBe(1);
    expect(deleted('feat/gone')).toHaveLength(1); // the one above, not another
    expect(await branchCleanup(run.id)).toMatchObject({ outcome: 'gone' });
  });

  it('stays when GitHub refuses (a protected branch), and says why', async () => {
    const { run, number } = await opened('guarded');
    fake().protectedBranches.add(`${REPO}:feat/guarded`);
    await mergeOnGitHub(number);
    expect(await cleanUp()).toBe(1);
    expect(await head('feat/guarded')).not.toBeNull();
    expect(await branchCleanup(run.id)).toMatchObject({ outcome: 'refused' });
    expect((await branchCleanup(run.id))?.detail).toMatch(/^GitHub kept feat\/guarded: .*protected/);
  });

  it('stays when the pull request was closed without merging', async () => {
    const { run, number } = await opened('dropped');
    await fake().simulateClose({ repo: REPO, number, login: 'mara-gh', merged: false });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    expect(await cleanUp()).toBe(0);
    expect(await head('feat/dropped')).not.toBeNull();
    expect(await branchCleanup(run.id)).toBeUndefined();
  });

  it('is left alone for a merge older than the window', async () => {
    const { run, number } = await opened('ancient');
    await mergeOnGitHub(number);
    // The fake stamps merges with the wall clock: put this one outside the window by hand.
    await w.services.db
      .update(pullRequests)
      .set({ mergedAt: new Date(w.now().getTime() - BRANCH_CLEANUP_WINDOW_MS - 60_000) })
      .where(eq(pullRequests.number, number));
    expect(await cleanUp()).toBe(0);
    expect(await head('feat/ancient')).not.toBeNull();
    expect(await branchCleanup(run.id)).toBeUndefined();
  });
});
