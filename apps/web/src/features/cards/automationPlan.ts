/**
 * The words of an automation plan's card (Whombat docs/decisions/automation-chat.md; app automation-chat.md): its
 * status label, its buttons, the marks of what changes, Try it's label and the line it settles into. Pure, so the card
 * and its tests say the same. The sections themselves come written from the server (core `automationPlanView`).
 */
import type { SettledLine } from '@whombat/client';
import {
  AUTOMATION_PLAN_STATE_LABELS,
  type AutomationPlanChange,
  type AutomationPlanSection,
  type AutomationPlanState,
  type AutomationPlanView,
  daysAgo,
  formatClock,
  formatDate,
  formatShortWeekday,
} from '@whombat/core';
import type { AutomationSample } from '@whombat/core/contracts';
import { currentLocale } from '../../i18n/provider';

export interface PlanCardWords {
  /** `NEW AUTOMATION · WAITING FOR YOU`, `CHANGE · TURNED ON`. */
  status: string;
  tone: 'warn' | 'ok' | 'neutral';
  /** Turn it on, or Use this version for a change. */
  accept: string;
  /** Not now, or Keep the old one for a change. */
  decline: string;
  hint: string;
  thinking: string;
  /** A change's fold with the whole automation as it would run. */
  whole: string;
  /** “What Dusty is asked”. */
  prompts: string;
  changes: string;
}

const STATE_TONE: Record<AutomationPlanState, PlanCardWords['tone']> = {
  waiting: 'warn',
  accepted: 'ok',
  declined: 'neutral',
  replaced: 'neutral',
  gone: 'neutral',
};

export function planCardWords(
  plan: Pick<AutomationPlanView, 'state' | 'change'>,
  agentName: string,
): PlanCardWords {
  const kind = plan.change ? 'CHANGE' : 'NEW AUTOMATION';
  return {
    status: `${kind} · ${AUTOMATION_PLAN_STATE_LABELS[plan.state].toUpperCase()}`,
    tone: STATE_TONE[plan.state],
    accept: plan.change ? 'Use this version' : 'Turn it on',
    decline: plan.change ? 'Keep the old one' : 'Not now',
    hint: 'or reply to change it',
    thinking: 'How I thought about it',
    whole: 'The whole automation',
    prompts: `What ${agentName} is asked`,
    changes: 'WHAT CHANGES',
  };
}

/**
 * The rows a card shows open: all of them for a new automation; for a change, after WHAT CHANGES, only what still asks
 * the person first and its limits (the rest is in the fold with the whole automation).
 */
export function cardSections<S extends { id: AutomationPlanSection['id'] }>(plan: {
  change: boolean;
  sections: readonly S[];
}): readonly S[] {
  return plan.change ? plan.sections.filter((s) => s.id === 'asks' || s.id === 'limits') : plan.sections;
}

/** The mark before a line of WHAT CHANGES (a minus sign, not a hyphen), and what a screen reader hears instead. */
export const CHANGE_MARKS: Record<AutomationPlanChange['change'], { mark: string; said: string }> = {
  added: { mark: '+', said: 'Adds:' },
  removed: { mark: '−', said: 'Drops:' },
  changed: { mark: '~', said: 'Changes:' },
};

/** When something was decided: the clock today, “Mon 14:02” this week, else the date. */
export function planWhen(at: string, now: Date | number, timeZone: string): string {
  const days = daysAgo(at, now, timeZone);
  const clock = formatClock(at, timeZone);
  if (days <= 0) return clock;
  if (days < 7) return `${formatShortWeekday(at, timeZone, currentLocale())} ${clock}`;
  return formatDate(at, timeZone, { now }, currentLocale());
}

/**
 * The line a decided plan settles into: “You turned on “Name” · Mon 14:02”, “Not now: “Name””, “Replaced by a newer
 * plan”, ““Name” was deleted”. `decider` is who decided, null for the viewer.
 */
export function planSettledLine(
  plan: Pick<AutomationPlanView, 'state' | 'change' | 'name' | 'decidedAt'>,
  options: { decider: string | null; timeZone: string; now: Date | number },
): SettledLine {
  const name = `“${plan.name}”`;
  switch (plan.state) {
    case 'accepted': {
      const who = options.decider ?? 'You';
      return {
        lead: plan.change ? `${who} turned on this change to ${name}` : `${who} turned on ${name}`,
        detail: plan.decidedAt ? planWhen(plan.decidedAt, options.now, options.timeZone) : null,
        tone: 'ok',
      };
    }
    case 'declined':
      return { lead: `Not now: ${name}`, detail: null, tone: 'mut' };
    case 'replaced':
      return { lead: AUTOMATION_PLAN_STATE_LABELS.replaced, detail: plan.name, tone: 'mut' };
    case 'gone':
      return { lead: `${name} was deleted`, detail: null, tone: 'mut' };
    case 'waiting':
      return { lead: AUTOMATION_PLAN_STATE_LABELS.waiting, detail: plan.name, tone: 'warn' };
  }
}

/** The newest issue, pull request or report to try a plan on, or null when there is none. */
export function newestSample(samples: readonly AutomationSample[] | undefined): AutomationSample | null {
  let newest: AutomationSample | null = null;
  for (const s of samples ?? []) if (!newest || s.openedAt > newest.openedAt) newest = s;
  return newest;
}

/** What a test run on a sample sends (`automations.runNow`'s `sample`). */
export function sampleBody(sample: AutomationSample): { number: number } | { reportId: string } {
  return sample.kind === 'report' ? { reportId: sample.reportId } : { number: sample.number };
}

/**
 * Try it's label: “Try it now” for a plan that runs at once, “Try it on #12” on the newest sample; null (no button)
 * while the samples aren't known or there is none.
 */
export function tryItLabel(
  tryIt: AutomationPlanView['tryIt'],
  sample: AutomationSample | null,
): string | null {
  if (tryIt === 'now') return 'Try it now';
  return sample ? `Try it on #${sample.number}` : null;
}

/** What the toasts say. */
export const PLAN_TOASTS = {
  accepted: (name: string) => `“${name}” is on.`,
  declined: 'Set aside. Nothing was turned on.',
  kept: 'The old version keeps running.',
  tried: 'Test run started.',
  open: 'Open',
  failed: 'Couldn’t reach Whombat. Nothing changed, try again.',
  needsYes: 'That needs a person to approve first.',
} as const;
