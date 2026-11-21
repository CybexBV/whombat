/**
 * Batch hydration needs Postgres: ordered child queries can interleave several parents. Exercise those queries
 * and their actual read models together, including empty and repeated parents, without starting an HTTP server.
 */
import { PlanStep, prStatus } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  approvals,
  messages,
  plans,
  prChecks,
  prCommits,
  prFiles,
  prReviewers,
  pullRequests,
  reactions,
  runFiles,
  runSteps,
  runs,
} from '../db/schema/index';
import { IDS, TEST_NOW } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { loadMessages, type MessageRow } from './messages';
import {
  branchRoomPullRequests,
  loadPlans,
  loadPullRequests,
  loadRuns,
  type PullRequestRow,
  type RunRow,
} from './work';

const t = useTestServer({ seed: true });
const now = new Date(TEST_NOW);
let messageRows: MessageRow[];
let runRows: RunRow[];
let prRows: PullRequestRow[];

beforeAll(async () => {
  messageRows = await t.services.db
    .insert(messages)
    .values(
      [0, 1, 2].map((n) => ({
        id: `msg_group_${n}`,
        burrowId: t.burrowId,
        conversationId: IDS.billing,
        authorId: IDS.mara,
        text: `Message ${n}`,
        createdAt: now,
      })),
    )
    .returning();
  const [run] = await t.services.db.select().from(runs).limit(1);
  const [pr] = await t.services.db.select().from(pullRequests).limit(1);
  if (!run || !pr) throw new Error('Missing seeded work');
  runRows = await t.services.db
    .insert(runs)
    .values(
      [0, 1, 2].map((n) => ({
        ...run,
        id: `run_group_${n}`,
        number: 900 + n,
        messageId: null,
      })),
    )
    .returning();
  prRows = await t.services.db
    .insert(pullRequests)
    .values(
      [0, 1, 2].map((n) => ({
        ...pr,
        id: `pr_group_${n}`,
        number: 900 + n,
        conversationId: `cnv_group_${n}`,
      })),
    )
    .returning();
  // Deliberately insert out of order. Different parents have the same positions, so global query order interleaves.
  for (const idx of [2, 0, 1]) {
    for (const parent of [0, 1]) {
      const runId = `run_group_${parent}`;
      const prId = `pr_group_${parent}`;
      const path = `${parent}/${idx}.ts`;
      await t.services.db.insert(runSteps).values({ runId, idx, title: path, state: 'done', at: now });
      await t.services.db.insert(runFiles).values({ runId, path, position: idx, add: idx, del: parent });
      await t.services.db.insert(prChecks).values({
        prId,
        name: path,
        position: idx,
        state: parent ? 'failed' : 'passed',
      });
      await t.services.db.insert(prReviewers).values({
        prId,
        principalId: path,
        position: idx,
        state: parent ? 'changes_requested' : 'approved',
        at: now,
      });
      await t.services.db.insert(prFiles).values({ prId, path, position: idx, add: idx, del: parent });
      await t.services.db.insert(prCommits).values({
        prId,
        sha: path,
        position: idx,
        message: path,
        authorId: IDS.mara,
        at: now,
      });
    }
  }
  await t.services.db.insert(reactions).values(
    [
      {
        messageId: 'msg_group_0',
        value: '👍',
        principalId: IDS.dusty,
        createdAt: new Date(now.getTime() + 1),
      },
      {
        messageId: 'msg_group_1',
        value: '👀',
        principalId: IDS.mara,
        createdAt: new Date(now.getTime() + 2),
      },
      {
        messageId: 'msg_group_0',
        value: '🎉',
        principalId: IDS.mara,
        createdAt: new Date(now.getTime() + 3),
      },
      {
        messageId: 'msg_group_0',
        value: '👍',
        principalId: IDS.mara,
        createdAt: new Date(now.getTime() + 4),
      },
    ].map((r) => ({ ...r, burrowId: t.burrowId })),
  );
});

