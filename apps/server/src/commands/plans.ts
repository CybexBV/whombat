/**
 * Plans: checklists of the agent's own work in a conversation (docs/decisions/work-supervision.md WS-01…WS-10;
 * one-agent.md OA-14: steps have no owner, nobody is handed a step).
 *
 * The person and the agent make and change plans in every conversation of the burrow, without a key (contracts
 * CT-1109); the agent's MCP adapter keeps an outsiders' turn to its own conversation (BP-C35). Every change is
 * `savePlan` (domain/plans.ts): one signed `plan.updated`, the frame, the PLAN search document and the needs-you
 * notifications, in the commit.
 *
 * Starting a step is a person's (WS-04): the agent is asked by a message in the plan's thread (the ordinary dispatch,
 * linked to the step when it is queued), an automation by its Run now.
 */
import {
  CreatePlanBody,
  type KeyId,
  MCP_TOOLS,
  newId,
  PLAN_MAX_STEPS,
  PLAN_STEP_LABELS,
  PlanId,
  PlanStepLinkInput,
  PlanStepNote,
  PlanStepState,
  StartPlanStepBody,
  StepId,
  stepGoesAhead,
  topics,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { runAutomationNow } from '../automations/commands';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import {
  approvals,
  automationRuns,
  automations,
  canvases,
  dispatches,
  messages,
  plans,
  runs,
} from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { projectSteps } from '../domain/plan-follow';
import {
  commandWriter,
  lockPlanRow,
  newStep,
  type PlanRow,
  planEventText,
  planLink,
  planThread,
  planWhere,
  type StoredStep,
  savePlan,
  stepRemovable,
} from '../domain/plans';
import { indexPlan } from '../domain/search-index';
import { publishChatChanged } from '../home/notify';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadAgentRow } from '../read/principals';
import { loadPlan, toApproval } from '../read/work';
import { insertCanvas } from './content';

/* Access ----------------------------------------------------------------------------------------- */

/** The burrow's plan, locked for the commit. */
async function editablePlan(ctx: ApplyContext, planId: string): Promise<PlanRow> {
  const plan = await lockPlanRow(ctx.tx, ctx.burrow.id, planId);
  if (!plan) throw notFound('Plan');
  return plan;
}

/* Editing ---------------------------------------------------------------------------------------- */

// OA: needs contracts 0.123.0 — the contract's step bodies drop `ownerId`; one sent until then is ignored (OA-14).
const StepEdit = z.object({
  stepId: StepId,
  title: z.string().trim().min(1).max(160).optional(),
  state: PlanStepState.optional(),
  note: PlanStepNote.nullable().optional(),
  link: PlanStepLinkInput.optional(),
});
type StepEdit = z.infer<typeof StepEdit>;

const PlanEdits = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  due: z.iso.date().nullable().optional(),
  add: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        after: StepId.nullable().optional(),
      }),
    )
    .max(PLAN_MAX_STEPS)
    .optional(),
  steps: z.array(StepEdit).max(PLAN_MAX_STEPS).optional(),
  order: z.array(StepId).max(PLAN_MAX_STEPS).optional(),
  remove: z.array(StepId).max(PLAN_MAX_STEPS).optional(),
});
type PlanEdits = z.infer<typeof PlanEdits>;

/** The step's linked work, replaced (the previous links stay in the signed event, WS-03). */
function withLinks(
  step: StoredStep,
  links: Partial<Pick<StoredStep, 'runId' | 'approvalId' | 'automationRunId' | 'dispatchId'>>,
) {
  return { ...step, ...links };
}

