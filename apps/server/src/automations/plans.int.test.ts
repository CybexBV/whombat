/**
 * Automations made by talking to the agent (docs/decisions/automation-chat.md): a proposal becomes a plan card in the
 * turn's Chat thread, written from the definition; a newer one replaces it; the person turns it on (a version with the
 * card's keys) or says not now; a change waits beside the live version and says what changes; an automation's own step
 * and strangers' turns can't propose or read. Needs Postgres: plans, versions, keys and cards commit together.
 */
import type { AutomationPlanCard } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import { automationPlans, automations, automationVersions, grants } from '../db/schema/index';
import { callTool, mcpToolList } from '../mcp/server';
import { loadMessageRow, loadMessages } from '../read/messages';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import type { TestDispatchOptions } from '../test/tokens';
import { publishAutomationDraft, saveAutomationDraft } from './commands';
import { acceptAutomationPlan, declineAutomationPlan, proposeAutomationPlan } from './plans';
import { loadAutomationRow, toAutomation } from './store';

const w = useAutomationWorld();
const CHAT = IDS.dmDusty;
const REPO = 'whombat/billing';

const issues = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  conversationId: CHAT,
  triggers: [{ kind: 'github', event: 'issue_opened', repo: REPO, bots: false }],
  steps: [
    {
      id: 'ask',
      kind: 'dispatch_agent',
      name: 'Reads the issue and the code',
      prompt: 'Say what this issue is: {{trigger.text}}',
      workspace: { repo: REPO, access: 'read' },
      assessment: true,
    },
  ],
  limits: { maxRunsPerDay: 20 },
  ...extra,
});

const commenting = () =>
  issues({
    steps: [
      ...issues().steps,
      {
        id: 'comment',
        kind: 'github_comment',
        repo: REPO,
        number: '{{trigger.number}}',
        text: '{{steps.ask.reply}}',
      },
    ],
  });

async function propose(input: Record<string, unknown>, options: TestDispatchOptions = {}) {
  const dispatchId = await w.turn(IDS.dusty, CHAT, options);
  return w.ok(IDS.dusty, proposeAutomationPlan, {
    name: 'New billing issues',
    description: 'Dusty looks at new issues and says what they are.',
    ...input,
    dispatchId,
  } as never);
}

async function planRow(planId: string) {
  const [row] = await w.services.db.select().from(automationPlans).where(eq(automationPlans.id, planId));
  if (!row) throw new Error('no plan');
  return row;
}

/** The plan's card as the person reads it. */
async function cardOf(planId: string) {
  const row = await planRow(planId);
  const message = await loadMessageRow(w.services.db, row.messageId as string);
  if (!message) throw new Error('no card');
  const [loaded] = await loadMessages(w.services.db, [message], IDS.mara);
  const card = loaded?.card as AutomationPlanCard;
  if (!card?.plan) throw new Error('card not resolved');
  return { message: loaded, plan: card.plan };
}

const lines = (plan: AutomationPlanCard['plan'], id: string) =>
  plan?.sections
    .find((s) => s.id === id)
    ?.lines.map((l) => (l.detail ? `${l.text} | ${l.detail}` : l.text)) ?? [];

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return String(err instanceof Error ? err.message : err);
  }
  return 'did not fail';
};

