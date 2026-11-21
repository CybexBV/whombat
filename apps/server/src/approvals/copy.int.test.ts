/**
 * The approval card says what actually runs: its title, question, target and first WHAT HAPPENS line are
 * written from the action, and a deploy's checks must be about the ref it deploys.
 */
import { approvalView } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { performAction } from '../commands/agent-tools';
import { requestApproval } from '../commands/approvals';
import { approvals, notifications } from '../db/schema/index';
import { toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true });

// About what the card says: the deploy is a stand-in the suite asks for (EA-02).
beforeAll(() => simulateExecutors(t.services, 'deploy'));

const stagingCopy = {
  title: 'Deploy feat/invoice-pdf to staging',
  question: 'Deploy feat/invoice-pdf to staging?',
  target: 'staging · billing-api',
  whatHappens: ['Roll billing-api to staging, 2 of 2 pods'],
  explainer: 'Dusty holds a staging key that only turns when a person approves.',
  summary: 'Dusty rolls billing-api to staging.',
};

async function load(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('missing approval');
  return toApproval(row);
}

describe('request_approval copy', () => {
  it('refuses a deploy whose PR checks are on another branch than the ref it deploys', async () => {
    await expect(
      t.commit(IDS.dusty, requestApproval, {
        conversationId: IDS.billing,
        action: {
          type: 'deploy',
          params: {
            environment: 'production',
            service: 'billing-api',
            ref: 'main',
            sha: null,
            repo: 'whombat/billing',
            prNumber: 482,
          },
        },
        ...stagingCopy,
        conditions: [{ kind: 'checks_pass' }],
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message:
        'PR #482 is on feat/invoice-pdf, not main: its checks and review don’t cover what this deploy would run.',
    });
  });

  it('writes the card from the action, not from the agent’s wording', async () => {
    const res = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'deploy',
        params: {
          environment: 'production',
          service: 'billing-api',
          ref: 'main',
          sha: null,
          repo: 'whombat/billing',
        },
      },
      ...stagingCopy,
      approverIds: [IDS.mara],
    });
    if (res.status !== 'ok') throw new Error(res.status);
    const a = await load(res.result.approvalId);
    expect(a.title).toBe('Deploy main to production');
    expect(a.question).toBe('Deploy main to production?');
    expect(a.target).toBe('production · billing-api');
    expect(a.whatHappens).toEqual([
      'Build the latest commit on main in whombat/billing, then roll billing-api to production',
      'Roll billing-api to staging, 2 of 2 pods',
    ]);
    expect(a.explainer).toBe(stagingCopy.explainer);
    expect(a.summary).toBe(
      'Build the latest commit on main in whombat/billing, then roll billing-api to production. Dusty rolls billing-api to staging.',
    );
    const view = approvalView(a, { names: () => undefined, now: new Date(), timeZone: 'UTC' });
    expect(view.actionNote).toBeNull();
    const [note] = await t.services.db.select().from(notifications).where(eq(notifications.approvalId, a.id));
    expect(note?.text).toBe('Deploy main to production.');
  });

  it('keeps the mock copy for a deploy the checks cover', async () => {
    const res = await t.commit(IDS.dusty, requestApproval, {
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
      ...stagingCopy,
      conditions: [{ kind: 'checks_pass' }],
    });
    if (res.status !== 'ok') throw new Error(res.status);
    const a = await load(res.result.approvalId);
    expect([a.title, a.question, a.target]).toEqual([
      stagingCopy.title,
      stagingCopy.question,
      stagingCopy.target,
    ]);
    expect(a.whatHappens[0]).toBe(
      'Build the latest commit on feat/invoice-pdf (PR #482), then roll billing-api to staging',
    );
  });

  it('an ask from perform_action is written from the action too', async () => {
    const res = await t.commit(IDS.dusty, performAction, {
      action: {
        type: 'deploy',
        params: {
          environment: 'staging',
          service: 'billing-api',
          ref: 'feat/invoice-pdf',
          sha: 'e9f114',
          repo: 'whombat/billing',
        },
      },
      conversationId: IDS.billing,
      reason: 'Dusty approved the fix.',
    });
    if (res.status !== 'pending_approval') throw new Error(res.status);
    const a = await load(res.approvalId);
    expect(a.title).toBe('Deploy feat/invoice-pdf to staging');
    expect(a.target).toBe('staging · billing-api');
    expect(a.whatHappens).toEqual([
      'Build e9f114 from feat/invoice-pdf in whombat/billing, then roll billing-api to staging',
    ]);
    expect(a.summary).toBe(
      'Build e9f114 from feat/invoice-pdf in whombat/billing, then roll billing-api to staging. Dusty approved the fix.',
    );
  });

  it('a custom action asked by an agent names the key it uses', async () => {
    const res = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'custom',
        params: { name: 'restart the invoice worker', keyId: 'deploy.staging', data: {} },
      },
      whatHappens: ['Drain the queue first'],
      explainer: '',
      summary: '',
    });
    if (res.status !== 'ok') throw new Error(res.status);
    const a = await load(res.result.approvalId);
    expect(a.title).toBe('Restart the invoice worker');
    expect(a.target).toBe('Deploy to staging');
    expect(a.whatHappens).toEqual([
      'Restart the invoice worker, using “Deploy to staging”',
      'Drain the queue first',
    ]);
  });
});