/** Resolves a link by number to work in this burrow (WS-03): every room's work is the person's. */
async function resolveLinks(
  ctx: ApplyContext,
  link: z.infer<typeof PlanStepLinkInput>,
): Promise<Partial<Pick<StoredStep, 'runId' | 'approvalId' | 'automationRunId'>>> {
  const out: Partial<Pick<StoredStep, 'runId' | 'approvalId' | 'automationRunId'>> = {};
  if (link.runNumber === null) out.runId = null;
  else if (link.runNumber !== undefined) {
    const [run] = await ctx.tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.burrowId, ctx.burrow.id), eq(runs.number, link.runNumber)));
    if (!run) throw notFound(`Run #${link.runNumber}`);
    out.runId = run.id;
  }
  if (link.approvalNumber === null) out.approvalId = null;
  else if (link.approvalNumber !== undefined) {
    const [row] = await ctx.tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.burrowId, ctx.burrow.id), eq(approvals.number, link.approvalNumber)));
    const approval = row ? toApproval(row) : null;
    if (!row || !approval) throw notFound(`Approval #${link.approvalNumber}`);
    out.approvalId = row.id;
  }
  if (link.automationRunNumber === null) out.automationRunId = null;
  else if (link.automationRunNumber !== undefined) {
    const [r] = await ctx.tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        and(eq(automationRuns.burrowId, ctx.burrow.id), eq(automationRuns.number, link.automationRunNumber)),
      );
    if (!r) throw notFound(`Automation run #${link.automationRunNumber}`);
    out.automationRunId = r.id;
  }
  return out;
}

/**
 * Applies edits to a plan's steps in memory: renames, a due date, new steps, step edits (links by number are checked
 * and followed), removals of steps that never started, and a reorder (every step once).
 */
async function editPlan(ctx: ApplyContext, plan: PlanRow, edits: PlanEdits) {
  let steps: StoredStep[] = [...plan.steps];
  const at = ctx.at;
  if (edits.add?.length) {
    for (const a of edits.add) {
      if (steps.length >= PLAN_MAX_STEPS) throw conflict(`A plan has at most ${PLAN_MAX_STEPS} steps.`);
      const step = newStep(newId('step'), a.title, at);
      const idx = a.after ? steps.findIndex((s) => s.id === a.after) : -1;
      if (a.after && idx < 0) throw notFound('Step');
      steps.splice(idx < 0 ? steps.length : idx + 1, 0, step);
    }
  }
  for (const e of edits.steps ?? []) steps = await editStep(ctx, plan, steps, e);
  for (const id of edits.remove ?? []) {
    const step = steps.find((s) => s.id === id);
    if (!step) throw notFound('Step');
    if (!stepRemovable(step))
      throw new ApiError('conflict', 'This step has started, so it can’t be removed. Cancel it instead.', {
        details: { reason: 'step_started' },
      });
    steps = steps.filter((s) => s.id !== id);
  }
  if (edits.order) {
    const ids = steps.map((s) => s.id);
    if (
      edits.order.length !== ids.length ||
      new Set(edits.order).size !== ids.length ||
      !ids.every((id) => edits.order?.includes(id))
    )
      throw badRequest('The order must list every step of the plan once.');
    const byId = new Map(steps.map((s) => [s.id, s]));
    steps = edits.order.map((id) => byId.get(id) as StoredStep);
  }
  return {
    ...(edits.title !== undefined ? { title: edits.title } : {}),
    ...(edits.due !== undefined ? { due: edits.due } : {}),
    steps,
  };
}

async function editStep(
  ctx: ApplyContext,
  plan: PlanRow,
  steps: StoredStep[],
  e: StepEdit,
): Promise<StoredStep[]> {
  const index = steps.findIndex((s) => s.id === e.stepId);
  const was = steps[index];
  if (!was) throw notFound('Step');
  let step: StoredStep = { ...was };
  if (e.title !== undefined) step.title = e.title;
  if (e.link) {
    const links = await resolveLinks(ctx, e.link);
    step = { ...withLinks(step, links), startedAt: step.startedAt ?? at(ctx) };
    // Follow the new links right away (the projection key tells whether anything moved).
    const projected = await projectSteps(ctx.tx, { ...plan, steps: [step] }, () => true);
    if (projected) step = projected.steps[0] as StoredStep;
  }
  if (e.state !== undefined) {
    step.state = e.state;
    step.stateLabel = PLAN_STEP_LABELS[e.state];
    if (e.state === 'active') step.startedAt = step.startedAt ?? at(ctx);
    // Marked by hand: an old “why” doesn't stay unless a new one is given.
    if (e.note === undefined && e.state !== was.state) step.note = null;
  }
  if (e.note !== undefined) step.note = e.note;
  const next = [...steps];
  next[index] = step;
  return next;
}