describe('a proposal', () => {
  it('posts a plan card in the turn’s thread, written from the definition', async () => {
    const root = await w.ok(IDS.mara, sendMessage, {
      conversationId: CHAT,
      text: 'Watch new billing issues?',
    });
    const out = await propose(
      { definition: issues(), thinking: ['I left out issues from bots.'], message: 'Here’s the plan.' },
      { threadRootId: root.id },
    );
    expect(out.problems).toEqual([]);
    const { message, plan } = await cardOf(out.planId as string);
    expect(message?.threadRootId).toBe(root.id);
    expect(message?.authorId).toBe(IDS.dusty);
    expect(message?.text).toBe('Here’s the plan.');
    expect(plan.state).toBe('waiting');
    expect(plan.change).toBe(false);
    expect(plan.sections.map((s) => s.id)).toEqual(['when', 'does', 'asks', 'posts', 'limits']);
    expect(lines(plan, 'when')).toEqual([`A new issue on ${REPO} | Not from bots`]);
    expect(lines(plan, 'does')[0]).toContain('Reads the issue and the code');
    expect(lines(plan, 'asks')).toEqual(['Nothing: it only reads and tells you']);
    expect(lines(plan, 'posts')[0]).toContain('One thread per issue');
    expect(lines(plan, 'limits')).toEqual(['At most 20 runs a day']);
    expect(plan.thinking).toEqual(['I left out issues from bots.']);
    expect(plan.prompts[0]?.text).toContain('{{trigger.text}}');
    expect(plan.tryIt).toBe('sample');
    // The automation waits as a draft: what a test run runs, and what the list shows as waiting.
    const automation = await toAutomation(
      w.services.db,
      await loadAutomationRow(w.services.db, w.burrowId, out.automationId as string),
    );
    expect(automation.status).toBe('draft');
    expect(automation.draft?.steps[0]?.id).toBe('ask');
    expect(automation.waitingPlanId).toBe(out.planId);
    expect(automation.talk).toEqual({ conversationId: CHAT, threadRootId: root.id });
  });

  it('with problems comes back without a card', async () => {
    const broken = await propose({ definition: issues({ steps: [{ id: 'ask', kind: 'dispatch_agent' }] }) });
    expect(broken.planId).toBeNull();
    expect(broken.problems.join(' ')).toMatch(/prompt/);
    const both = await propose({ definition: issues(), recipe: { job: 'assess' } });
    expect(both.problems).toEqual(['Give either recipe or definition, not both.']);
    const elsewhere = await propose({ definition: issues({ conversationId: 'cnv_nowhere' }) });
    expect(elsewhere.problems.join(' ')).toMatch(/no conversation/);
  });

  it('from a recipe gets its tested steps and the keys they need', async () => {
    const out = await propose({
      recipe: {
        when: { kind: 'github', repo: REPO, events: ['issue_opened'] },
        job: 'assess',
        instructions: 'Say what it is.',
        conversationId: CHAT,
        replyOnGitHub: true,
      },
    });
    expect(out.problems).toEqual([]);
    const row = await planRow(out.planId as string);
    expect(row.definition.steps.map((s) => s.kind)).toContain('github_comment');
    expect(row.grants).toEqual([{ keyId: 'pr.comment', tier: 'can', repos: [REPO] }]);
    const { plan } = await cardOf(out.planId as string);
    expect(lines(plan, 'posts')).toContain(`Comments on GitHub on ${REPO}`);
    expect(lines(plan, 'asks')).toEqual(['Nothing: it does all of this on its own']);
  });
});

describe('deciding', () => {
  it('a newer plan replaces the waiting one, and only that one turns on, with its keys', async () => {
    const first = await propose({ definition: issues() });
    const automationId = first.automationId as string;
    const second = await propose({ automationId, definition: commenting(), asks: ['pr.comment'] });
    expect((await planRow(first.planId as string)).status).toBe('replaced');
    expect((await cardOf(first.planId as string)).plan.state).toBe('replaced');
    expect(await fails(w.ok(IDS.mara, acceptAutomationPlan, { planId: first.planId as string }))).toMatch(
      /newer plan/,
    );
    const { plan: before } = await cardOf(second.planId as string);
    expect(lines(before, 'asks')).toEqual(['Before it comments on GitHub']);
    await w.ok(IDS.mara, acceptAutomationPlan, { planId: second.planId as string });
    const [row] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
    expect(row?.status).toBe('published');
    expect(row?.currentVersion).toBe(1);
    expect(row?.draftJson).toBeNull();
    const held = await w.services.db
      .select({ keyId: grants.keyId, tier: grants.tier })
      .from(grants)
      .where(eq(grants.agentId, row?.principalId as string));
    expect(held).toEqual([{ keyId: 'pr.comment', tier: 'ask' }]);
    const { plan } = await cardOf(second.planId as string);
    expect(plan.state).toBe('accepted');
    expect(plan.version).toBe(1);
    expect(plan.decidedById).toBe(IDS.mara);
    // Decided once: neither again nor the other way.
    expect(await fails(w.ok(IDS.mara, declineAutomationPlan, { planId: second.planId as string }))).toMatch(
      /already on/,
    );
  });

  it('a change waits beside the live version, says what changes, and needs the version it was made from', async () => {
    const made = await propose({ definition: issues() });
    const automationId = made.automationId as string;
    await w.ok(IDS.mara, acceptAutomationPlan, { planId: made.planId as string });
    const change = await propose({ automationId, definition: commenting() });
    const { plan } = await cardOf(change.planId as string);
    expect(plan.change).toBe(true);
    expect(plan.changes).toContainEqual({
      change: 'added',
      section: 'posts',
      text: `Comments on GitHub on ${REPO}`,
    });
    expect(plan.changes).toContainEqual({
      change: 'removed',
      section: 'asks',
      text: 'Nothing: it only reads and tells you',
    });
    const live = await w.services.db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, automationId));
    expect(live).toHaveLength(1);
    // Someone publishes another version meanwhile: the plan's changes are no longer true.
    await w.ok(IDS.mara, saveAutomationDraft, {
      automationId,
      definition: issues({ limits: { maxRunsPerDay: 3 } }),
    });
    await w.ok(IDS.mara, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: await w.draftHash(automationId),
    });
    expect(await fails(w.ok(IDS.mara, acceptAutomationPlan, { planId: change.planId as string }))).toMatch(
      /changed since the plan was made/,
    );
  });

  it('not now: a new one goes with it, a live one keeps running as it was', async () => {
    const fresh = await propose({ definition: issues() });
    const out = await w.ok(IDS.mara, declineAutomationPlan, { planId: fresh.planId as string });
    expect(out.deleted).toBe(true);
    expect(
      (await loadAutomationRow(w.services.db, w.burrowId, out.automationId, { deleted: true })).deletedAt,
    ).not.toBeNull();
    expect((await cardOf(fresh.planId as string)).plan.state).toBe('declined');

    const live = await propose({ definition: issues() });
    const automationId = live.automationId as string;
    await w.ok(IDS.mara, acceptAutomationPlan, { planId: live.planId as string });
    const change = await propose({ automationId, definition: commenting() });
    expect((await w.ok(IDS.mara, declineAutomationPlan, { planId: change.planId as string })).deleted).toBe(
      false,
    );
    const row = await loadAutomationRow(w.services.db, w.burrowId, automationId);
    expect(row.status).toBe('published');
    expect(row.currentVersion).toBe(1);
    expect(row.draftJson).toBeNull();
  });

  it('only the person turns a plan on', async () => {
    const out = await propose({ definition: issues() });
    const res = await w.commit(IDS.dusty, acceptAutomationPlan, { planId: out.planId as string });
    expect(res.status).toBe('blocked');
    expect((await planRow(out.planId as string)).status).toBe('waiting');
  });
});

