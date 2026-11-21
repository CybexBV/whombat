/**
 * Plans, decisions and automation outcomes in search (docs/decisions/work-supervision.md WS-21…WS-25): indexed in
 * the write transaction, authorized at retrieval (membership, a decision's own visibility, the agent's audience),
 * no automation step content, card messages folded in, and answers that re-check their sources for the asker and for
 * the room they are posted in.
 */
import { definitionHash, type JsonObject, newId, validateDefinition } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAutomation, publishAutomationDraft } from '../automations/commands';
import { loadAutomationRow, publishRun } from '../automations/store';
import { agentSearch, deliverAnswer } from '../commands/agent-tools';
import { postAnswer } from '../commands/content';
import { createPlan, startPlanStep, updatePlanStep } from '../commands/plans';
import {
  approvals,
  automationRunSteps,
  automationRuns,
  messages,
  plans,
  searchAnswers,
  searchDocuments,
} from '../db/schema/index';
import { loadPrincipalRow } from '../read/principals';
import { search } from '../read/search';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { indexApproval, indexMessage } from './search-index';

const t = useTestServer({ seed: true });

function ok<R>(res: { status: string; result?: R }): R {
  expect(res.status).toBe('ok');
  return (res as { result: R }).result;
}

async function find(who: string, q: string, type: Parameters<typeof search>[3]['type'] = 'all') {
  const viewer = await loadPrincipalRow(t.services.db, who);
  const burrow = await t.services.db.query.burrows.findFirst({
    where: (b, { eq }) => eq(b.id, TEST_BURROW_ID),
  });
  if (!viewer || !burrow) throw new Error('seed');
  return (await search(t.services.db, viewer, burrow, { q, type, limit: 50 }, t.services.clock())).results;
}

async function doc(id: string) {
  const [row] = await t.services.db.select().from(searchDocuments).where(eq(searchDocuments.id, id));
  return row;
}

/** A published manual automation in #billing-v2 with one post step. */
async function automation(name: string) {
  const { automationId } = ok(
    await t.commit(IDS.mara, createAutomation, {
      name,
      source: {
        kind: 'import',
        file: {
          whombat: 'automation',
          name,
          description: '',
          definition: {
            version: 1,
            conversationId: IDS.billing,
            triggers: [{ kind: 'manual' }],
            steps: [{ id: 'post', kind: 'post_message', text: 'Nightly check' }],
          },
        },
      },
    }),
  );
  const row = await loadAutomationRow(t.services.db, TEST_BURROW_ID, automationId);
  const check = validateDefinition(row.draftJson);
  if (!check.ok) throw new Error(check.problems.join(' '));
  ok(
    await t.commit(IDS.mara, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: definitionHash(check.definition),
    }),
  );
  return automationId;
}

/** The engine's last word on a run: its status (and a step's output) change, then `publishRun` in the commit. */
async function settleRun(runId: string, status: 'failed' | 'succeeded', output: JsonObject) {
  const now = t.services.clock();
  await t.services.db
    .update(automationRuns)
    .set({
      status,
      error: status === 'failed' ? 'The check timed out.' : null,
      finishedAt: now,
      startedAt: now,
    })
    .where(eq(automationRuns.id, runId));
  await t.services.db
    .update(automationRunSteps)
    .set({ state: status === 'failed' ? 'failed' : 'succeeded', output, inputSummary: 'top secret input' })
    .where(eq(automationRunSteps.runId, runId));
  await t.services.pipeline.transact(TEST_BURROW_ID, (session) => publishRun(session, runId));
}

