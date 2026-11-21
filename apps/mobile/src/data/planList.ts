/**
 * The plans list on Android (AP-718; the web's Plans pane, work-supervision WS-09): every plan the viewer can see, open
 * ones first, each with its progress, due date, where it lives and the step that leads it — the first that needs
 * someone, else the first open one. Pure, so it is unit-tested; the screen renders these.
 */
import { formatDue, type Plan, planProgress } from '@whombat/core';
import { PLAN_MARKER_LABELS, PLAN_STATE_TONES, type PlanMarker, type PlanStateTone } from './plan';

/** Open plans, or every plan (`plans.list`'s `status`). */
export type PlanListFilter = 'open' | 'all';

export const PLAN_FILTERS: readonly { value: PlanListFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
];

export const PLANS_EMPTY_TEXT: Record<PlanListFilter, string> = {
  open: 'No open plans. Make one from a message on the web, or ask your agent for a plan.',
  all: 'No plans yet. Make one from a message on the web, or ask your agent for a plan.',
};

/** One conversation's plans, from its menu (work-removal-android.md AP-859). */
export const PLANS_HERE_EMPTY_TEXT: Record<PlanListFilter, string> = {
  open: 'No open plans here. Make one from a message on the web, or ask your agent for a plan.',
  all: 'No plans here yet. Make one from a message on the web, or ask your agent for a plan.',
};

export interface PlanListRow {
  id: string;
  title: string;
  /** “2 of 4 done · Due 14 Oct”, “No steps yet”. */
  meta: string;
  /** “#billing-v2”, or null when the sidebar doesn't know the conversation. */
  where: string | null;
  /** The step that leads the plan, or null when every step is done or cancelled. */
  next: {
    title: string;
    marker: PlanMarker;
    markerLabel: string;
    stateLabel: string;
    tone: PlanStateTone;
  } | null;
  /** Every counted step done: listed after the open ones. */
  done: boolean;
  accessibilityLabel: string;
}

/** The first step that needs someone (gate, blocked), else the first open one (active, queued). */
function headline(plan: Plan) {
  return (
    plan.steps.find((s) => s.state === 'gate' || s.state === 'blocked') ??
    plan.steps.find((s) => s.state === 'active' || s.state === 'queued') ??
    null
  );
}

export function planListRow(plan: Plan, where: string | null): PlanListRow {
  const { done, total } = planProgress(plan);
  const progress = total === 0 ? 'No steps yet' : `${done} of ${total} done`;
  const meta = [progress, plan.due ? formatDue(plan.due) : null].filter(Boolean).join(' · ');
  const step = headline(plan);
  const next = step
    ? {
        title: step.title,
        marker: step.state,
        markerLabel: PLAN_MARKER_LABELS[step.state],
        stateLabel: step.stateLabel,
        tone: PLAN_STATE_TONES[step.state],
      }
    : null;
  return {
    id: plan.id,
    title: plan.title,
    meta,
    where,
    next,
    done: total > 0 && done === total,
    accessibilityLabel: [plan.title, where, meta, next ? `Next: ${next.title}, ${next.stateLabel}` : null]
      .filter(Boolean)
      .join('. '),
  };
}

/** The rows in the server's order (newest first), open plans before finished ones, as on the web. */
export function planListRows(
  plans: readonly Plan[],
  whereOf: (conversationId: string) => string | undefined,
): PlanListRow[] {
  const rows = plans.map((p) => planListRow(p, whereOf(p.conversationId) ?? null));
  return [...rows.filter((r) => !r.done), ...rows.filter((r) => r.done)];
}
