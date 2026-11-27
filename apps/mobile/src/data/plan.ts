/**
 * Plan screen view model (work-supervision WS-09: “Mobile gets a plan screen from the plan card”): the plan card's
 * header, progress with cancelled steps left out, and one row per step — marker, title, state label in its tone, the
 * note, links to the work carrying it out and the step's next actions. A plan is the agent's own work (Whombat
 * one-agent.md OA-14; app one-agent.md AP-4990): no step has an owner, nothing is handed over. Pure, so it is
 * unit-tested.
 */
import {
  formatDue,
  formatPlanLabel,
  type Plan,
  type PlanStep,
  type PlanStepAction,
  type PlanStepState,
  planProgress,
  planStepControls,
  stepGoesAhead,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { Route } from '../navigation/routes';

/** The marker drawn for a step (WS-02): the card's four plus blocked (bad circle) and cancelled (line2 circle). */
export type PlanMarker = PlanStepState;

/** Tone of the state label, as on the web card: done ok, active ink2, gate warn, blocked bad, others mut. */
export type PlanStateTone = 'ok' | 'ink2' | 'warn' | 'bad' | 'mut';

export const PLAN_STATE_TONES: Record<PlanStepState, PlanStateTone> = {
  done: 'ok',
  active: 'ink2',
  gate: 'warn',
  blocked: 'bad',
  queued: 'mut',
  cancelled: 'mut',
};

/** Screen-reader words for the markers (the state label beside each row says the rest). */
export function planMarkerLabels(locale?: string): Record<PlanStepState, string> {
  const { t } = mobileTranslator(locale);
  return {
    done: t('data.run.step.done'),
    active: t('data.run.step.active'),
    queued: t('data.run.step.queued'),
    gate: t('data.plan.marker.gate'),
    blocked: t('data.plan.marker.blocked'),
    cancelled: t('data.plan.marker.cancelled'),
  };
}
export const PLAN_MARKER_LABELS = planMarkerLabels();

/** The step actions the phone offers: core's (`planStepActions`). */
export type MobilePlanAction = PlanStepAction;

export function planActionLabels(locale?: string): Record<MobilePlanAction, string> {
  const { t } = mobileTranslator(locale);
  return {
    start: t('data.plan.action.start'),
    mark_done: t('data.plan.action.markDone'),
    retry: t('data.plan.action.retry'),
    cancel: t('data.common.cancel'),
    open_work: t('data.plan.action.openWork'),
  };
}
export const PLAN_ACTION_LABELS = planActionLabels();

export interface PlanStepLink {
  key: 'run' | 'approval' | 'automation_run';
  /** “Run #1907”, “Approval #12”, “Automation run #41”. */
  label: string;
  route: Route;
}

export interface PlanStepButton {
  action: MobilePlanAction;
  label: string;
  variant: 'primary' | 'secondary' | 'quiet';
}

export interface PlanStepView {
  id: string;
  title: string;
  /** Done titles are muted; cancelled ones muted and struck through (WS-02). */
  titleStyle: 'normal' | 'muted' | 'struck';
  marker: PlanMarker;
  markerLabel: string;
  stateLabel: string;
  stateTone: PlanStateTone;
  note: string | null;
  links: PlanStepLink[];
  /** Where “Open work” goes: the linked run / approval / automation run, or the plan's conversation. */
  openWork: Route | null;
  /** Buttons only where the person is needed (core `planStepControls`). */
  buttons: PlanStepButton[];
  /** The rest (Start, Mark done, Cancel), in the step's ⋯ menu. */
  more: PlanStepButton[];
  /** TalkBack summary of the row. */
  accessibilityLabel: string;
}

export interface PlanScreenModel {
  id: string;
  /** `PLAN · 4 STEPS` */
  label: string;
  /** `Due 14 Oct`, or null. */
  due: string | null;
  title: string;
  /** `2 of 4 done` (cancelled steps don't count). */
  progressText: string;
  /** 0–100. */
  progress: number;
  steps: PlanStepView[];
}

function withBack<P extends object>(params: P, back?: string): P & { back?: string } {
  return back ? { ...params, back } : params;
}

/** Links to the work carrying out a step, by the numbers the server resolved (`step.refs`). */
export function planStepLinks(step: PlanStep, back?: string, locale?: string): PlanStepLink[] {
  const { t } = mobileTranslator(locale);
  const links: PlanStepLink[] = [];
  const { runNumber, approvalNumber, automationRunNumber } = step.refs;
  if (runNumber)
    links.push({
      key: 'run',
      label: t('data.plan.link.run', { number: runNumber }),
      route: { name: 'Run', params: withBack({ number: runNumber }, back) },
    });
  if (approvalNumber)
    links.push({
      key: 'approval',
      label: t('data.plan.link.approval', { number: approvalNumber }),
      route: { name: 'Approval', params: withBack({ number: approvalNumber }, back) },
    });
  if (automationRunNumber)
    links.push({
      key: 'automation_run',
      label: t('data.plan.link.automationRun', { number: automationRunNumber }),
      route: { name: 'AutomationRun', params: withBack({ number: automationRunNumber }, back) },
    });
  return links;
}

/**
 * Where “Open work” goes. A gate step opens its approval first (that is what needs the person); otherwise the run,
 * then the automation run, then the approval. A step the agent was asked to do that hasn't started a run yet (a
 * dispatch only) opens the plan's conversation, where the asking message is.
 */
export function openWorkRoute(step: PlanStep, conversationId: string, back?: string): Route | null {
  const links = planStepLinks(step, back);
  const by = (key: PlanStepLink['key']) => links.find((l) => l.key === key)?.route ?? null;
  const first =
    step.state === 'gate'
      ? (by('approval') ?? by('run') ?? by('automation_run'))
      : (by('run') ?? by('automation_run') ?? by('approval'));
  if (first) return first;
  return step.dispatchId || step.runId || step.approvalId || step.automationRunId
    ? { name: 'Conversation', params: { conversationId } }
    : null;
}

/** A step action as its button or menu line says it: Retry on a step waiting only for the person's word goes ahead. */
function planActionLabel(action: MobilePlanAction, step: PlanStep, locale?: string): string {
  return action === 'retry' && stepGoesAhead(step)
    ? mobileTranslator(locale).t('data.plan.action.goAhead')
    : planActionLabels(locale)[action];
}

/**
 * The buttons of a step: only where the person is needed, and the way to its work (core `planStepControls`); the
 * first is primary, the rest secondary.
 */
export function planStepButtons(step: PlanStep, canOpenWork: boolean, locale?: string): PlanStepButton[] {
  const actions = planStepControls(step).buttons.filter((a) => a !== 'open_work' || canOpenWork);
  const first = actions[0];
  return actions.map((action) => ({
    action,
    label: planActionLabel(action, step, locale),
    variant: action === first ? 'primary' : 'secondary',
  }));
}

/** The step's ⋯ menu: what it allows besides its buttons (Start, Mark done, Cancel). */
export function planStepMore(step: PlanStep, locale?: string): PlanStepButton[] {
  return planStepControls(step).more.map((action) => ({
    action,
    label:
      action === 'cancel'
        ? mobileTranslator(locale).t('data.plan.action.cancelStep')
        : planActionLabel(action, step, locale),
    variant: action === 'cancel' ? 'quiet' : 'secondary',
  }));
}

export function planStepView(
  step: PlanStep,
  plan: Pick<Plan, 'conversationId'>,
  back?: string,
  locale?: string,
): PlanStepView {
  const openWork = openWorkRoute(step, plan.conversationId, back);
  const links = planStepLinks(step, back, locale);
  const note = step.note?.trim() || null;
  return {
    id: step.id,
    title: step.title,
    titleStyle: step.state === 'cancelled' ? 'struck' : step.state === 'done' ? 'muted' : 'normal',
    marker: step.state,
    markerLabel: planMarkerLabels(locale)[step.state],
    stateLabel: step.stateLabel,
    stateTone: PLAN_STATE_TONES[step.state],
    note,
    links,
    openWork,
    // The link rows already open the run / approval / automation run: “Open work” only when there are none (a
    // turn that hasn't started a run opens the plan's conversation).
    buttons: planStepButtons(step, openWork !== null && links.length === 0, locale),
    more: planStepMore(step, locale),
    accessibilityLabel: [`${step.title}. ${step.stateLabel}`, note].filter(Boolean).join('. '),
  };
}

export function planScreen(plan: Plan, back?: string, locale?: string): PlanScreenModel {
  const { done, total } = planProgress(plan);
  return {
    id: plan.id,
    label: formatPlanLabel(plan.steps.length, locale),
    due: plan.due ? formatDue(plan.due, locale) : null,
    title: plan.title,
    progressText: mobileTranslator(locale).t('data.messages.doneOf', { done, total }),
    progress: total > 0 ? Math.round((done / total) * 100) : 0,
    steps: plan.steps.map((s) => planStepView(s, plan, back, locale)),
  };
}

/** What a step action does: a plan write, or opening the linked work. */
export type PlanStepCommand =
  | { kind: 'start' }
  | { kind: 'update'; state: 'done' | 'cancelled' }
  | { kind: 'open'; route: Route };

export function planStepCommand(
  action: MobilePlanAction,
  view: Pick<PlanStepView, 'openWork'>,
): PlanStepCommand | null {
  switch (action) {
    case 'start':
    case 'retry':
      return { kind: 'start' };
    case 'mark_done':
      return { kind: 'update', state: 'done' };
    case 'cancel':
      return { kind: 'update', state: 'cancelled' };
    case 'open_work':
      return view.openWork ? { kind: 'open', route: view.openWork } : null;
  }
}
