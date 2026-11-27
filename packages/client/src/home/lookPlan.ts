/**
 * The assistant's plan for a thing (Whombat handle-it.md; contracts 3.11 `LookResearch.plan`, the `look_plan` card): what
 * it will do on everything that needs a look there, with the defaults it chose, one *Go ahead* for all of it and
 * *Change something*, which opens the thread to reply. While it takes the steps the card says it is on it; once done,
 * what it did in its words, green. The thread's card and a page's LookCard draw the same view. Pure; web and phone
 * share it.
 */
import {
  carePlanWords,
  deskWords,
  fillDeskWords,
  type LookPlanState,
  type LookPlanView,
  type LookResearch,
} from '@whombat/core';
import type { SettledLine } from '../cardDisplay';
import { clientTranslator } from '../i18n/catalog';

/** The plan card's words, in a locale (English when none). */
export function lookPlanWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  const care = carePlanWords(locale);
  return {
    head: tr.raw('lookPlan.head'),
    headDone: tr.raw('lookPlan.headDone'),
    /** A server's care plan: how the assistant will look after it, then how it does. */
    headCare: care.head,
    headCareDone: care.headDone,
    goAhead: tr.raw('lookPlan.goAhead'),
    change: tr.raw('lookPlan.change'),
    doing: deskWords(locale).looks.fixing,
    gone: tr.raw('lookPlan.gone'),
    /** The line under Worth a look while the assistant looks into what the person handed it. */
    looking: tr.raw('lookPlan.looking'),
    /** …while it takes the steps the person said go ahead to. */
    onIt: tr.raw('lookPlan.onIt'),
    /** A Whombat that couldn't start it, and isn't an older one (that asks in the Ask pane instead). */
    failed: tr.raw('lookPlan.failed'),
  };
}

export const LOOK_PLAN_WORDS = lookPlanWords();

export interface LookPlanCardView {
  state: LookPlanState;
  /** “Here’s what I’ll do on pve-01:”; once done, “Here’s what I did on pve-01:”. */
  head: string;
  steps: string[];
  /** The assistant's title, what it found (waiting) or what works again (done). */
  title: string | null;
  /**
   * The line beside the assistant's face: its summary while the plan waits and once done, “I’m on it.” while it takes
   * the steps, “No longer needed.” once the problem went first.
   */
  text: string | null;
  /** A spinner: it is taking the steps. */
  busy: boolean;
  /** Green, the steps ticked. */
  done: boolean;
  /** “Go ahead”: the person's yes for exactly these steps; only while it waits. */
  goAhead: string | null;
  /** “Change something”: opens the thread to reply; only while it waits. */
  change: string | null;
}

const fill = (text: string, name: string) => fillDeskWords(text, { name });

function viewOf(
  state: LookPlanState,
  name: string,
  steps: readonly string[],
  title: string | null,
  summary: string | null,
  care = false,
  locale?: string | null,
): LookPlanCardView {
  const W = lookPlanWords(locale);
  const waiting = state === 'waiting';
  const head = care
    ? state === 'done'
      ? W.headCareDone
      : W.headCare
    : state === 'done'
      ? W.headDone
      : W.head;
  return {
    state,
    head: fill(head, name),
    steps: [...steps],
    title: state === 'gone' ? null : title,
    text: state === 'doing' ? W.doing : state === 'gone' ? W.gone : summary,
    busy: state === 'doing',
    done: state === 'done',
    goAhead: waiting ? W.goAhead : null,
    change: waiting ? W.change : null,
  };
}

/** The `look_plan` card as it shows; null when its research is gone (history pruned): nothing to draw. */
export function lookPlanCardView(
  plan: LookPlanView | null | undefined,
  locale?: string | null,
): LookPlanCardView | null {
  if (!plan) return null;
  // Go ahead needs the live research (its key is what is sent): without it the card can only say it went.
  const state = plan.state === 'waiting' && !plan.research ? 'gone' : plan.state;
  return viewOf(state, plan.name, plan.steps, plan.title, plan.summary, plan.care === true, locale);
}

/**
 * A page's research as a plan (its LookCard; Home's Needs you): waiting while found, doing while it takes the steps,
 * done once fixed; null without a plan (the one step, or none: the LookCard draws as before).
 */
export function researchPlanView(
  research: LookResearch | null | undefined,
  name: string,
  locale?: string | null,
): LookPlanCardView | null {
  if (!research?.plan?.length) return null;
  const state: LookPlanState | null =
    research.state === 'found'
      ? 'waiting'
      : research.state === 'fixing'
        ? 'doing'
        : research.state === 'fixed'
          ? 'done'
          : null;
  if (!state) return null;
  return viewOf(state, name, research.plan, research.title ?? null, research.summary ?? null, false, locale);
}

/** The research the moment the person hands the thing to the assistant: it looks, nothing found yet. */
export function handingResearch(key: string, now: number): LookResearch {
  return { key, state: 'looking', at: new Date(now).toISOString() };
}

/** A thread card's settled line: a plan that is no longer needed. */
export function lookPlanLine(plan: LookPlanView | null | undefined, locale?: string | null): SettledLine {
  return {
    lead: lookPlanWords(locale).gone.replace(/\.$/, ''),
    detail: plan ? plan.name : null,
    tone: 'mut',
  };
}
