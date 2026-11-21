/**
 * Adding a step to a plan on Android (AP-718; the web's “Add a step”, work-supervision WS-07): a title makes a queued
 * step (`plans.addStep`). A plan is the agent's own work (Whombat one-agent.md OA-14; app one-agent.md AP-4990): the
 * step has no owner and nothing is handed over. A due time is set on the web. Pure, so it is unit-tested.
 */
import { ApiError } from '@whombat/client';
import { PLAN_MAX_STEPS, type Plan } from '@whombat/core';

/** A step's title: 1–160 characters (the contract's `StepTitle`). */
export const PLAN_STEP_TITLE_MAX = 160;

/** Whether the plan takes another step (at most 30). */
export function canAddStep(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.length < PLAN_MAX_STEPS;
}

/** Why Add is held, or null: a title of at most 160 characters. */
export function addStepProblem(title: string): string | null {
  const t = title.trim();
  if (!t) return 'Give the step a title.';
  if (t.length > PLAN_STEP_TITLE_MAX) return `Keep the title to ${PLAN_STEP_TITLE_MAX} characters.`;
  return null;
}

/** What Add sends: `plans.addStep`'s body. */
export function addStepBody(title: string): { title: string } {
  return { title: title.trim() };
}

/** The button, and what it says while busy. */
export function addStepLabel(busy: boolean): string {
  return busy ? 'Adding…' : 'Add step';
}

/** What went through: “Added “Write the tests”.” */
export function addStepDoneText(title: string): string {
  return `Added “${title.trim()}”.`;
}

/** A refusal in the server's words: a plan that's gone, a plan you can't change. */
export function addStepRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) return 'This plan isn’t here any more.';
  if (error.code === 'forbidden') return 'You can’t change this plan.';
  return error.message || null;
}
