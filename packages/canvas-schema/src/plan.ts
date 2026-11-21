/**
 * The plan block ⇄ Plan binding (TODO 11.2). The Plan object is the truth for step state; the document
 * carries a copy the editor renders and people edit:
 *
 * - `syncPlanIntoDoc(doc, plan)`: the Plan changed (a run finished, an approval moved) → the new document,
 *   keeping each step's inline content (and the comment anchors in it) when its title did not change.
 * - `planStepsFromDoc(doc, planId)`: what the document now says the steps are, for the command that writes
 *   the Plan when someone edits the block.
 */
import { PLAN_STEP_LABELS, type PlanStep, type PlanStepState, planStepRemovable } from '@whombat/core';
import type { Node as PMNode } from 'prosemirror-model';
import { Fragment } from 'prosemirror-model';
import type { PlanLike, PlanStepLike } from './markdown.js';
import { NODES, PLAN_STEP_STATES } from './names.js';
import { canvasSchema } from './schema.js';

export interface DocPlanStep {
  /** Null for a step typed into the block that the Plan does not have yet (or a duplicated id). */
  stepId: string | null;
  title: string;
  state: string;
}

export interface PlanBlockAt {
  pos: number;
  node: PMNode;
}

/** Every plan block in the document (top level), in order. */
export function findPlanBlocks(doc: PMNode, planId?: string): PlanBlockAt[] {
  const out: PlanBlockAt[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === NODES.planBlock && (planId === undefined || node.attrs.planId === planId))
      out.push({ pos, node });
  });
  return out;
}

/** The steps of the first plan block bound to `planId`, or null when the document has none. */
export function planStepsFromDoc(doc: PMNode, planId: string): DocPlanStep[] | null {
  const [block] = findPlanBlocks(doc, planId);
  if (!block) return null;
  const seen = new Set<string>();
  const steps: DocPlanStep[] = [];
  block.node.forEach((step) => {
    let stepId = (step.attrs.stepId as string | null) ?? null;
    if (stepId && seen.has(stepId)) stepId = null;
    if (stepId) seen.add(stepId);
    steps.push({
      stepId,
      title: step.textContent.trim(),
      state: (step.attrs.state as string | null) ?? 'queued',
    });
  });
  return steps;
}

function stepAttrs(s: PlanStepLike) {
  return { stepId: s.id, state: s.state, stateLabel: s.stateLabel };
}

function sameAttrs(node: PMNode, attrs: Record<string, unknown>): boolean {
  return Object.entries(attrs).every(([k, v]) => node.attrs[k] === v);
}

/** The block's new content for `plan`, reusing existing step nodes (their text and marks) where possible. */
function planContent(block: PMNode, plan: PlanLike): Fragment {
  const stepType = canvasSchema.nodes[NODES.planStep];
  if (!stepType) throw new Error('planStep missing from the schema');
  const existing: PMNode[] = [];
  block.forEach((n) => {
    existing.push(n);
  });
  const byId = new Map<string, PMNode>();
  for (const n of existing)
    if (n.attrs.stepId && !byId.has(n.attrs.stepId as string)) byId.set(n.attrs.stepId as string, n);
  const planIds = new Set(plan.steps.map((s) => s.id));
  const used = new Set<PMNode>();
  const steps = plan.steps.map((s, index) => {
    let prev = byId.get(s.id);
    // A step typed into the block (no id yet) takes the id the Plan gave it at the same place.
    const atIndex = existing[index];
    if (
      !prev &&
      atIndex &&
      !used.has(atIndex) &&
      (!atIndex.attrs.stepId || !planIds.has(atIndex.attrs.stepId as string))
    )
      prev = atIndex;
    if (prev) used.add(prev);
    const attrs = stepAttrs(s);
    if (prev && prev.textContent === s.title) {
      return sameAttrs(prev, attrs) ? prev : stepType.create(attrs, prev.content, prev.marks);
    }
    return stepType.create(attrs, s.title ? canvasSchema.text(s.title) : null);
  });
  return Fragment.fromArray(steps);
}

