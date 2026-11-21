import type { Approval } from '@whombat/core';
import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { setAgentKeys } from '../commands/agents';
import { decideApproval, requestApproval, undoDecision } from '../commands/approvals';
import { recordChecks } from '../commands/prs';
import { approvals, events } from '../db/schema/index';
import { loadGrants } from '../read/principals';
import { toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true });

async function load(id: string): Promise<Approval> {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('missing approval');
  return toApproval(row);
}

async function askDeploy(environment: 'staging' | 'production', withChecks: boolean) {
  const res = await t.commit(IDS.dusty, requestApproval, {
    conversationId: IDS.billing,
    action: {
      type: 'deploy',
      params: {
        environment,
        service: 'billing-api',
        ref: 'feat/invoice-pdf',
        sha: null,
        ...(withChecks ? { prNumber: 482 } : {}),
      },
    },
    title: `Deploy feat/invoice-pdf to ${environment}`,
    question: `Deploy feat/invoice-pdf to ${environment}?`,
    target: `${environment} · billing-api`,
    whatHappens: [`Roll billing-api to ${environment}`],
    explainer: '',
    summary: '',
    conditions: withChecks ? [{ kind: 'checks_pass' }] : [],
    approverIds: [IDS.mara],
  });
  if (res.status !== 'ok') throw new Error(`request_approval: ${res.status}`);
  return res.result;
}

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

describe('a failed execution waits for a person', () => {
  it('does not re-run a failed action on later burrow activity; undo and approve runs it again', async () => {
    const calls: Approval[] = [];
    t.services.approvals.setExecutor('deploy', async (a) => {
      calls.push(a);
      return { ok: false, error: 'Pods did not become ready.' };
    });
    const asked = await askDeploy('staging', false);
    await t.commit(IDS.mara, decideApproval, { number: asked.number, decision: 'approve' });
    expect(calls).toHaveLength(1);
    expect((await load(asked.approvalId)).execution.state).toBe('failed');

    // Unrelated activity in the burrow re-evaluates every open approval.
    await t.services.approvals.reevaluate(t.burrowId);
    await t.services.approvals.reevaluate(t.burrowId, { approvalIds: [asked.approvalId] });
    expect(calls).toHaveLength(1);
    const failedEvents = await t.services.db.select().from(events).where(eq(events.type, 'approval.failed'));
    expect(failedEvents).toHaveLength(1);

    // A person retries: undo (back to pending), then approve again.
    await t.commit(IDS.mara, undoDecision, { number: asked.number });
    await t.commit(IDS.mara, decideApproval, { number: asked.number, decision: 'approve' });
    expect(calls).toHaveLength(2);
  });
});
describe('the requester must still hold the key when it runs', () => {
  it('blocks an approved-in-advance deploy after its key was taken away, with a signed Blocked event', async () => {
    const calls: Approval[] = [];
    t.services.approvals.setExecutor('deploy', async (a) => {
      calls.push(a);
      return { ok: true, resultUrl: null };
    });
    const asked = await askDeploy('production', true);
    await t.commit(IDS.mara, decideApproval, { number: asked.number, decision: 'approve' });
    expect((await load(asked.approvalId)).state).toBe('approved');

    const grants = await loadGrants(t.services.db, IDS.dusty);
    const changed = await t.commit(IDS.mara, setAgentKeys, {
      grants: grants.map((g) => ({
        keyId: g.keyId,
        tier: g.keyId === 'deploy.production' ? ('cannot' as const) : g.tier,
        ...(g.scope ? { scope: g.scope } : {}),
      })),
    });
    expect(changed.status).toBe('ok');

    await t.commit(IDS.dusty, recordChecks, { prNumber: 482, headSha: '7be20f', checks: [...green] });
    expect(calls).toHaveLength(0);
    const after = await load(asked.approvalId);
    expect(after.executedAt).toBeNull();
    expect(after.execution.state).toBe('failed');
    const [blocked] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'action.blocked'))
      .orderBy(desc(events.seq));
    expect(blocked).toMatchObject({
      actorId: IDS.dusty,
      kind: 'Blocked',
      text: 'Tried to deploy feat/invoice-pdf to production. Blocked.',
    });
  });
});

describe('an approval without its integrity hash never runs', () => {
  const dropHash = (id: string) =>
    t.services.db.update(approvals).set({ actionHash: null }).where(eq(approvals.id, id));

  it('can’t be approved, so nothing runs', async () => {
    const calls: Approval[] = [];
    t.services.approvals.setExecutor('deploy', async (a) => {
      calls.push(a);
      return { ok: true, resultUrl: null };
    });
    const asked = await askDeploy('staging', false);
    await dropHash(asked.approvalId);
    await expect(
      t.commit(IDS.mara, decideApproval, { number: asked.number, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(calls).toHaveLength(0);
    expect((await load(asked.approvalId)).state).toBe('pending');
  });

  it('is refused when an approved one would run', async () => {
    const calls: Approval[] = [];
    t.services.approvals.setExecutor('deploy', async (a) => {
      calls.push(a);
      return { ok: true, resultUrl: null };
    });
    // As an approved request from before every approval carried its hash: a yes given, waiting for its checks.
    const asked = await askDeploy('staging', true);
    await t.services.db
      .update(approvals)
      .set({ actionHash: null, state: 'approved', decidedById: IDS.mara, decidedAt: new Date() })
      .where(eq(approvals.id, asked.approvalId));
    await t.commit(IDS.dusty, recordChecks, { prNumber: 482, headSha: '7be20f', checks: [...green] });
    expect(calls).toHaveLength(0);
    const after = await load(asked.approvalId);
    expect(after.executedAt).toBeNull();
    expect(after.execution.state).toBe('failed');
    expect(after.execution.error).toBeTruthy();
  });
});
