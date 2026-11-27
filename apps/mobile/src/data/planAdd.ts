/**
 * Adding a step to a plan on Android (AP-718; the web's “Add a step”, work-supervision WS-07): a title makes a queued
 * step (`plans.addStep`). A plan is the agent's own work (Whombat one-agent.md OA-14; app one-agent.md AP-4990): the
 * step has no owner and nothing is handed over. A due time is set on the web. Pure, so it is unit-tested.
 */
import { ApiError } from '@whombat/client';
import { PLAN_MAX_STEPS, type Plan } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

/** A step's title: 1–160 characters (the contract's `StepTitle`). */
export const PLAN_STEP_TITLE_MAX = 160;

/** Whether the plan takes another step (at most 30). */
export function canAddStep(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.length < PLAN_MAX_STEPS;
}

/** Why Add is held, or null: a title of at most 160 characters. */
export function addStepProblem(title: string, locale?: string): string | null {
  const { t } = mobileTranslator(locale);
  const trimmed = title.trim();
  if (!trimmed) return t('data.planAdd.noTitle');
  if (trimmed.length > PLAN_STEP_TITLE_MAX) return t('data.planAdd.tooLong', { max: PLAN_STEP_TITLE_MAX });
  return null;
}

/** What Add sends: `plans.addStep`'s body. */
export function addStepBody(title: string): { title: string } {
  return { title: title.trim() };
}

/** The button, and what it says while busy. */
export function addStepLabel(busy: boolean, locale?: string): string {
  const { t } = mobileTranslator(locale);
  return busy ? t('data.planAdd.adding') : t('data.planAdd.add');
}

/** What went through: “Added “Write the tests”.” */
export function addStepDoneText(title: string, locale?: string): string {
  return mobileTranslator(locale).t('data.planAdd.added', { title: title.trim() });
}

/** A refusal in the server's words: a plan that's gone, a plan you can't change. */
export function addStepRefusal(error: unknown, locale?: string): string | null {
  if (!(error instanceof ApiError)) return null;
  const { t } = mobileTranslator(locale);
  if (error.status === 404) return t('data.planAdd.gone');
  if (error.code === 'forbidden') return t('data.planAdd.forbidden');
  return error.message || null;
}
