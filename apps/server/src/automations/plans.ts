/**
 * Automations made by talking to the agent (docs/decisions/automation-chat.md): the agent proposes a plan with
 * `draft_automation`, Whombat posts it in the turn's Chat thread as a card, and the person turns it on or says not now.
 * A newer plan for the same automation replaces the waiting one. Turning a plan on publishes exactly its definition, with
 * the keys its card lists, through the same version path as every publish (bp-automations.md).
 */
import {
  AUTOMATION_PLAN_DECIDED_TEXT,
  AUTOMATION_PLAN_NOT_HERE,
  type AutomationDefinition,
  AutomationDefinition as AutomationDefinitionSchema,
  AutomationPlanId,
  AutomationRecipe,
  DispatchId,
  definitionGrants,
  definitionHash,
  type JsonObject,
  MCP_TOOLS,
  newId,
  planCardText,
  planMessageText,
  validateDefinition,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { automationPlans, automations, dispatches } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { outsidersTurn } from '../runtime/person';
import {
  cap,
  insertAutomation,
  MANAGE,
  mayPublish,
  publishVersion,
  recipeFile,
  referenceProblems,
  removeAutomation,
  requirePerson,
  storeDraft,
  writeGrants,
} from './commands';
import { republishPlanCardsById } from './plan-cards';
import { laterWords, newerDefinition } from './release-gate';
import { automationGrants, loadAutomationRow, publishAutomation } from './store';

/** A zod failure as the problems `draft_automation` answers: “recipe.when.repo: Invalid input”. */
function issuesOf(prefix: string, error: z.ZodError): string[] {
  return error.issues
    .slice(0, 8)
    .map((i) => `${[prefix, ...i.path.map(String)].filter(Boolean).join('.')}: ${i.message}`);
}

/**
 * The definition a proposal stands for: a recipe made into its tested steps (`recipeFile`, which also checks the
 * repository and the tracker connection), or a definition as given; with the problems only the server can find.
 */
async function proposedDefinition(
  ctx: ApplyContext,
  input: { recipe?: JsonObject | undefined; definition?: JsonObject | undefined },
): Promise<{ definition: AutomationDefinition | null; problems: string[] }> {
  if (!!input.recipe === !!input.definition)
    return { definition: null, problems: ['Give either recipe or definition, not both.'] };
  let definition: AutomationDefinition | null = null;
  if (input.recipe) {
    const recipe = AutomationRecipe.safeParse(input.recipe);
    if (!recipe.success) return { definition: null, problems: issuesOf('recipe', recipe.error) };
    try {
      const made = await recipeFile(ctx, recipe.data);
      definition = AutomationDefinitionSchema.parse(made.file.definition);
    } catch (err) {
      if (err instanceof ApiError) return { definition: null, problems: [err.message] };
      throw err;
    }
  } else {
    const check = validateDefinition(input.definition, ctx.now.getTime());
    if (!check.ok) return { definition: null, problems: check.problems.slice(0, 8) };
    definition = check.definition;
  }
  return { definition, problems: await referenceProblems(ctx, definition, false) };
}

/**
 * The agent proposes an automation or a change to one (MCP `draft_automation`): checked, kept as the
 * automation's draft (what a test run runs), and posted in the turn's thread as a plan card that replaces the one
 * waiting. Only in the person's own turns: never an automation's step or what strangers sent. Problems come back
 * without a card.
 */
export const proposeAutomationPlan = defineCommand({
  name: 'automation.propose_plan',
  schema: MCP_TOOLS.draft_automation.input.extend({ dispatchId: DispatchId }),
  async apply(tx, ctx, input) {
    const agent = await loadPrincipalRow(tx, ctx.actor.id);
    if (agent?.kind !== 'agent') throw forbidden('This is the agent’s tool for proposing automations.');
    const [turn] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!turn || turn.agentId !== ctx.actor.id || turn.burrowId !== ctx.burrow.id) throw notFound('Turn');
    if (turn.trigger === 'automation' || turn.trigger === 'feedback' || outsidersTurn(turn))
      throw forbidden(AUTOMATION_PLAN_NOT_HERE);
    const conversation = await loadConversationRow(tx, turn.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const existing = input.automationId
      ? await loadAutomationRow(tx, ctx.burrow.id, input.automationId)
      : null;
    const { definition, problems } = await proposedDefinition(ctx, input);
    if (!definition || problems.length) return { automationId: existing?.id ?? null, planId: null, problems };
    // One the release the box would go back to can't run waits for the next update: the agent tells the person.
    if (newerDefinition(definition) && !(await ctx.services.newerAutomations.ready()))
      return { automationId: existing?.id ?? null, planId: null, problems: [laterWords(definition)] };

    const draft = definition as unknown as JsonObject;
    let automationId = existing?.id;
    if (automationId) await storeDraft(ctx, automationId, { definition: draft });
    else {
      automationId = await insertAutomation(ctx, { name: input.name, description: input.description, draft });
      await ctx.emit({
        type: 'automation.created',
        kind: 'System',
        text: `Created the automation “${cap(input.name)}”`,
        where: null,
        payload: { automationId, source: 'plan' },
      });
    }
    const row = await loadAutomationRow(tx, ctx.burrow.id, automationId);
    // One plan waits per automation: the one before it is replaced, and its card says so.
    const replaced = await tx
      .update(automationPlans)
      .set({ status: 'replaced' })
      .where(and(eq(automationPlans.automationId, row.id), eq(automationPlans.status, 'waiting')))
      .returning({ id: automationPlans.id });
    const change = row.currentVersion !== null;
    const planId = newId('automationPlan');
    await tx.insert(automationPlans).values({
      id: planId,
      burrowId: ctx.burrow.id,
      automationId: row.id,
      name: cap(input.name),
      description: input.description.slice(0, 500),
      definition,
      definitionHash: definitionHash(definition),
      grants: definitionGrants(definition, input.asks),
      baseVersion: row.currentVersion,
      baseGrants: change ? await automationGrants(tx, row.principalId) : null,
      thinking: input.thinking,
      status: 'waiting',
      conversationId: conversation.id,
      threadRootId: turn.threadRootId,
      createdByDispatchId: turn.id,
      createdAt: ctx.now,
    });
    // The card in the turn's thread: server-made, by reference, wakes nobody.
    const posted = await postMessage(ctx, {
      conversation,
      text: input.message?.trim() || planMessageText(change),
      card: { kind: 'automation_plan', planId },
      threadRootId: turn.threadRootId,
      mentions: [],
      dispatch: false,
      notifyMentions: false,
    });
    await tx.update(automationPlans).set({ messageId: posted.id }).where(eq(automationPlans.id, planId));
    await ctx.emit({
      type: 'automation.plan_proposed',
      kind: 'System',
      text: planCardText(cap(input.name), change),
      where: null,
      payload: { automationId: row.id, planId, change, replaced: replaced.map((r) => r.id) },
    });
    await republishPlanCardsById(
      ctx,
      replaced.map((r) => r.id),
    );
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id, planId, problems: [] as string[] };
  },
});