const at = (ctx: ApplyContext) => iso(ctx.now);

async function saveEdits(ctx: ApplyContext, plan: PlanRow, edits: PlanEdits) {
  const next = await editPlan(ctx, plan, edits);
  const conversation = await loadConversationRow(ctx.tx, plan.conversationId);
  return savePlan(commandWriter(ctx), plan, {
    ...next,
    text: planEventText(conversation, next.title ?? plan.title, 'updated'),
  });
}

/* Commands --------------------------------------------------------------------------------------- */

export const createPlan = defineCommand({
  name: 'plan.create',
  schema: CreatePlanBody,
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    return makePlan(ctx, conversation, input);
  },
});

/**
 * Makes a plan in `conversation` (`plan.create`): its card in the source message's thread, the signed `plan.created`,
 * its search document. The caller checked that the room is the actor's burrow's.
 */
export async function makePlan(
  ctx: ApplyContext,
  conversation: NonNullable<Awaited<ReturnType<typeof loadConversationRow>>>,
  input: z.output<typeof CreatePlanBody>,
) {
  const tx = ctx.tx;
  let threadRootId: string | null = null;
  if (input.sourceMessageId) {
    const [source] = await tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        threadRootId: messages.threadRootId,
      })
      .from(messages)
      .where(eq(messages.id, input.sourceMessageId));
    if (!source || source.conversationId !== conversation.id) throw notFound('Message');
    threadRootId = source.threadRootId ?? source.id;
  }
  // The plan canvas is the person's option here; agents make one with `canvas_create {planId}` (its own key).
  if (input.canvas && ctx.actor.kind !== 'person')
    throw forbidden('Make the plan canvas with canvas_create.');
  const id = newId('plan');
  const steps = input.steps.map((s) => newStep(newId('step'), s.title, ctx.at));
  await tx.insert(plans).values({
    id,
    burrowId: ctx.burrow.id,
    title: input.title,
    due: input.due ?? null,
    conversationId: conversation.id,
    steps,
    createdById: ctx.actor.id,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    sourceMessageId: input.sourceMessageId ?? null,
    sourceThreadRootId: threadRootId,
  });
  const posted = await postMessage(ctx, {
    conversation,
    // The mock's words for a plan card (the card itself shows the title and states).
    text: 'Here’s the plan.',
    card: { kind: 'plan', planId: id },
    threadRootId,
    mentions: [],
    dispatch: false,
  });
  await tx.update(plans).set({ messageId: posted.id }).where(eq(plans.id, id));
  const event = await ctx.emit({
    type: 'plan.created',
    kind: 'Messages',
    text: planEventText(conversation, input.title, 'made'),
    where: planWhere(conversation),
    ref: (await planLink(tx, { id, conversationId: conversation.id })) ?? undefined,
    payload: {
      planId: id,
      conversationId: conversation.id,
      messageId: posted.id,
      sourceMessageId: input.sourceMessageId ?? null,
      steps: steps.map((s) => ({ stepId: s.id })),
    },
  });
  let canvas: { canvasId: string; slug: string } | null = null;
  if (input.canvas) canvas = await makePlanCanvas(ctx, id, {});
  const plan = await loadPlan(tx, id);
  if (plan) ctx.publish(topics.burrow(ctx.burrow.id), { type: 'plan.updated', plan }, { eventId: event.id });
  publishChatChanged(ctx, conversation);
  await indexPlan(tx, id);
  return { planId: id, messageId: posted.id, canvas };
}