describe('PLAN, DECISION and AUTOMATION documents (WS-21, WS-23, WS-24)', () => {
  it('finds the seeded plan and approval with their pills and links; their cards aren’t results of their own', async () => {
    const planHits = await find(IDS.mara, 'invoice pdf export plan', 'plans');
    expect(planHits[0]).toMatchObject({
      id: 'pln_invoice-pdf',
      type: 'PLAN',
      where: 'Plan · billing-v2',
      link: { type: 'plan', planId: 'pln_invoice-pdf' },
      status: { text: '1 OF 4 DONE', tone: 'warn' },
    });
    // The card's own words are in the PLAN document, not a MESSAGE of their own.
    const card = await find(IDS.mara, 'Four steps, three agents');
    expect(card.map((r) => r.id)).toContain('pln_invoice-pdf');
    expect(card.map((r) => r.id)).not.toContain('msg_billing-toffee-0913');
    const decision = await find(IDS.mara, 'staging deploy', 'decisions');
    expect(decision[0]).toMatchObject({
      id: 'apr_staging-482',
      type: 'DECISION',
      where: 'Approval #12 · billing-v2',
      link: { type: 'approval', number: 12 },
      status: { tone: 'warn' },
    });
    expect(await doc('msg_billing-neo-1125')).toBeUndefined();
    await indexMessage(t.services.db, 'msg_billing-toffee-0913');
    expect(await doc('msg_billing-toffee-0913')).toBeUndefined();
  });

  it('keeps a plan’s document current in the commit that changes it', async () => {
    const { planId } = ok(
      await t.commit(IDS.mara, createPlan, {
        conversationId: IDS.billing,
        title: 'Quarterly wombat census',
        steps: [{ title: 'Count the burrows' }, { title: 'Tally the wombats' }],
      }),
    );
    expect((await doc(planId))?.status).toEqual({ text: '0 OF 2 DONE', tone: 'neutral' });
    const [s1] = (await t.services.db.select().from(plans).where(eq(plans.id, planId)))[0]?.steps ?? [];
    ok(
      await t.commit(IDS.mara, updatePlanStep, {
        planId,
        stepId: s1?.id as string,
        state: 'blocked',
        note: 'Rain delay',
      }),
    );
    const after = await doc(planId);
    expect(after?.status).toEqual({ text: '0 OF 2 DONE', tone: 'bad' });
    expect(after?.text).toContain('Count the burrows · Blocked · Rain delay');
    const hits = await find(IDS.mara, 'wombat census', 'plans');
    expect(hits.map((h) => h.id)).toEqual([planId]);
  });

  it('indexes an automation run’s outcome, never its steps’ content', async () => {
    const automationId = await automation('Nightly quoll audit');
    const { planId } = ok(
      await t.commit(IDS.mara, createPlan, {
        conversationId: IDS.billing,
        title: 'Audit plan',
        steps: [{ title: 'Run the audit' }],
      }),
    );
    const s1 = (await t.services.db.select().from(plans).where(eq(plans.id, planId)))[0]?.steps[0]
      ?.id as string;
    const started = ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: s1, automationId }));
    expect(started.automationRunNumber).toBeGreaterThan(0);
    const [run] = await t.services.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, automationId)));
    if (!run) throw new Error('no run');
    const [linked] = (await t.services.db.select().from(plans).where(eq(plans.id, planId)))[0]?.steps ?? [];
    expect(linked).toMatchObject({ automationRunId: run.id, state: 'active', stateLabel: 'Running' });
    await settleRun(run.id, 'failed', { text: 'zebrafinch-secret leaked output' });
    const hits = await find(IDS.mara, 'quoll audit', 'automations');
    expect(hits[0]).toMatchObject({
      id: run.id,
      type: 'AUTOMATION',
      where: `Automation run #${run.number} · Nightly quoll audit`,
      link: { type: 'automation_run', number: run.number },
      status: { text: 'FAILED', tone: 'bad' },
    });
    expect(await find(IDS.mara, 'zebrafinch')).toEqual([]);
    expect((await doc(run.id))?.text).not.toMatch(/secret/);
    // The plan step followed the run.
    const [blocked] = (await t.services.db.select().from(plans).where(eq(plans.id, planId)))[0]?.steps ?? [];
    expect(blocked).toMatchObject({ state: 'blocked', stateLabel: 'Automation failed' });
  });

  it('agent search finds the new types with their filters', async () => {
    const res = ok(
      await t.commit(IDS.dusty, agentSearch, { query: 'invoice pdf export', filter: 'plans', limit: 10 }),
    );
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.type === 'PLAN')).toBe(true);
    const decisions = ok(
      await t.commit(IDS.dusty, agentSearch, { query: 'staging', filter: 'decisions', limit: 10 }),
    );
    expect(decisions.results.every((r) => r.type === 'DECISION')).toBe(true);
  });
});

describe('answers re-check their sources (WS-22, WS-25)', () => {
  it('delivers an answer whose receipts the asker can open, and posts it to a room that can read its source', async () => {
    // A decision only Mara (and Dusty, who asked) see.
    const hidden = newId('approval');
    const [seed] = await t.services.db.select().from(approvals).where(eq(approvals.id, 'apr_staging-482'));
    if (!seed) throw new Error('seed');
    await t.services.db.insert(approvals).values({
      ...seed,
      id: hidden,
      number: 701,
      requesterId: IDS.dusty,
      title: 'Book the platypus',
      conditions: [
        {
          id: 'person',
          kind: 'person_approves',
          label: 'A person says yes',
          met: false,
          approverIds: [IDS.mara],
        },
      ],
      messageId: null,
      eventId: null,
      actionHash: null,
    });
    await indexApproval(t.services.db, hidden);
    const answerFor = async (asker: string, resultId: string) => {
      const id = newId('answer');
      await t.services.db.insert(searchAnswers).values({
        id,
        burrowId: TEST_BURROW_ID,
        query: 'platypus?',
        agentId: IDS.dusty,
        askedById: asker,
        status: 'pending',
        createdAt: t.services.clock(),
      });
      return { id, resultId };
    };
    // Mara may open it: the answer is delivered.
    const mara = await answerFor(IDS.mara, hidden);
    ok(
      await t.commit(IDS.dusty, deliverAnswer, {
        answerId: mara.id,
        text: 'Booked [1].',
        citations: [{ n: 1, resultId: hidden }],
        actions: [],
      }),
    );
    // An answer citing #incidents can go to #incidents.
    const incidents = await answerFor(IDS.mara, 'hist_thread-credit-note');
    await t.services.db
      .update(searchAnswers)
      .set({
        status: 'ready',
        text: 'Twice [1].',
        citations: [{ n: 1, resultId: 'hist_thread-credit-note' }],
      })
      .where(eq(searchAnswers.id, incidents.id));
    const posted = ok(
      await t.commit(IDS.mara, postAnswer, { answerId: incidents.id, conversationId: IDS.incidents }),
    );
    const [message] = await t.services.db.select().from(messages).where(eq(messages.id, posted.messageId));
    expect(message?.card).toMatchObject({ kind: 'answer' });
  });
});
