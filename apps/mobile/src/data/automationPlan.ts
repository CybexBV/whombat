/**
 * A plan for an automation in Chat on the phone (Whombat docs/decisions/automation-chat.md; the phone's side is
 * docs/app/decisions/automation-chat-mobile.md): what the card shows while it waits for the person — the state, the name
 * and the agent's sentence, for a change what changes, Whombat's rows (what starts it, what the agent does, what asks
 * first, where it posts, its limits), the agent's “How I thought about it” and, folded, what the agent is asked word
 * for word — and the one line it folds into once decided. The rows are core's (`planSections`, written from the
 * definition by the runtime), so the phone only draws them. Pure.
 */

import type { SettledLine } from '@whombat/client';
import {
  type AutomationPlanCard,
  type AutomationPlanChange,
  type AutomationPlanState,
  type AutomationPlanView,
  type AutomationReportSample,
  type AutomationSample,
  automationPlanStateLabels,
  formatClock,
  formatRecent,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export function automationPlanText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    newKicker: t('automationPlan.automationPlanText.newKicker'),
    changeKicker: t('automationPlan.automationPlanText.changeKicker'),
    whatChanges: t('automationPlan.automationPlanText.whatChanges'),
    thinking: t('automationPlan.automationPlanText.thinking'),
    asked: (agent: string) => t('automationPlan.automationPlanText.asked', { agent }),
    accept: {
      new: t('automationPlan.automationPlanText.accept.new'),
      change: t('automationPlan.automationPlanText.accept.change'),
    },
    decline: {
      new: t('automationPlan.automationPlanText.decline.new'),
      change: t('automationPlan.automationPlanText.decline.change'),
    },
    tryIt: t('automationPlan.automationPlanText.tryIt'),
    tryOn: (n: number) => t('automationPlan.automationPlanText.tryOn', { n }),
    tryNow: t('automationPlan.automationPlanText.tryNow'),
    replyHint: t('automationPlan.automationPlanText.replyHint'),
    acceptHint: {
      new: (name: string) => t('automationPlan.automationPlanText.acceptHint.new', { name }),
      change: (name: string) => t('automationPlan.automationPlanText.acceptHint.change', { name }),
    },
    tryHint: t('automationPlan.automationPlanText.tryHint'),
    declineHint: {
      new: t('automationPlan.automationPlanText.declineHint.new'),
      change: t('automationPlan.automationPlanText.declineHint.change'),
    },
    /** The toasts once a decision went through (the card folds into its line by itself). */
    turnedOn: {
      new: (name: string) => t('automationPlan.automationPlanText.turnedOn.new', { name }),
      change: (name: string) => t('automationPlan.automationPlanText.turnedOn.change', { name }),
    },
    setAside: {
      new: (name: string) => t('automationPlan.automationPlanText.setAside.new', { name }),
      change: (name: string) => t('automationPlan.automationPlanText.setAside.change', { name }),
    },
    trying: (name: string, sample: number | null) =>
      sample === null
        ? t('data.automationPlan.tryingNow', { name })
        : t('data.automationPlan.tryingOn', { name, sample }),
    /** Settled lines. */
    turnedOnBy: (who: string, name: string) =>
      t('automationPlan.automationPlanText.turnedOnBy', { who, name }),
    notNow: (name: string) => t('automationPlan.automationPlanText.notNow', { name }),
    replaced: t('automationPlan.automationPlanText.replaced'),
    deleted: (name: string) => t('automationPlan.automationPlanText.deleted', { name }),
    /** TalkBack's word for each sign of WHAT CHANGES. */
    changeWords: {
      added: t('automationPlan.automationPlanText.changeWords.added'),
      removed: t('automationPlan.automationPlanText.changeWords.removed'),
      changed: t('automationPlan.automationPlanText.changeWords.changed'),
    },
  } as const;
}
export const AUTOMATION_PLAN_TEXT = automationPlanText();

/** `+` added, `−` (U+2212) removed, `~` changed, as a diff reads. */
const CHANGE_SIGNS: Record<AutomationPlanChange['change'], '+' | '−' | '~'> = {
  added: '+',
  removed: '−',
  changed: '~',
};

