/**
 * Plan display rules shared by the plan card, the plan pane and the Inbox's NEEDS YOU (work-supervision WS-02, WS-09).
 * Pure: markers, the words screen readers get, the links a step carries, which actions it offers and the text of a
 * refusal.
 */
import { ApiError, problemText } from '@whombat/client';
import {
  type LinkRef,
  type Plan,
  type PlanStep,
  type PlanStepAction,
  type PlanStepState,
  planProgress,
  planStepActions,
  planStepControls,
  planStepRemovable,
  stepGoesAhead,
} from '@whombat/core';

/** Screen-reader words for the markers (the state label next to each row says the rest). */
export const MARKER_LABEL: Record<PlanStepState, string> = {
  done: 'Done',
  active: 'In progress',
  queued: 'Queued',
  gate: 'Needs a person',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

/** Work a step links to, by number, for “Run #1907” / “Approval #12” / “Automation run #41” links. */
export interface StepLink {
  kind: 'run' | 'approval' | 'automation_run';
  label: string;
  link: LinkRef;
}

export function stepLinks(step: PlanStep): StepLink[] {
  const out: StepLink[] = [];
  const { runNumber, approvalNumber, automationRunNumber } = step.refs;
  if (runNumber)
    out.push({ kind: 'run', label: `Run #${runNumber}`, link: { type: 'run', number: runNumber } });
  if (approvalNumber)
    out.push({
      kind: 'approval',
      label: `Approval #${approvalNumber}`,
      link: { type: 'approval', number: approvalNumber },
    });
  if (automationRunNumber)
    out.push({
      kind: 'automation_run',
      label: `Automation run #${automationRunNumber}`,
      link: { type: 'automation_run', number: automationRunNumber },
    });
  return out;
}

/**
 * The plan card's line under a step (WS-09): blocked steps always say why and link their work; a step that needs a
 * person when it has a note, except one waiting on an approval: that is the mock's gate step (“Deploy to staging ·
 * Needs you”, its approval card right below), which keeps its single row (AP-85). The pane shows every note.
 */
export function cardStepDetail(step: PlanStep): { note: string | null; links: StepLink[] } | null {
  if (step.state === 'blocked') {
    const links = stepLinks(step);
    return step.note || links.length ? { note: step.note, links } : null;
  }
  if (step.state === 'gate' && step.note && !step.approvalId)
    return { note: step.note, links: stepLinks(step) };
  return null;
}

/** `PLAN · N STEPS` counts what progress counts: cancelled steps are kept but not counted (WS-02). */
export function countedSteps(plan: Pick<Plan, 'steps'>): number {
  return planProgress(plan).total;
}

/** “2 of 4 done”. */
export function progressText(plan: Pick<Plan, 'steps'>): string {
  const { done, total } = planProgress(plan);
  return total === 0 ? 'No steps yet' : `${done} of ${total} done`;
}

export const ACTION_LABEL: Record<PlanStepAction, string> = {
  start: 'Start',
  mark_done: 'Mark done',
  retry: 'Retry',
  cancel: 'Cancel step',
  open_work: 'Open work',
};

/** A step's action as its button says it: Retry reads “Go ahead” on a step that waits only for the person's word. */
export function stepActionLabel(action: PlanStepAction, step: PlanStep): string {
  return action === 'retry' && stepGoesAhead(step) ? GO_AHEAD : ACTION_LABEL[action];
}

export const GO_AHEAD = 'Go ahead';

/**
 * The actions a step offers in the pane, before permissions (core `planStepActions`), plus Remove for a step that
 * never started (`planStepRemovable`; otherwise Cancel is the way to drop it, WS-07).
 */
export function paneStepActions(step: PlanStep): {
  actions: PlanStepAction[];
  buttons: PlanStepAction[];
  more: PlanStepAction[];
  removable: boolean;
} {
  // Buttons only where the person is needed; Start, Mark done and Cancel otherwise in the step's menu.
  const { buttons, more } = planStepControls(step);
  return { actions: planStepActions(step), buttons, more, removable: planStepRemovable(step) };
}

/** The work “Open work” opens: the step's run, else its approval, else its automation run. */
export function openWorkLink(step: PlanStep): StepLink | null {
  return stepLinks(step)[0] ?? null;
}

/** A refusal as one sentence (409 `step_started`, a missing key, the server's own message). */
export function planErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details as { reason?: string } | undefined;
    if (error.code === 'conflict' && details?.reason === 'step_started')
      return 'This step has started, so it can’t be removed. Cancel it instead.';
    if (error.status === 404) return 'This plan isn’t here any more, or it’s in a room you’re not in.';
    if (error.code === 'forbidden') return 'You can’t change this plan.';
    return problemText(error, 'That didn’t go through. Try again.');
  }
  return 'Couldn’t reach your Whombat. Try again.';
}

/** A plan's title from the message it's made from: its first line, without markup, at most 160 characters. */
export function planTitleFrom(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/[*_`#>]+/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .find(Boolean) ?? '';
  if (line.length <= 160) return line;
  const cut = line.slice(0, 159);
  const space = cut.lastIndexOf(' ');
  return `${(space > 80 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
