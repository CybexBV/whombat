/**
 * The plans list on Android (AP-718; the web's Plans pane, work-supervision WS-09): every plan the viewer can see, open
 * ones first, each with its progress, due date, where it lives and the step that leads it — the first that needs
 * someone, else the first open one. Pure, so it is unit-tested; the screen renders these.
 */
import { formatDue, type Plan, planProgress } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import { PLAN_STATE_TONES, type PlanMarker, type PlanStateTone, planMarkerLabels } from './plan';

/** Open plans, or every plan (`plans.list`'s `status`). */
export type PlanListFilter = 'open' | 'all';

export function planFilters(locale?: string): readonly { value: PlanListFilter; label: string }[] {
  const { t } = mobileTranslator(locale);
  return [
    { value: 'open', label: t('data.planList.open') },
    { value: 'all', label: t('data.planList.all') },
  ];
}
export const PLAN_FILTERS = planFilters();

export function plansEmptyText(locale?: string): Record<PlanListFilter, string> {
  const { t } = mobileTranslator(locale);
  return { open: t('data.planList.emptyOpen'), all: t('data.planList.emptyAll') };
}
export const PLANS_EMPTY_TEXT = plansEmptyText();

/** One conversation's plans, from its menu (work-removal-android.md AP-859). */
export function plansHereEmptyText(locale?: string): Record<PlanListFilter, string> {
  const { t } = mobileTranslator(locale);
  return { open: t('data.planList.hereEmptyOpen'), all: t('data.planList.hereEmptyAll') };
}
export const PLANS_HERE_EMPTY_TEXT = plansHereEmptyText();

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

export function planListRow(plan: Plan, where: string | null, locale?: string): PlanListRow {
  const { t } = mobileTranslator(locale);
  const { done, total } = planProgress(plan);
  const progress = total === 0 ? t('data.planList.noSteps') : t('data.messages.doneOf', { done, total });
  const meta = [progress, plan.due ? formatDue(plan.due, locale) : null].filter(Boolean).join(' · ');
  const step = headline(plan);
  const next = step
    ? {
        title: step.title,
        marker: step.state,
        markerLabel: planMarkerLabels(locale)[step.state],
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
    accessibilityLabel: [
      plan.title,
      where,
      meta,
      next ? t('data.planList.next', { title: next.title, state: next.stateLabel }) : null,
    ]
      .filter(Boolean)
      .join('. '),
  };
}

/** The rows in the server's order (newest first), open plans before finished ones, as on the web. */
export function planListRows(
  plans: readonly Plan[],
  whereOf: (conversationId: string) => string | undefined,
  locale?: string,
): PlanListRow[] {
  const rows = plans.map((p) => planListRow(p, whereOf(p.conversationId) ?? null, locale));
  return [...rows.filter((r) => !r.done), ...rows.filter((r) => r.done)];
}
