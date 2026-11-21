/**
 * request_approval: the person decides, whoever the agent names (one-person.md OP-S62); involved principals are of the
 * asking burrow.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { requestApproval } from '../commands/approvals';
import { createBurrow } from '../commands/burrows';
import { approvals, notifications, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true });

// About who may decide: the deploy is a stand-in the suite asks for (EA-02).
beforeAll(() => simulateExecutors(t.services, 'deploy'));

const ask = (extra: { approverIds?: string[]; involvedIds?: string[] }) =>
  t.commit(IDS.dusty, requestApproval, {
    conversationId: IDS.billing,
    action: {
      type: 'deploy',
      params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
    },
    title: 'Deploy feat/invoice-pdf to staging',
    question: 'Deploy feat/invoice-pdf to staging?',
    target: 'staging · billing-api',
    whatHappens: ['Roll billing-api to staging'],
    explainer: '',
    summary: '',
    ...extra,
  });

async function otherBurrowPerson(): Promise<string> {
  const [mara] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  if (!mara?.accountId) throw new Error('Mara has no account');
  const { principalId } = await createBurrow(t.services, mara.accountId, 'Moss Co', { besideOwn: true });
  return principalId;
}

describe('request_approval approvers and involved principals', () => {
  it('the person decides whoever the agent names, and nobody else is told', async () => {
    const outsider = await otherBurrowPerson();
    const res = await ask({ approverIds: [outsider, IDS.dusty, 'prn_nobody'] });
    expect(res.status).toBe('ok');
    const approvalId = res.status === 'ok' ? res.result.approvalId : '';
    const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.conditions.find((c) => c.kind === 'person_approves')).toMatchObject({
      approverIds: [IDS.mara],
    });
    expect(
      await t.services.db.select().from(notifications).where(eq(notifications.principalId, outsider)),
    ).toEqual([]);
  });

  it('refuses involved principals from another burrow', async () => {
    const [outsider] = await t.services.db
      .select()
      .from(principals)
      .where(eq(principals.kind, 'person'))
      .then((rows) => rows.filter((r) => r.burrowId !== t.burrowId));
    if (!outsider) throw new Error('no outsider');
    await expect(ask({ involvedIds: [outsider.id] })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('still accepts people and agents of this burrow as involved', async () => {
    const res = await ask({ involvedIds: [IDS.dusty, IDS.mara] });
    expect(res.status).toBe('ok');
  });
});