/** The document with every plan block bound to `plan.id` matching the Plan; null when nothing changes. */
export function syncPlanIntoDoc(doc: PMNode, plan: PlanLike): PMNode | null {
  let changed = false;
  const children: PMNode[] = [];
  doc.forEach((node) => {
    if (node.type.name === NODES.planBlock && node.attrs.planId === plan.id) {
      const content = planContent(node, plan);
      if (!content.eq(node.content)) {
        changed = true;
        children.push(node.copy(content));
        return;
      }
    }
    children.push(node);
  });
  return changed ? doc.copy(Fragment.fromArray(children)) : null;
}

/* Doc → Plan -------------------------------------------------------------------------------------- */

/** Default state labels for a state set from the document (`@whombat/core` `PLAN_STEP_LABELS`). */
export const PLAN_STATE_LABELS: Record<PlanStepState, string> = PLAN_STEP_LABELS;

function isState(value: string): value is PlanStepState {
  return (PLAN_STEP_STATES as readonly string[]).includes(value);
}

export interface MergePlanOptions {
  /** Id for a step typed into the block. */
  newStepId: () => string;
}

/**
 * Applies what people changed in the plan block (`before` → `after`, both from `planStepsFromDoc`) to the
 * Plan's current steps. Only the edits count: a field the document did not change keeps the Plan's value,
 * so a stale document never undoes a step the pipeline just advanced. Returns null when nothing changes.
 *
 * - a title or state changed in the block → that field on the step
 * - a step removed from the block → removed from the Plan, only while it never started (`planStepRemovable`,
 *   work-supervision WS-07); a started step is kept and the caller re-syncs the block
 * - a line typed into the block (no step id) → a new queued step, placed after its neighbour
 * - steps moved in the block → the Plan's order follows
 */
export function mergePlanEdits(
  current: readonly PlanStep[],
  before: readonly DocPlanStep[],
  after: readonly DocPlanStep[],
  opts: MergePlanOptions,
): PlanStep[] | null {
  const currentIds = new Set(current.map((s) => s.id));
  const beforeById = new Map(before.filter((s) => s.stepId).map((s) => [s.stepId as string, s]));
  const afterIds = new Set(after.map((s) => s.stepId).filter((id): id is string => !!id));
  let changed = false;

  // Removed from the block (it was there before this edit and is gone now).
  let steps = current.filter((s) => {
    const gone = beforeById.has(s.id) && !afterIds.has(s.id) && planStepRemovable(s);
    if (gone) changed = true;
    return !gone;
  });

  // Field edits.
  steps = steps.map((s) => {
    const was = beforeById.get(s.id);
    const now = after.find((a) => a.stepId === s.id);
    if (!was || !now) return s;
    let next = s;
    if (now.title && now.title !== was.title && now.title !== s.title)
      next = { ...next, title: now.title.slice(0, 160) };
    if (now.state !== was.state && isState(now.state) && now.state !== s.state)
      next = { ...next, state: now.state, stateLabel: PLAN_STATE_LABELS[now.state] };
    if (next !== s) changed = true;
    return next;
  });

  // Order: known steps follow the block's order when the block reordered them.
  const knownBefore = before.map((s) => s.stepId).filter((id): id is string => !!id && afterIds.has(id));
  const knownAfter = after.map((s) => s.stepId).filter((id): id is string => !!id && beforeById.has(id));
  if (knownBefore.join('\u0000') !== knownAfter.join('\u0000')) {
    const rank = new Map(knownAfter.map((id, i) => [id, i]));
    const ranked = steps
      .filter((s) => rank.has(s.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    let k = 0;
    steps = steps.map((s) => (rank.has(s.id) ? (ranked[k++] as PlanStep) : s));
    changed = true;
  }

  // New lines typed into the block.
  let previousId: string | null = null;
  for (const s of after) {
    const known = s.stepId && (currentIds.has(s.stepId) || beforeById.has(s.stepId));
    if (known) {
      previousId = s.stepId;
      continue;
    }
    if (!s.title) continue;
    const state = isState(s.state) ? s.state : 'queued';
    const step: PlanStep = {
      id: opts.newStepId(),
      title: s.title.slice(0, 160),
      state,
      stateLabel: PLAN_STATE_LABELS[state],
      runId: null,
      approvalId: null,
      automationRunId: null,
      dispatchId: null,
      note: null,
      updatedAt: null,
      refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    };
    const at = previousId ? steps.findIndex((x) => x.id === previousId) + 1 : 0;
    steps.splice(at, 0, step);
    previousId = step.id;
    changed = true;
  }
  return changed ? steps : null;
}
