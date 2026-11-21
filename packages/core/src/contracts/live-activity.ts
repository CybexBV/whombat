/**
 * Live activities (TODO 9.4): what a run in progress or an approval that needs a person looks like outside
 * the app — an ongoing Live Update notification on Android, an ActivityKit activity on iOS — and when it
 * starts and ends. One set of builders for every path, so the server's data pushes and the app's own
 * realtime updates show the same copy:
 *
 * - the server turns `run.updated` / `approval.updated` into `LiveActivityPush` data pushes;
 * - the app turns the same realtime events (while it runs) into the same `LiveActivityDisplay`;
 * - the native module only renders a `LiveActivityDisplay`, it builds no copy of its own.
 *
 * Pure.
 */
import { approvalPhase, approvalView } from '../approvals/display.js';
import type { Approval } from '../domain/approval.js';
import type { Tone } from '../domain/common.js';
import { linkPath } from '../domain/links.js';
import {
  type LiveActivity,
  type LiveActivityDisplay,
  type LiveActivityEventType,
  liveActivityRef,
} from '../domain/notification.js';
import type { Run } from '../domain/run.js';
import { formatRunLabel } from '../text/copy.js';
import { formatTestsPassing } from '../text/format.js';
import type { PushPayload } from './notifications.js';

/** A live activity's contract object, what it shows, and whether it is over. */
export interface LiveActivityState {
  activity: LiveActivity;
  display: LiveActivityDisplay;
  /** Done, failed or taken over (runs); executed, failed or declined (approvals). */
  ended: boolean;
}

/**
 * iOS: the ActivityKit attributes type (`attributes-type` of a push-to-start push). One type for runs and
 * approvals, so a device has a single push-to-start token (`Device.liveActivityToken`).
 */
export const IOS_LIVE_ACTIVITY_ATTRIBUTES = 'WhombatLiveAttributes';

/** Static attributes of an iOS activity (set when it starts; the display is its content state). */
export interface LiveActivityAttributes {
  key: string;
  kind: LiveActivity['kind'];
  number: number;
  /** Burrow slug. */
  burrow: string;
}

const clampPercent = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** A run is over for its live activity once the agent has stopped: done, failed or taken over. */
export function isRunActivityEnded(run: Pick<Run, 'status'>): boolean {
  return run.status === 'done' || run.status === 'failed' || run.status === 'taken_over';
}

function runStepText(status: Run['status'], currentStep: string | null): string {
  switch (status) {
    case 'live':
      return currentStep ? `Now: ${currentStep}` : 'Working';
    case 'paused':
      return currentStep ? `Paused: ${currentStep}` : 'Paused';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Stopped after an error';
    case 'taken_over':
      return 'Taken over';
  }
}

function runTone(status: Run['status']): Tone {
  switch (status) {
    case 'live':
    case 'done':
      return 'ok';
    case 'paused':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'taken_over':
      return 'neutral';
  }
}

/** A run's live activity: agent, title, progress, current step and tests. */
export function runLiveActivity(run: Run, agentName: string): LiveActivityState {
  const currentStep = run.steps.find((s) => s.state === 'active')?.title ?? null;
  const activity: LiveActivity = {
    kind: 'run',
    runId: run.id,
    number: run.number,
    burrowId: run.burrowId,
    agentId: run.agentId,
    agentName,
    title: run.title,
    branch: run.branch,
    progress: run.progress,
    currentStep,
    testsPassed: run.tests?.passed ?? null,
    testsTotal: run.tests?.total ?? null,
    state: run.status,
  };
  const ended = isRunActivityEnded(run);
  const progress = run.status === 'done' ? 100 : clampPercent(run.progress);
  const text = [agentName, runStepText(run.status, currentStep), run.tests && formatTestsPassing(run.tests)]
    .filter(Boolean)
    .join(' · ');
  return {
    activity,
    ended,
    display: {
      key: liveActivityRef(activity),
      kind: 'run',
      number: run.number,
      label: formatRunLabel(run.status),
      tone: runTone(run.status),
      title: run.title,
      text,
      progress,
      segments: 1,
      chip: ended ? null : `${progress}%`,
      ongoing: !ended,
      actions: ['open_run'],
    },
  };
}