/** A plan and its automation, locked, for the person deciding on it. */
async function lockedPlan(ctx: ApplyContext, planId: string) {
  const [plan] = await ctx.tx
    .select()
    .from(automationPlans)
    .where(and(eq(automationPlans.id, planId), eq(automationPlans.burrowId, ctx.burrow.id)))
    .for('update');
  if (!plan) throw notFound('Plan');
  const [row] = await ctx.tx
    .select()
    .from(automations)
    .where(eq(automations.id, plan.automationId))
    .for('update');
  if (!row || row.deletedAt) throw conflict(AUTOMATION_PLAN_DECIDED_TEXT.gone);
  if (plan.status !== 'waiting') throw conflict(AUTOMATION_PLAN_DECIDED_TEXT[plan.status]);
  return { plan, row };
}

async function planName(db: Db, planId: string) {
  const [row] = await db
    .select({ name: automationPlans.name })
    .from(automationPlans)
    .where(eq(automationPlans.id, planId));
  return row?.name ?? 'an automation';
}

/**
 * Turn it on: exactly the plan's definition becomes the next version, switched on, with the plan's keys in place
 * of what the automation held, and its name and description. Refused when another plan replaced it or the automation
 * changed since (its card's changes would no longer be true).
 */
export const acceptAutomationPlan = defineCommand({
  name: 'automation.accept_plan',
  schema: z.object({ planId: AutomationPlanId }),
  async requiredKey(input, { db }) {
    return MANAGE(await planName(db, input.planId), 'turn on');
  },
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    if (!mayPublish(ctx)) throw forbidden('Only you can turn on an automation.');
    const { plan, row } = await lockedPlan(ctx, input.planId);
    if (row.currentVersion !== plan.baseVersion)
      throw conflict('This automation changed since the plan was made. Ask for a new plan in Chat.');
    const check = validateDefinition(plan.definition, ctx.now.getTime());
    if (!check.ok) throw badRequest(`This plan can’t run as it is: ${check.problems.slice(0, 3).join(' ')}`);
    if (definitionHash(check.definition) !== plan.definitionHash)
      throw conflict('This plan isn’t what was shown. Ask for a new plan in Chat.');
    const problems = await referenceProblems(ctx, check.definition, true);
    if (problems.length) throw badRequest(problems.slice(0, 3).join(' '));
    const name = cap(plan.name);
    await tx
      .update(automations)
      .set({ name, description: plan.description, updatedAt: ctx.now })
      .where(eq(automations.id, row.id));
    await writeGrants(ctx, { id: row.id, name, principalId: row.principalId }, plan.grants);
    const version = await publishVersion(
      ctx,
      { id: row.id, name, currentVersion: row.currentVersion },
      check.definition,
      true,
    );
    await tx
      .update(automationPlans)
      .set({ status: 'accepted', decidedById: ctx.actor.id, decidedAt: ctx.now, version })
      .where(eq(automationPlans.id, plan.id));
    await ctx.emit({
      type: 'automation.plan_accepted',
      kind: 'System',
      text: `Turned on “${name}” (version ${version})`,
      where: null,
      payload: { automationId: row.id, planId: plan.id, version },
    });
    await republishPlanCardsById(ctx, [plan.id]);
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id, version };
  },
});

/**
 * Not now: the plan is set aside and nothing changes; an automation that was never on goes with it, and a live
 * one keeps running as it was. The agent isn't woken: the person replies in the thread when they want something else.
 */
export const declineAutomationPlan = defineCommand({
  name: 'automation.decline_plan',
  schema: z.object({ planId: AutomationPlanId }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const { plan, row } = await lockedPlan(ctx, input.planId);
    await tx
      .update(automationPlans)
      .set({ status: 'declined', decidedById: ctx.actor.id, decidedAt: ctx.now })
      .where(eq(automationPlans.id, plan.id));
    const deleted = row.currentVersion === null;
    if (deleted) await removeAutomation(ctx, row);
    else await storeDraft(ctx, row.id, { definition: null });
    await ctx.emit({
      type: 'automation.plan_declined',
      kind: 'System',
      text: `Not now: “${plan.name}”`,
      where: null,
      payload: { automationId: row.id, planId: plan.id, deleted },
    });
    await republishPlanCardsById(ctx, [plan.id]);
    if (!deleted) await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { planId: plan.id, automationId: row.id, deleted };
  },
});

export const PLAN_COMMANDS = [proposeAutomationPlan, acceptAutomationPlan, declineAutomationPlan];