export const updatePlan = defineCommand({
  name: 'plan.update',
  schema: z.object({
    planId: PlanId,
    title: PlanEdits.shape.title,
    due: PlanEdits.shape.due,
    order: PlanEdits.shape.order,
  }),
  async apply(_tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    const { planId: _id, ...edits } = input;
    await saveEdits(ctx, plan, edits);
    return { planId: plan.id };
  },
});

export const addPlanStep = defineCommand({
  name: 'plan.add_step',
  schema: z.object({
    planId: PlanId,
    title: z.string().trim().min(1).max(160),
    after: StepId.nullable().optional(),
  }),
  async apply(_tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    const before = new Set(plan.steps.map((s) => s.id));
    const saved = await saveEdits(ctx, plan, {
      add: [{ title: input.title, after: input.after ?? null }],
    });
    return { planId: plan.id, stepId: saved?.steps.find((s) => !before.has(s.id))?.id ?? null };
  },
});

export const updatePlanStep = defineCommand({
  name: 'update_plan_step',
  schema: StepEdit.extend({ planId: PlanId }),
  async apply(_tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    const { planId: _id, ...edit } = input;
    await saveEdits(ctx, plan, { steps: [edit] });
    return { planId: plan.id };
  },
});

export const removePlanStep = defineCommand({
  name: 'plan.remove_step',
  schema: z.object({ planId: PlanId, stepId: StepId }),
  async apply(_tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    await saveEdits(ctx, plan, { remove: [input.stepId] });
    return { planId: plan.id };
  },
});

/** `plan_update`: everything an agent changes in one commit and one signed event. */
export const updatePlanByAgent = defineCommand({
  name: 'plan.update_many',
  schema: MCP_TOOLS.plan_update.input,
  async apply(_tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    const { planId: _id, ...edits } = input;
    await saveEdits(ctx, plan, edits);
    return { planId: plan.id };
  },
});

/* Starting a step (WS-04) -------------------------------------------------------------------------- */

const IN_FLIGHT = ['queued', 'claimed', 'running'] as const;