/** The sign's colour: an addition `ok`, a removal `bad` (the diff stats' colours), a reworded step quiet. */
export type PlanChangeTone = 'ok' | 'bad' | 'mut';
const CHANGE_TONES: Record<AutomationPlanChange['change'], PlanChangeTone> = {
  added: 'ok',
  removed: 'bad',
  changed: 'mut',
};

/** The state line's colour: waiting for you in `warn`, on in `ok`, the rest quiet. */
export type PlanStateTone = 'warn' | 'ok' | 'mut';

export interface PlanChangeRow {
  key: string;
  sign: '+' | '−' | '~';
  tone: PlanChangeTone;
  text: string;
  accessibilityLabel: string;
}

export interface PlanSectionRow {
  key: string;
  /** “WHEN”, “DUSTY”, “ASKS YOU”, “POSTS”, “LIMIT”. */
  label: string;
  lines: { key: string; text: string; detail: string | null }[];
  accessibilityLabel: string;
}

export interface PlanCardView {
  planId: AutomationPlanView['planId'];
  automationId: AutomationPlanView['automationId'];
  name: string;
  description: string;
  change: boolean;
  state: AutomationPlanState;
  /** Still waiting for the person: the buttons show. */
  waiting: boolean;
  /** “NEW AUTOMATION · WAITING FOR YOU”, “CHANGE · TURNED ON”. */
  status: string;
  tone: PlanStateTone;
  /** WHAT CHANGES, for a change; empty for a new automation. */
  changes: PlanChangeRow[];
  sections: PlanSectionRow[];
  thinking: string[];
  /** “What Dusty is asked”, folded; empty when no step asks the agent anything. */
  asked: { title: string; prompts: { key: string; step: string; text: string }[] };
  tryIt: AutomationPlanView['tryIt'];
  accept: string;
  decline: string;
  /** What TalkBack reads for the card's head: the state, the name and the sentence. */
  accessibilityLabel: string;
}

/** A sentence keeps its own stop; anything else gets one. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The card's view of a plan; `agent` is the agent's name, for “What Dusty is asked”. */
export function planCardView(plan: AutomationPlanView, agent: string, locale?: string): PlanCardView {
  const AUTOMATION_PLAN_TEXT = automationPlanText(locale);
  const kind = plan.change ? 'change' : 'new';
  const kicker = plan.change ? AUTOMATION_PLAN_TEXT.changeKicker : AUTOMATION_PLAN_TEXT.newKicker;
  const status = `${kicker} · ${automationPlanStateLabels(locale)[plan.state].toUpperCase()}`;
  const tone: PlanStateTone = plan.state === 'waiting' ? 'warn' : plan.state === 'accepted' ? 'ok' : 'mut';
  return {
    planId: plan.planId,
    automationId: plan.automationId,
    name: plan.name,
    description: plan.description,
    change: plan.change,
    state: plan.state,
    waiting: plan.state === 'waiting',
    status,
    tone,
    changes: plan.change
      ? plan.changes.map((c, i) => ({
          key: `${c.change}-${i}`,
          sign: CHANGE_SIGNS[c.change],
          tone: CHANGE_TONES[c.change],
          text: c.text,
          accessibilityLabel: `${AUTOMATION_PLAN_TEXT.changeWords[c.change]}: ${c.text}`,
        }))
      : [],
    sections: plan.sections.map((s) => ({
      key: s.id,
      label: s.label,
      lines: s.lines.map((l, i) => ({ key: `${s.id}-${i}`, text: l.text, detail: l.detail })),
      accessibilityLabel: `${s.label}: ${s.lines.map((l) => (l.detail ? `${l.text}, ${l.detail}` : l.text)).join('; ')}`,
    })),
    thinking: [...plan.thinking],
    asked: {
      title: AUTOMATION_PLAN_TEXT.asked(agent),
      prompts: plan.prompts.map((p, i) => ({ key: `prompt-${i}`, step: p.step, text: p.text })),
    },
    tryIt: plan.tryIt,
    accept: AUTOMATION_PLAN_TEXT.accept[kind],
    decline: AUTOMATION_PLAN_TEXT.decline[kind],
    accessibilityLabel: [status, plan.name, plan.description].filter(Boolean).map(sentence).join(' '),
  };
}

