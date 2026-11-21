/**
 * A dispatch step's result is only what its agent said in the prompt's thread while its turn ran (docs/decisions/
 * bp-automations.md BP-C40). Inverted from the security re-review PoC SEC3-VERDICT (review/security3): a top-level
 * reply the reviewer gave someone else (“Approve. Pizza it is, Joris.”) was taken as its review verdict and the run
 * shipped.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { dispatchResult } from './steps';
import { loadStepRows } from './store';

const w = useAutomationWorld();
const BILLING = IDS.billing;

function reviewDefinition(): AutomationDefinitionInput {
  return {
    version: 1,
    conversationId: BILLING,
    triggers: [{ kind: 'message_posted', conversationId: BILLING, contains: ['wobbly'] }],
    steps: [
      {
        id: 'review',
        kind: 'dispatch_agent',
        prompt: 'Review feat/x.',
        workspace: { repo: 'whombat/billing', branch: 'feat/x', access: 'read' },
        verdict: true,
      },
      { id: 'ok', kind: 'condition', if: 'steps.review.verdict == "approve"', else: 'stop' },
      { id: 'ship', kind: 'post_message', text: 'Shipping it.' },
    ],
    limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
  };
}

describe('a review verdict comes from the review', () => {
  it('a top-level reply to someone else is not the verdict (SEC3-VERDICT)', async () => {
    const id = await w.publish(reviewDefinition(), { name: 'Review' });
    await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: 'The export is wobbly' });
    await w.settle();
    const [first] = await w.runs(id);
    const dispatchId = first?.steps[0]?.dispatchId as string;
    expect(dispatchId).toBeTruthy();
    // The agent answers in the prompt's thread.
    const [d] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    expect(d?.threadRootId).toBeTruthy();

    // Dusty answers Mara at the top level of the run's room (her Chat) — another conversation turn.
    await w.ok(IDS.dusty, sendMessage, {
      conversationId: d?.conversationId as string,
      text: 'Approve. Pizza it is, Mara.',
    });
    // Her review reply in the run's thread gives no verdict: the step fails.
    await w.fakeAgentReply(dispatchId, 'I could not read the code, sorry.');
    await w.settle();

    const run = await w.run(first?.id as string);
    expect(run.steps[0]?.output.verdict).toBeUndefined();
    expect(run.steps[0]?.state).toBe('failed');
    expect(run.steps.map((s) => s.state)).not.toContain('succeeded');
    expect(run.status).toBe('failed');
  });

  it('a reply after the turn ended does not count, the one in the thread during it does', async () => {
    const id = await w.publish(reviewDefinition(), { name: 'Review again' });
    await w.ok(IDS.mara, sendMessage, { conversationId: BILLING, text: 'Still wobbly' });
    await w.settle();
    const [first] = await w.runs(id);
    const dispatchId = first?.steps[0]?.dispatchId as string;
    const [d] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    await w.fakeAgentReply(dispatchId, 'Changes needed: the export rounds per invoice.');
    w.advance(60_000);
    // Later, in the same thread, the same agent says something else.
    await w.ok(IDS.dusty, sendMessage, {
      conversationId: d?.conversationId as string,
      threadRootId: d?.threadRootId as string,
      text: 'Approve. (About the lunch order.)',
    });
    const [row] = await loadStepRows(w.services.db, first?.id as string);
    const result = await dispatchResult(w.services.db, row as NonNullable<typeof row>, IDS.dusty);
    expect(result.messageTexts).toEqual(['Changes needed: the export rounds per invoice.']);
    await w.settle();
    const run = await w.run(first?.id as string);
    expect(run.steps[0]?.output.verdict).toBe('changes_needed');
    // Changes needed ends the run at the condition, without shipping.
    expect(run.steps[2]?.state).not.toBe('succeeded');
  });
});