/** An approval is over for its live activity once the action ran (or failed) or a person declined. */
export function isApprovalActivityEnded(approval: Approval): boolean {
  const phase = approvalPhase(approval);
  return phase === 'executed' || phase === 'failed' || phase === 'declined';
}

/** An approval's live activity: question, conditions met and state (`NEEDS A PERSON` … `DEPLOYED`). */
export function approvalLiveActivity(approval: Approval, requesterName: string): LiveActivityState {
  const conditionsMet = approval.conditions.filter((c) => c.met).length;
  const conditionsTotal = approval.conditions.length;
  const activity: LiveActivity = {
    kind: 'approval',
    approvalId: approval.id,
    number: approval.number,
    burrowId: approval.burrowId,
    requesterId: approval.requesterId,
    question: approval.question,
    conditionsMet,
    conditionsTotal,
    state: approval.state,
  };
  // The label and tone do not depend on names or time: the viewer-independent part of the card's copy.
  const view = approvalView(approval, { names: () => undefined, now: approval.createdAt, timeZone: 'UTC' });
  const ended = isApprovalActivityEnded(approval);
  const segments = Math.max(1, Math.min(12, conditionsTotal));
  return {
    activity,
    ended,
    display: {
      key: liveActivityRef(activity),
      kind: 'approval',
      number: approval.number,
      label: view.label,
      tone: view.tone === 'neutral' ? 'warn' : view.tone,
      title: approval.question,
      text:
        conditionsTotal > 0
          ? `${requesterName} · ${conditionsMet} of ${conditionsTotal} conditions met`
          : requesterName,
      progress: conditionsTotal > 0 ? clampPercent((conditionsMet / conditionsTotal) * 100) : 0,
      segments,
      chip: ended || conditionsTotal === 0 ? null : `${conditionsMet}/${conditionsTotal}`,
      ongoing: !ended,
      actions: approval.state === 'pending' ? ['approve', 'details'] : ['details'],
    },
  };
}

/** The person_approves condition's approvers: who sees an approval's live activity. */
export function approvalLiveActivityAudience(approval: Approval): string[] {
  const cond = approval.conditions.find((c) => c.kind === 'person_approves');
  return cond && cond.kind === 'person_approves' ? [...cond.approverIds] : [];
}

/**
 * Who sees a run's live activity: the person who asked for it; when an agent asked (a review, a plan
 * step), the people in the run's conversation.
 */
export function runLiveActivityAudience(input: {
  askedById: string;
  askedByAgent: boolean;
  /** People (not agents) who are members of the run's conversation. */
  conversationPeople: readonly string[];
}): string[] {
  return input.askedByAgent ? [...new Set(input.conversationPeople)] : [input.askedById];
}

/** The data push for one live-activity event (FCM data message / APNs custom keys). */
export function liveActivityPush(
  state: Pick<LiveActivityState, 'activity' | 'display'>,
  event: LiveActivityEventType,
  burrowSlug: string,
): PushPayload {
  const { activity, display } = state;
  const liveActivity = { event, activity, display };
  if (activity.kind === 'run') {
    return {
      burrow: burrowSlug,
      notificationId: null,
      kind: 'run_progress',
      title: `${activity.agentName} · Run #${activity.number}`,
      body: activity.currentStep ?? activity.title,
      path: linkPath(burrowSlug, { type: 'run', number: activity.number }),
      run: {
        number: activity.number,
        progress: activity.progress,
        activity: activity.currentStep ?? activity.title,
        status: activity.state,
      },
      liveActivity,
    };
  }
  return {
    burrow: burrowSlug,
    notificationId: null,
    kind: 'approval_updated',
    title: `Approval #${activity.number}`,
    body: activity.question,
    path: linkPath(burrowSlug, { type: 'approval', number: activity.number }),
    approval: {
      number: activity.number,
      state: activity.state,
      label: `${activity.conditionsMet} of ${activity.conditionsTotal}`,
    },
    liveActivity,
  };
}

/** iOS: attributes of an activity started from a push-to-start push or in the app. */
export function liveActivityAttributes(activity: LiveActivity, burrowSlug: string): LiveActivityAttributes {
  return { key: liveActivityRef(activity), kind: activity.kind, number: activity.number, burrow: burrowSlug };
}
