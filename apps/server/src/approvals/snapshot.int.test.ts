/**
 * Condition snapshots race with pushes: a stale "checks passed" read must neither overwrite a newer snapshot
 * nor start the action, and the commit whose checks passed is the one that runs.
 */
import type { Approval, ApprovalCondition, ApprovalLiveState } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decideApproval, requestApproval } from '../commands/approvals';
import { recordChecks } from '../commands/prs';
import { approvals } from '../db/schema/index';
import { toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { RefreshConditions } from './engine';

const t = useTestServer({ seed: true });

async function load(id: string): Promise<Approval> {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('missing approval');
  return toApproval(row);
}

const checksOf = (a: Approval) => a.conditions.find((c) => c.kind === 'checks_pass');

const queued = [
  { name: 'lint', state: 'queued', note: 'queued', durationMs: null, tests: null, url: null },
  { name: 'unit', state: 'queued', note: 'queued', durationMs: null, tests: null, url: null },
] as const;
const green = [
  { name: 'lint', state: 'passed', note: '12s', durationMs: 12_000, tests: null, url: null },
  {
    name: 'unit',
    state: 'passed',
    note: '41/41',
    durationMs: 60_000,
    tests: { passed: 41, total: 41 },
    url: null,
  },
] as const;

describe('stale condition snapshots', () => {
  const calls: Approval[] = [];
  let id = '';

  it('a stale “passed” read does not start the action on a head whose checks have not run', async () => {
    t.services.approvals.setExecutor('deploy', async (a) => {
      calls.push(a);
      return { ok: true, resultUrl: null };
    });
    const asked = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'deploy',
        params: {
          environment: 'staging',
          service: 'billing-api',
          ref: 'feat/invoice-pdf',
          sha: null,
          prNumber: 482,
        },
      },
      title: 'Deploy feat/invoice-pdf to staging',
      question: 'Deploy feat/invoice-pdf to staging?',
      target: 'staging · billing-api',
      whatHappens: ['Roll billing-api to staging'],
      explainer: '',
      summary: '',
      conditions: [{ kind: 'checks_pass' }],
      approverIds: [IDS.mara],
    });
    if (asked.status !== 'ok') throw new Error(asked.status);
    id = asked.result.approvalId;
    await t.commit(IDS.mara, decideApproval, { number: asked.result.number, decision: 'approve' });
    // A push of bbbb222 re-queues the checks.
    await t.commit(IDS.dusty, recordChecks, { prNumber: 482, headSha: 'bbbb222', checks: [...queued] });
    expect(checksOf(await load(id))).toMatchObject({ headSha: 'bbbb222', state: 'running', met: false });

    // A hook that read live state before that push now commits its snapshot: aaaa111 passed.
    const engine = t.services.approvals;
    const real = engine.liveState.bind(engine);
    let stale = true;
    engine.liveState = async (approval, db) => {
      if (!stale) return real(approval, db);
      stale = false;
      return {
        checks: { headSha: 'aaaa111', state: 'passed', passed: 41, total: 41, fixing: false },
        reviews: {},
      } satisfies ApprovalLiveState;
    };
    try {
      await engine.reevaluate(t.burrowId, { approvalIds: [id] });
    } finally {
      engine.liveState = real;
    }
    expect(calls).toHaveLength(0);
    const after = await load(id);
    expect(after.execution.state).toBe('idle');
    expect(checksOf(after)).toMatchObject({ headSha: 'bbbb222', met: false });
  });

  it('an older snapshot never overwrites a newer one', async () => {
    const current = await load(id);
    const older = current.conditions.map(
      (c): ApprovalCondition => (c.kind === 'checks_pass' ? { ...c, headSha: 'e9f114', state: 'failed' } : c),
    );
    const stalePassed = current.conditions.map(
      (c): ApprovalCondition =>
        c.kind === 'checks_pass' ? { ...c, headSha: 'aaaa111', state: 'passed', met: true } : c,
    );
    await t.services.pipeline.commit(
      RefreshConditions,
      { approvalId: id, previous: older, conditions: stalePassed },
      { burrowId: t.burrowId, actorId: IDS.dusty },
    );
    expect(checksOf(await load(id))).toMatchObject({ headSha: 'bbbb222', met: false });
  });

  it('runs the commit whose checks passed', async () => {
    await t.commit(IDS.dusty, recordChecks, { prNumber: 482, headSha: 'cccc333', checks: [...green] });
    expect(calls).toHaveLength(1);
    const ran = calls[0]?.action;
    expect(ran?.type === 'deploy' ? ran.params.sha : null).toBe('cccc333');
    const done = await load(id);
    expect(done.execution.state).toBe('succeeded');
    // The stored action is what was approved; the pinned commit is recorded with the execution event.
    expect(done.action.type === 'deploy' ? done.action.params.sha : 'x').toBeNull();
    const [executing] = await t.services.sql<{ payload: { sha?: string } }[]>`
      select payload from events where type = 'approval.executing' order by seq desc limit 1`;
    expect(executing?.payload.sha).toBe('cccc333');
  });

  it('refuses to run a named commit other than the one the checks passed on', async () => {
    const asked = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'deploy',
        params: {
          environment: 'staging',
          service: 'billing-api',
          ref: 'feat/invoice-pdf',
          sha: 'dddd444',
          prNumber: 482,
        },
      },
      title: 'Deploy feat/invoice-pdf to staging',
      question: 'Deploy feat/invoice-pdf to staging?',
      target: 'staging · billing-api',
      whatHappens: ['Roll billing-api to staging'],
      explainer: '',
      summary: '',
      conditions: [{ kind: 'checks_pass' }],
      approverIds: [IDS.mara],
    });
    if (asked.status !== 'ok') throw new Error(asked.status);
    await t.commit(IDS.mara, decideApproval, { number: asked.result.number, decision: 'approve' });
    expect(calls).toHaveLength(1);
    const refused = await load(asked.result.approvalId);
    expect(refused.execution).toMatchObject({
      state: 'failed',
      error: 'Checks passed on cccc33, not on dddd44, the commit that was approved.',
    });
  });
});
