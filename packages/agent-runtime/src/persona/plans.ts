/**
 * The plan step a turn was handed (docs/decisions/work-supervision.md WS-04), in the user turn: which step of which
 * plan, the plan around it, and how the step moves (a run linked to it, or `plan_update`).
 */
import type { DispatchContext } from '@whombat/core/contracts';

export function planStepLines(context: Pick<DispatchContext, 'planStep'>): string[] {
  const p = context.planStep;
  if (!p) return [];
  return [
    '',
    `You were handed step ${p.position} of the plan “${p.planTitle}”: ${p.title} (plan ${p.planId}, step ${p.stepId}).`,
    'The plan:',
    ...p.outline.map((line) => `  ${line}`),
    'A run you start in this turn is linked to the step and moves it. Without a run, say in the thread what you did and, if you can, mark the step done with plan_update (or put what blocks it in its note).',
  ];
}