describe('where the agent can propose', () => {
  it('never in an automation’s own step or a turn for nobody, and it isn’t served there', async () => {
    for (const options of [{ trigger: 'automation' as const }, { onBehalfOfAccountId: null }]) {
      const dispatchId = await w.turn(IDS.dusty, CHAT, options);
      expect(
        await fails(
          w.ok(IDS.dusty, proposeAutomationPlan, {
            name: 'Sneaky',
            definition: issues() as never,
            dispatchId,
          } as never),
        ),
      ).toMatch(/only when the person asks/);
    }
    const step = await w.turn(IDS.dusty, CHAT, { trigger: 'automation' });
    const stepTools = (await mcpToolList(w.services, IDS.dusty, step)).map((t) => t.name);
    expect(stepTools).not.toContain('draft_automation');
    expect(stepTools).not.toContain('automation_read');
    // Nor can it come back later: the automation goes on with the step's reply.
    expect(stepTools).not.toContain('schedule');
    const auth: AgentAuth = { dispatchId: step, agentId: IDS.dusty, burrowId: w.burrowId };
    const later = await callTool(w.services, auth, 'schedule', {
      action: 'create',
      when: { kind: 'at', at: new Date(Date.now() + 3_600_000).toISOString() },
      prompt: 'Check the thread',
    });
    expect(later.isError).toBe(true);
    const chat = await w.turn(IDS.dusty, CHAT);
    const chatTools = (await mcpToolList(w.services, IDS.dusty, chat)).map((t) => t.name);
    expect(chatTools).toEqual(expect.arrayContaining(['draft_automation', 'automation_read', 'schedule']));
  });

  it('reads the person’s automations and how to write one', async () => {
    const out = await propose({ name: 'Read me', definition: issues() });
    const dispatchId = await w.turn(IDS.dusty, CHAT);
    const auth: AgentAuth = { dispatchId, agentId: IDS.dusty, burrowId: w.burrowId };
    const listed = (await callTool(w.services, auth, 'automation_read', {})).structuredContent as {
      automations: { id: string; state: string }[];
      trackerConnections: unknown[];
      guide: string;
    };
    expect(listed.automations).toContainEqual(
      expect.objectContaining({ id: out.automationId, state: 'waiting' }),
    );
    expect(listed.guide).toContain('draft_automation');
    expect(listed.trackerConnections).toEqual([]);
    // A tracker trigger names a connection the agent's own connections leave out: the listing gives its id.
    const tracker = await insertConnection(w.services, {
      catalogId: 'tracker',
      burrowId: w.burrowId,
      label: 'Acme dev',
      fields: { url: 'https://dev.tracker.example' },
      secret: 'tracker_api_test',
    });
    const relisted = (await callTool(w.services, auth, 'automation_read', {})).structuredContent as {
      trackerConnections: unknown[];
    };
    expect(relisted.trackerConnections).toEqual([
      { connectionId: tracker, label: 'Acme dev', address: 'https://dev.tracker.example', working: true },
    ]);
    const one = (await callTool(w.services, auth, 'automation_read', { automationId: out.automationId }))
      .structuredContent as { automation: { waitingPlan: { planId: string } | null } };
    expect(one.automation.waitingPlan?.planId).toBe(out.planId);
    const plans = await w.services.db
      .select()
      .from(automationPlans)
      .where(and(eq(automationPlans.automationId, out.automationId as string)));
    expect(plans).toHaveLength(1);
  });
});
