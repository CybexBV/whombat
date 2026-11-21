/**
 * Which rooms a run's steps touch (docs/decisions/bp-automations.md BP-C19, BP-C20). Pure: derived from the
 * definition a run stores and the run's own room, so every step's rooms are fixed when the run is created.
 *
 * - `stepActsIn`: the room a step posts or asks in (null for steps that act in no room).
 * - `stepContentRooms`: every room whose content may be in a step's input or output — the room it acts in, the run's
 *   room when it reads the trigger, and, transitively, the rooms of the earlier steps it reads (templates,
 *   conditions, `attachFrom`). The publisher must be in all of them before the step runs; a viewer must be in all
 *   of them to see what went into the step and what came out.
 */
import type { AutomationDefinition, AutomationStep } from '../domain/automation.js';
import { type Expr, ExprError, parseExpr, referencedSteps } from './expr.js';
import { templatePaths } from './template.js';

/** The room a step posts or asks in, for a run in `runConversationId` (null: it acts in no room). */
export function stepActsIn(step: AutomationStep, runConversationId: string): string | null {
  switch (step.kind) {
    case 'dispatch_agent':
    case 'post_message':
      return step.conversation === 'run' ? runConversationId : step.conversation;
    case 'request_approval':
    case 'open_pull_request':
    case 'merge_pull_request':
      // The approval card, the prepared pull request, or a merge's card and its “Merged PR #10 into main.” line (0.70),
      // is posted in the run's room.
      return runConversationId;
    default:
      return null;
  }
}

/** The texts of a step that templates fill in. */
function templatesOf(step: AutomationStep): string[] {
  switch (step.kind) {
    case 'dispatch_agent':
      return [
        step.prompt,
        ...(step.workspace?.branch ? [step.workspace.branch] : []),
        ...(step.workspace?.pullRequest ? [step.workspace.pullRequest] : []),
      ];
    case 'post_message':
      return [step.text];
    case 'request_approval':
      return [step.title, step.details, ...(step.bindBranch ? [step.bindBranch.branch] : [])];
    case 'open_pull_request':
      return [step.branch, step.title, step.body];
    case 'http_callback':
      return [step.body];
    case 'github_comment':
      return [step.number, step.text];
    case 'tracker_update':
    case 'tracker_reply':
    case 'tracker_decision':
      return [step.report];
    case 'merge_pull_request':
      return [step.number];
    default:
      return [];
  }
}

function readsTrigger(e: Expr): boolean {
  switch (e.k) {
    case 'path':
      return e.parts[0] === 'trigger';
    case 'call':
      return e.args.some(readsTrigger);
    case 'not':
      return readsTrigger(e.e);
    case 'bin':
      return readsTrigger(e.a) || readsTrigger(e.b);
    default:
      return false;
  }
}

/** What a step reads: the trigger, and earlier steps by id. */
export function stepReads(step: AutomationStep): { trigger: boolean; steps: string[] } {
  let trigger = false;
  const steps = new Set<string>();
  for (const text of templatesOf(step))
    for (const path of templatePaths(text)) {
      const [root, id] = path.split('.');
      if (root === 'trigger') trigger = true;
      else if (root === 'steps' && id) steps.add(id);
    }
  if (step.kind === 'post_message') for (const id of step.attachFrom) steps.add(id);
  // A tracker write-back sends what step `from`'s agent assessed (0.69, TA-11).
  // A reply sends that agent's reply (0.75, TA-25).
  if (step.kind === 'tracker_update' || step.kind === 'tracker_reply' || step.kind === 'tracker_decision')
    steps.add(step.from);
  // A reply that tells a person's decision reads it (3.12, TA-46).
  if (step.kind === 'tracker_reply' && step.decision) steps.add(step.decision);
  if (step.kind === 'condition') {
    try {
      const expr = parseExpr(step.if);
      for (const id of referencedSteps(expr)) steps.add(id);
      if (readsTrigger(expr)) trigger = true;
    } catch (err) {
      // An unparseable condition never runs; count it as reading the trigger anyway.
      if (!(err instanceof ExprError)) throw err;
      trigger = true;
    }
  }
  return { trigger, steps: [...steps] };
}

/**
 * For each step (by index), every room whose content may be in its input or output: the room it acts in, the run's
 * room when it reads the trigger, and the rooms of the earlier steps it reads (transitively).
 */
export function stepContentRooms(def: AutomationDefinition, runConversationId: string): string[][] {
  const byId = new Map<string, Set<string>>();
  const out: string[][] = [];
  for (const step of def.steps) {
    const rooms = new Set<string>();
    const acts = stepActsIn(step, runConversationId);
    if (acts) rooms.add(acts);
    const reads = stepReads(step);
    if (reads.trigger) rooms.add(runConversationId);
    for (const id of reads.steps) for (const r of byId.get(id) ?? []) rooms.add(r);
    byId.set(step.id, rooms);
    out.push([...rooms]);
  }
  return out;
}

/** The rooms the publisher must still be in before step `idx` runs: the run's room and the step's content rooms. */
export function stepRequiredRooms(
  def: AutomationDefinition,
  runConversationId: string,
  idx: number,
): string[] {
  return [...new Set([runConversationId, ...(stepContentRooms(def, runConversationId)[idx] ?? [])])];
}
