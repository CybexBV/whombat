/**
 * The runner's side of a Whombat Feedback assessment (docs/decisions/feedback.md FB-21), enforced here whatever the
 * server sent: the workspace is a read-only export (never pushed from), the sandbox is read-only and the network off
 * (`sandboxFor`, `networkFor`). Never a silent fallback.
 */
import type { DispatchContext } from '@whombat/core';

export function isAssessment(ctx: DispatchContext): boolean {
  return ctx.dispatch.trigger === 'feedback';
}

/** Why this runner won't run an assessment turn (the agent says it in the report thread), or null. */
export function feedbackRefusal(ctx: DispatchContext): string | null {
  if (!isAssessment(ctx) || ctx.feedback) return null;
  return 'I can’t assess this report: what I was to assess didn’t reach the runner, so I stopped.';
}

/** The context as the runner runs an assessment: the checkout read-only, never write-approved. */
export function confineFeedback(ctx: DispatchContext): DispatchContext {
  if (!isAssessment(ctx) || !ctx.workspace) return ctx;
  return { ...ctx, workspace: { ...ctx.workspace, access: 'read', writeApproved: false } };
}
