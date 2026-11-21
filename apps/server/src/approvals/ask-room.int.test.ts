/**
 * Where an agent's ask lands (docs/decisions/membership.md MB-02): the conversation it asked in, any of the burrow's,
 * including a pull request's room it never posted in; a conversation that isn't the burrow's is not found.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { performAction } from '../commands/agent-tools';
import { approvals, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { useTestServer } from '../test/harness';
import { makeRoom } from '../test/rooms';

const t = useTestServer({ seed: true });

/** A pull request's room the agent never posted in. */
let elsewhere = '';

// Where an ask lands, not who deploys: the deploy is a stand-in the suite asks for (EA-02).
beforeAll(async () => {
  simulateExecutors(t.services, 'deploy');
  elsewhere = await makeRoom(t.services, t.burrowId, 'feat/elsewhere');
});

const inRoom = async () =>
  t.services.db.select().from(messages).where(eq(messages.conversationId, elsewhere));

const deploy = {
  type: 'deploy' as const,
  params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
};

describe('asking in a conversation of the burrow', () => {
  it('perform_action whose key asks posts its approval card in the room it was asked in', async () => {
    const before = (await inRoom()).length;
    const res = await t.commit(IDS.dusty, performAction, {
      action: deploy,
      conversationId: elsewhere,
      reason: 'Mara asked me to.',
    });
    expect(res.status).toBe('pending_approval');
    if (res.status !== 'pending_approval') return;
    const [approval] = await t.services.db.select().from(approvals).where(eq(approvals.id, res.approvalId));
    expect(approval?.conversationId).toBe(elsewhere);
    expect((await inRoom()).length).toBe(before + 1);
  });

  it('a conversation that isn’t the burrow’s is not found', async () => {
    await expect(
      t.commit(IDS.dusty, performAction, { action: deploy, conversationId: 'cnv_nowhere', reason: '' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      t.commit(IDS.dusty, startRun, {
        conversationId: 'cnv_nowhere',
        title: 'Tidy the PDF module',
        repo: 'whombat/billing',
        branch: 'feat/invoice-pdf',
        steps: [{ title: 'Tidy', detail: '' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