describe('ordered child hydration', () => {
  it('keeps reaction order and viewer flags with interleaved, absent and repeated messages', async () => {
    const [a, b, empty] = messageRows;
    if (!a || !b || !empty) throw new Error('Missing messages');
    const selected = [empty, b, a, a];
    const loaded = await loadMessages(t.services.db, selected, IDS.mara);
    expect(loaded.map((m) => m.id)).toEqual(selected.map((m) => m.id));
    expect(loaded.map((m) => m.reactions)).toEqual([
      [],
      [{ value: '👀', count: 1, mine: true, principalIds: [IDS.mara] }],
      [
        { value: '👍', count: 2, mine: true, principalIds: [IDS.dusty, IDS.mara] },
        { value: '🎉', count: 1, mine: true, principalIds: [IDS.mara] },
      ],
      [
        { value: '👍', count: 2, mine: true, principalIds: [IDS.dusty, IDS.mara] },
        { value: '🎉', count: 1, mine: true, principalIds: [IDS.mara] },
      ],
    ]);
    const unpersonalized = await loadMessages(t.services.db, [a], null);
    expect(unpersonalized[0]?.reactions.map((r) => r.mine)).toEqual([false, false]);
  });

  it('attaches only each run’s steps and files, in position order', async () => {
    const [a, b, empty] = runRows;
    if (!a || !b || !empty) throw new Error('Missing runs');
    const selected = [empty, b, a, a];
    const loaded = await loadRuns(t.services.db, selected);
    expect(loaded.map((r) => r.id)).toEqual(selected.map((r) => r.id));
    expect(loaded.map((r) => r.steps.map((s) => s.title))).toEqual([
      [],
      ['1/0.ts', '1/1.ts', '1/2.ts'],
      ['0/0.ts', '0/1.ts', '0/2.ts'],
      ['0/0.ts', '0/1.ts', '0/2.ts'],
    ]);
    expect(loaded.map((r) => r.files.map((f) => f.path))).toEqual(
      loaded.map((r) => r.steps.map((s) => s.title)),
    );
    expect(loaded[2]?.files[1]).toEqual({ path: '0/1.ts', add: 1, del: 0 });
    expect(loaded[2]?.steps[1]).toEqual({
      title: '0/1.ts',
      detail: '',
      state: 'done',
      at: now.toISOString(),
    });
  });

  it('keeps full pull-request children and sidebar states separate', async () => {
    const [a, b, empty] = prRows;
    if (!a || !b || !empty) throw new Error('Missing pull requests');
    const selected = [empty, b, a, a];
    const loaded = await loadPullRequests(t.services.db, selected);
    const expected = [
      [],
      ['1/0.ts', '1/1.ts', '1/2.ts'],
      ['0/0.ts', '0/1.ts', '0/2.ts'],
      ['0/0.ts', '0/1.ts', '0/2.ts'],
    ];
    expect(loaded.map((p) => p.id)).toEqual(selected.map((p) => p.id));
    expect(loaded.map((p) => p.checks.map((c) => c.name))).toEqual(expected);
    expect(loaded.map((p) => p.reviewers.map((r) => r.principalId))).toEqual(expected);
    expect(loaded.map((p) => p.files.map((f) => f.path))).toEqual(expected);
    expect(loaded.map((p) => p.commits.map((c) => c.sha))).toEqual(expected);
    expect(loaded[1]?.checks.map((c) => c.state)).toEqual(['failed', 'failed', 'failed']);
    expect(loaded[2]?.reviewers.map((r) => r.state)).toEqual(['approved', 'approved', 'approved']);
    const sidebar = await branchRoomPullRequests(
      t.services.db,
      selected.map((p) => p.conversationId),
    );
    expect(new Map(sidebar.map((p) => [p.conversationId, p.status]))).toEqual(
      new Map(loaded.map((p) => [p.conversationId, prStatus(p)])),
    );
  });

  it('looks up plan references by identity and leaves absent work null', async () => {
    const [approval] = await t.services.db.select().from(approvals).limit(1);
    if (!approval) throw new Error('Missing approval');
    await t.services.db.insert(plans).values({
      id: 'plan_group',
      burrowId: t.burrowId,
      title: 'References',
      conversationId: IDS.billing,
      steps: ['run_group_1', 'run_missing', 'run_group_0', null, 'run_group_1'].map((runId, i) =>
        PlanStep.parse({
          id: `stp_${i}`,
          title: `Step ${i}`,
          state: 'queued',
          stateLabel: 'Queued',
          runId,
          approvalId: i === 0 || i === 4 ? approval.id : i === 1 ? 'apr_missing' : null,
        }),
      ),
    });
    const loaded = (await loadPlans(t.services.db, ['plan_group'])).get('plan_group');
    expect(loaded?.steps.map((s) => s.refs)).toEqual(
      [901, null, 900, null, 901].map((runNumber, i) => ({
        runNumber,
        approvalNumber: i === 0 || i === 4 ? approval.number : null,
        automationRunNumber: null,
      })),
    );
  });
});