export const startPlanStep = defineCommand({
  name: 'plan.start_step',
  schema: StartPlanStepBody.extend({ planId: PlanId, stepId: StepId }),
  // An automation starts with its own rules (Run now, the person only); a person's start needs no key (CT-1109).
  async requiredKey(input, ctx) {
    if (!input.automationId) return null;
    const [a] = await ctx.db
      .select({ name: automations.name })
      .from(automations)
      .where(and(eq(automations.burrowId, ctx.burrow.id), eq(automations.id, input.automationId)));
    return { keyId: 'agents.manage', attempt: `run “${a?.name ?? 'an automation'}”`, where: null };
  },
  async apply(tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    const index = plan.steps.findIndex((s) => s.id === input.stepId);
    const step = plan.steps[index];
    if (!step) throw notFound('Step');
    if (step.state === 'done' || step.state === 'cancelled')
      throw conflict(`This step is ${step.state === 'done' ? 'done' : 'cancelled'}.`);
    await refuseInFlight(ctx, step);
    const conversation = await loadConversationRow(tx, plan.conversationId);
    if (!conversation) throw notFound('Conversation');
    const cleared = withLinks(step, {
      runId: null,
      approvalId: null,
      automationRunId: null,
      dispatchId: null,
    });
    const writer = commandWriter(ctx);
    const text = planEventText(conversation, plan.title, 'updated');

    if (input.automationId) {
      if (ctx.actor.kind !== 'person') throw forbidden('Only you can run automations by hand.');
      const { runId } = await runAutomationNow.apply(tx, ctx, {
        automationId: input.automationId,
        test: false,
        text: input.message ?? step.title,
      });
      if (!runId) throw conflict('That run exists already.');
      const [run] = await tx
        .select({ number: automationRuns.number })
        .from(automationRuns)
        .where(eq(automationRuns.id, runId));
      let next: StoredStep = { ...cleared, automationRunId: runId, startedAt: step.startedAt ?? ctx.at };
      const projected = await projectSteps(tx, { ...plan, steps: [next] }, () => true);
      if (projected) next = projected.steps[0] as StoredStep;
      const saved = await savePlan(writer, plan, { steps: replace(plan.steps, index, next), text });
      return { plan: saved, dispatchId: null, messageId: null, automationRunNumber: run?.number ?? null };
    }

    // A person starts a step (the agent moves its own steps with plan_update).
    if (ctx.actor.kind !== 'person') throw forbidden('People start plan steps; mark yours with plan_update.');

    // A person starting a step asks the agent (OA-14): a message in the plan's thread (the ordinary dispatch, WS-04).
    const agent = await loadAgentRow(tx, ctx.burrow.id);
    if (!agent) throw conflict('The agent isn’t ready yet. Try again in a moment.');
    const mention = `@${agent.name.split(/\s+/)[0]}`;
    // A step the agent stopped at for the person's word: their “Go ahead” is that word.
    const words = stepGoesAhead(step)
      ? `${mention}, go ahead with step ${index + 1} of “${plan.title}”: ${step.title}`
      : `${mention}, please take step ${index + 1} of “${plan.title}”: ${step.title}`;
    const extra = input.message?.trim();
    // Marked “Asked” now; the turn's link (when it is queued) and its states follow (plan-follow.ts).
    const next: StoredStep = {
      ...cleared,
      state: 'active',
      stateLabel: 'Asked',
      note: null,
      startedAt: step.startedAt ?? ctx.at,
    };
    const saved = await savePlan(writer, plan, { steps: replace(plan.steps, index, next), text });
    const posted = await postMessage(ctx, {
      conversation,
      text: extra ? `${words}\n\n${extra}` : words,
      threadRootId: await planThread(tx, plan),
      mentions: [agent.id],
      planStep: { planId: plan.id, stepId: step.id, agentId: agent.id },
    });
    return { plan: saved, messageId: posted.id, posted, dispatchId: null, automationRunNumber: null };
  },
});

function replace(steps: readonly StoredStep[], index: number, step: StoredStep): StoredStep[] {
  const next = [...steps];
  next[index] = step;
  return next;
}

/**
 * A step that is under way can't be started again while its turn or run is still going; a blocked step or one that
 * needs a person can be retried (its new turn queues behind the old one: one turn at a time per agent and room).
 */
async function refuseInFlight(ctx: ApplyContext, step: StoredStep) {
  if (step.state === 'blocked' || step.state === 'gate') return;
  if (step.dispatchId) {
    const [d] = await ctx.tx
      .select({ state: dispatches.state })
      .from(dispatches)
      .where(eq(dispatches.id, step.dispatchId));
    if (d && (IN_FLIGHT as readonly string[]).includes(d.state))
      throw conflict('This step is already being worked on.');
  }
  if (step.runId) {
    const [r] = await ctx.tx.select({ status: runs.status }).from(runs).where(eq(runs.id, step.runId));
    if (r?.status === 'live') throw conflict('This step’s run is still going.');
  }
  if (step.automationRunId) {
    const [r] = await ctx.tx
      .select({ status: automationRuns.status })
      .from(automationRuns)
      .where(eq(automationRuns.id, step.automationRunId));
    if (r && ['queued', 'running', 'waiting', 'paused'].includes(r.status))
      throw conflict('This step’s automation run is still going.');
  }
}

/* Links from the runtime ------------------------------------------------------------------------- */

/**
 * `start_run` links the run to the step it carries out (WS-03): the step the agent named, else the step its turn
 * was handed. The previous run link stays in the signed event; the step then follows the run (`publishRun`).
 */
export async function linkRunToStep(
  ctx: ApplyContext,
  runId: string,
  named: { planId: string; stepId: string } | null,
  dispatchId: string | null,
): Promise<void> {
  await linkWorkToStep(ctx, { runId }, named, dispatchId);
}