/** A plan card is the card while it waits (or isn't resolved yet), one line once it is decided. */
export function planDisplay(card: Pick<AutomationPlanCard, 'plan'>): 'full' | 'line' {
  return card.plan && card.plan.state !== 'waiting' ? 'line' : 'full';
}

/** “14:02” today, “Mon 14:02” this week, “24 Sep 14:02” before; “just now” under a minute. */
function decidedWhen(at: string, now: Date, timeZone: string, locale?: string): string {
  const recent = formatRecent(at, now, timeZone, locale);
  const clock = formatClock(at, timeZone);
  // “just now” in the locale: what `formatRecent` says of this very moment.
  const justNow = formatRecent(now, now, timeZone, locale);
  return recent === clock || recent === justNow ? recent : `${recent} ${clock}`;
}

/**
 * The line a decided plan folds into: “You turned on “Name” · Mon 14:02”, “Not now: “Name””, “Replaced by a newer
 * plan”, ““Name” was deleted”. Null while it waits.
 */
export function planSettledLine(
  plan: Pick<AutomationPlanView, 'state' | 'name' | 'decidedById' | 'decidedAt'>,
  ctx: { viewerId: string; name: (id: string) => string; now: Date; timeZone: string; locale?: string },
): SettledLine | null {
  const AUTOMATION_PLAN_TEXT = automationPlanText(ctx.locale);
  switch (plan.state) {
    case 'waiting':
      return null;
    case 'accepted': {
      const who =
        !plan.decidedById || plan.decidedById === ctx.viewerId
          ? mobileTranslator(ctx.locale).t('data.messages.you')
          : ctx.name(plan.decidedById);
      return {
        lead: AUTOMATION_PLAN_TEXT.turnedOnBy(who, plan.name),
        detail: plan.decidedAt ? decidedWhen(plan.decidedAt, ctx.now, ctx.timeZone, ctx.locale) : null,
        tone: 'ok',
      };
    }
    case 'declined':
      return { lead: AUTOMATION_PLAN_TEXT.notNow(plan.name), detail: null, tone: 'mut' };
    case 'replaced':
      return { lead: AUTOMATION_PLAN_TEXT.replaced, detail: null, tone: 'mut' };
    case 'gone':
      return { lead: AUTOMATION_PLAN_TEXT.deleted(plan.name), detail: null, tone: 'mut' };
  }
}

/* Try it ------------------------------------------------------------------------------------------------------- */

/** The newest issue, pull request or report to try it on (`automations.samples` is newest first); null for none. */
export function newestSample(samples: readonly AutomationSample[] | undefined): AutomationSample | null {
  return samples?.[0] ?? null;
}

/**
 * Try's words: “Try it now” for a plan that starts once now; on the newest issue, pull request or report, “Try it on
 * #12”, or “Try it now” when there is none to try it on; “Try it” while the list loads.
 */
export function tryItLabel(
  tryIt: AutomationPlanView['tryIt'],
  samples: readonly AutomationSample[] | undefined,
  locale?: string,
): string {
  const AUTOMATION_PLAN_TEXT = automationPlanText(locale);
  if (tryIt === 'now') return AUTOMATION_PLAN_TEXT.tryNow;
  if (!samples) return AUTOMATION_PLAN_TEXT.tryIt;
  const sample = newestSample(samples);
  return sample ? AUTOMATION_PLAN_TEXT.tryOn(sample.number) : AUTOMATION_PLAN_TEXT.tryNow;
}

/** What a run by hand sends: a test run as if the sample had just arrived, or once as it is. */
export function runNowBody(
  test: boolean,
  sample: AutomationSample | null,
): { test: boolean; sample?: { number: number } | { reportId: AutomationReportSample['reportId'] } } {
  if (!test || !sample) return { test };
  return {
    test,
    sample: sample.kind === 'report' ? { reportId: sample.reportId } : { number: sample.number },
  };
}