/**
 * Link work an agent started to the plan step it carries out (WS-03): the step named, else the step its turn was
 * handed (`dispatches.plan_step_id`), only while the step is still that turn's. A run, or an approval the agent asked
 * for in that turn (the step then waits for the person, WS-05).
 */
export async function linkWorkToStep(
  ctx: ApplyContext,
  work: { runId: string } | { approvalId: string },
  named: { planId: string; stepId: string } | null,
  dispatchId: string | null,
): Promise<boolean> {
  let target = named;
  if (!target && dispatchId) {
    const [d] = await ctx.tx
      .select({ planId: dispatches.planId, planStepId: dispatches.planStepId })
      .from(dispatches)
      .where(eq(dispatches.id, dispatchId));
    if (d?.planId && d.planStepId) target = { planId: d.planId, stepId: d.planStepId };
  }
  if (!target) return false;
  const plan = await lockPlanRow(ctx.tx, ctx.burrow.id, target.planId);
  const index = plan ? plan.steps.findIndex((s) => s.id === target.stepId) : -1;
  const step = plan?.steps[index];
  if (!plan || !step) {
    if (named) throw notFound('Plan step');
    return false;
  }
  if (step.state === 'done' || step.state === 'cancelled') {
    if (named) throw conflict(`That step is ${step.state === 'done' ? 'done' : 'cancelled'}.`);
    return false;
  }
  // A turn handed the step links its work only while the step is still its turn's (not after a retry).
  if (!named && step.dispatchId !== dispatchId) return false;
  const next: StoredStep = { ...step, ...work, startedAt: step.startedAt ?? ctx.at };
  await savePlan(commandWriter(ctx), plan, {
    steps: replace(plan.steps, index, next),
    text: null,
    payload: { ...work },
  });
  return true;
}

/* Plan canvases (WS-08) -------------------------------------------------------------------------- */

async function makePlanCanvas(
  ctx: ApplyContext,
  planId: string,
  opts: { title?: string; markdown?: string },
): Promise<{ canvasId: string; slug: string }> {
  const plan = await lockPlanRow(ctx.tx, ctx.burrow.id, planId);
  if (!plan) throw notFound('Plan');
  if (plan.canvasId) {
    const [existing] = await ctx.tx
      .select({ id: canvases.id, slug: canvases.slug })
      .from(canvases)
      .where(eq(canvases.id, plan.canvasId));
    if (existing) return { canvasId: existing.id, slug: existing.slug };
  }
  const intro = opts.markdown?.trim();
  const markdown = `# ${plan.title}\n\n${intro ? `${intro}\n\n` : ''}## Steps\n\n:::plan{id=${plan.id}}\n:::\n`;
  const made = await insertCanvas(ctx, {
    title: opts.title ?? `${plan.title} · plan`,
    conversationId: plan.conversationId,
    markdown,
    planId: plan.id,
  });
  await ctx.tx
    .update(plans)
    .set({ canvasId: made.canvasId, updatedAt: ctx.now })
    .where(eq(plans.id, plan.id));
  const loaded = await loadPlan(ctx.tx, plan.id);
  if (loaded) ctx.publish(topics.burrow(ctx.burrow.id), { type: 'plan.updated', plan: loaded });
  return made;
}

export const createPlanCanvas = defineCommand({
  name: 'plan.create_canvas',
  schema: z.object({
    planId: PlanId,
    title: z.string().trim().min(1).max(160).optional(),
    markdown: z.string().max(20_000).optional(),
  }),
  requiredKey: () => ({ keyId: 'canvas.write' as KeyId, attempt: 'write a plan canvas', where: null }),
  async apply(_tx, ctx, input) {
    const plan = await editablePlan(ctx, input.planId);
    const made = await makePlanCanvas(ctx, plan.id, {
      ...(input.title ? { title: input.title } : {}),
      ...(input.markdown ? { markdown: input.markdown } : {}),
    });
    return { planId: plan.id, ...made, created: plan.canvasId === null };
  },
});
