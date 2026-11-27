/**
 * Needs you on Home (mock 1; one-whombat.md ONE-05, ONE-10; app one-whombat-shell.md AP-1266): what each button does
 * and how each item looks. A button is an intent the screen carries out — approve, approve later (“Tonight at 03:00”),
 * decline, snooze (“Remind me tomorrow”, “Not now”), open, or look into it (a new chat with the item's subject); and
 * Ignore on every item (`NEEDS_YOU_IGNORE`). An item the assistant looked into (Whombat look-research.md LR-09; app
 * look-research-web.md AP-5900…) carries its words, its step and Ask {assistant} instead. Pure; web and phone share it.
 */
import {
  type ChatSubject,
  type HomeRef,
  type NeedsYouAction,
  type NeedsYouItem,
  type OnePasswordRemovalAnswer,
  QUIET_WORDS,
  type WatchItem,
} from '@whombat/core';
import { type LookResearchView, lookResearchView, lookThreadHref } from './lookResearch';
import { needsYouWhen, tomorrowMorning } from './time';

export type NeedsYouIntent =
  | { type: 'approve'; number: number }
  | { type: 'approveLater'; number: number; executeAt: string }
  | { type: 'decline'; number: number }
  | { type: 'snooze'; ref: HomeRef; until: string }
  | { type: 'open'; href: string }
  | { type: 'investigate'; text: string; subject: ChatSubject | null }
  /** The 1Password guard's answer (`connections.onePasswordRemovals` on the connection the item is about). */
  | { type: 'onePasswordRemovals'; connectionId: string; answer: OnePasswordRemovalAnswer; token: string }
  /** A button this client can't carry out (an approval without its number, an `open` without a place). */
  | { type: 'none' };

/**
 * What pressing `action` on `item` does. Snoozing without a time waits until tomorrow 09:00 local; approving later
 * without a time is not offered (the server always says when).
 */
export function needsYouIntent(
  item: Pick<NeedsYouItem, 'ref' | 'title' | 'body' | 'subject' | 'approvalNumber'>,
  action: Pick<NeedsYouAction, 'kind' | 'at' | 'href' | 'text' | 'removals'>,
  now: Date | number,
  timeZone: string,
): NeedsYouIntent {
  const number = item.approvalNumber;
  switch (action.kind) {
    case 'approve':
      return number ? { type: 'approve', number } : { type: 'none' };
    case 'approve_later':
      return number && action.at ? { type: 'approveLater', number, executeAt: action.at } : { type: 'none' };
    case 'decline':
      return number ? { type: 'decline', number } : { type: 'none' };
    case 'snooze':
      return { type: 'snooze', ref: item.ref, until: action.at ?? tomorrowMorning(now, timeZone) };
    case 'open':
      return action.href ? { type: 'open', href: action.href } : { type: 'none' };
    case 'investigate':
      return { type: 'investigate', text: investigateText(item), subject: item.subject ?? null };
    case 'ask':
      // The person's yes to the assistant's proposal, in their words (first-day.md).
      return action.text ? { type: 'investigate', text: action.text, subject: null } : { type: 'none' };
    case 'onepassword_removals':
      return item.ref.kind === 'connection' && action.removals
        ? { type: 'onePasswordRemovals', connectionId: item.ref.id, ...action.removals }
        : { type: 'none' };
  }
}

/**
 * The first message of the chat “Look into it” starts: the item's title (it becomes the chat's title, ONE-06), then
 * the ask. “The disk array on blackbox has failed / Can you look into it?”
 */
export function investigateText(item: Pick<NeedsYouItem | WatchItem, 'title'>): string {
  return `${item.title}\nCan you look into it?`;
}

/** The glyph in an item's tile: by kind, and for approvals a power sign (restarts, updates, actions to run). */
export type NeedsYouGlyph =
  | 'alert'
  | 'power'
  | 'skill'
  | 'question'
  | 'connection'
  | 'server'
  | 'calendar'
  | 'mail';

export function needsYouGlyph(item: Pick<NeedsYouItem, 'kind' | 'ahead'>): NeedsYouGlyph {
  switch (item.kind) {
    case 'alert':
      return 'alert';
    case 'approval':
      return 'power';
    case 'device_skill':
      return 'skill';
    case 'question':
    case 'backup':
      return 'question';
    case 'connection':
      return 'connection';
    case 'enrollment':
    case 'hint':
      return 'server';
    case 'device':
      return 'connection';
    case 'automation_run':
      return 'alert';
    case 'ahead':
      return item.ahead?.source === 'calendar' ? 'calendar' : 'mail';
  }
}

export interface NeedsYouRow {
  id: string;
  item: NeedsYouItem;
  glyph: NeedsYouGlyph;
  tone: NeedsYouItem['severity'];
  title: string;
  /** The grey words after the title; empty once the assistant's summary says it (`research.view.text`). */
  body: string;
  when: string;
  /** The item's own buttons; with research, what is left beside the step, Ignore and Ask (`needsYouResearchActions`). */
  actions: NeedsYouAction[];
  /** What the assistant found out (LR-09), drawn on a line of its own with its face; null: the item as before. */
  research: NeedsYouResearch | null;
}

/**
 * The rows as Home draws them, in the server's order. `assistant` names Ask {assistant} on an item it looked into;
 * without it such an item is drawn as before.
 */
export function needsYouRows(
  items: readonly NeedsYouItem[],
  now: Date | number,
  timeZone: string,
  assistant?: string,
  locale?: string | null,
): NeedsYouRow[] {
  return items.map((item) => {
    const research = assistant ? needsYouResearch(item, assistant) : null;
    return {
      id: item.id,
      item,
      glyph: needsYouGlyph(item),
      tone: item.severity,
      ...needsYouResearchWords(item, research),
      when: needsYouWhen(item.at, now, timeZone, locale),
      actions: research ? needsYouResearchActions(item, research.view) : needsYouActions(item),
      research,
    };
  });
}

/**
 * An item's buttons by its kind (Whombat quiet-notices.md QN-02; app quiet-notices.md AP-4806): only a problem asks the
 * assistant, so “Look into it” is left out of an only-you item (sign in again, replace a disk) and a heads-up. Without
 * `nature` (older servers, asks): the server's buttons as they are.
 */
export function needsYouActions(item: Pick<NeedsYouItem, 'actions' | 'nature'>): NeedsYouAction[] {
  if (!item.nature || item.nature === 'problem') return item.actions;
  return item.actions.filter((a) => a.kind !== 'investigate');
}

/* What the assistant found out (LR-09) ---------------------------------------------------------------------------- */

export interface NeedsYouResearch {
  view: LookResearchView;
  /** The look's key, which the step's button sends (`looks.fix`). */
  key: string;
}

/** An item's research as its row draws it, or null for the item as before (none, or `failed`). */
export function needsYouResearch(
  item: Pick<NeedsYouItem, 'research'>,
  assistant: string,
): NeedsYouResearch | null {
  const view = lookResearchView(item.research, assistant);
  return view && item.research ? { view, key: item.research.key } : null;
}

/**
 * An item's title and grey words beside its research (LR-09): once the assistant found out, its title (the item's own
 * when it gave none) and no grey words, its summary on the face's line says it; while it looks, the item's own.
 */
export function needsYouResearchWords(
  item: Pick<NeedsYouItem, 'title' | 'body'>,
  research: Pick<NeedsYouResearch, 'view'> | null,
): { title: string; body: string } {
  if (!research || research.view.state === 'looking') return { title: item.title, body: item.body };
  return { title: research.view.title || item.title, body: '' };
}

/**
 * The item's own buttons beside its research (LR-09): *Look into it* goes, it is being looked into; once it found out,
 * the snooze goes too (Ignore is the choice, LR-10) and what is left (where it is done: *Reconnect*) follows the step
 * as a second choice. While it looks, the others stay as they were.
 */
export function needsYouResearchActions(
  item: Pick<NeedsYouItem, 'actions' | 'nature'>,
  research: Pick<LookResearchView, 'state' | 'fix'>,
): NeedsYouAction[] {
  const own = needsYouActions(item).filter((a) => a.kind !== 'investigate');
  if (research.state === 'looking') return own;
  return own
    .filter((a) => a.kind !== 'snooze')
    .map((a) => (research.fix && a.style === 'primary' ? { ...a, style: 'secondary' as const } : a));
}

/**
 * What Ask {assistant} on an item does: open the look's thread in Chat, or, when the research has none (an older
 * Whombat's answer), start a chat about it as *Look into it* did.
 */
export function needsYouAskIntent(
  item: Pick<NeedsYouItem, 'title' | 'subject' | 'research'>,
): NeedsYouIntent {
  const href = item.research ? lookThreadHref(item.research) : null;
  if (href) return { type: 'open', href };
  return { type: 'investigate', text: investigateText(item), subject: item.subject ?? null };
}

/**
 * Ignore (Whombat ONE-24, contracts 0.80.3 `needsYou.ignore`): a button every client draws after an item's own ones.
 * The item leaves the person's Needs you for good; the toast offers Undo. Nothing else changes (an approval stays
 * undecided).
 */
export const NEEDS_YOU_IGNORE = {
  label: 'Ignore',
  done: 'Ignored. It won’t show here again.',
  undo: 'Undo',
} as const;

/**
 * Ignore's toast (Whombat quiet-notices.md QN-21; contracts 0.122 CT-1064; AP-4807): on a server alert or a connection
 * it is the shared Ignore of `things.quiet`, “Ignored. You’ll hear if it changes.”; on an approval or a question, the
 * person's own.
 */
export function needsYouIgnoreDone(ref: Pick<HomeRef, 'kind'>): string {
  return ['alert', 'hint', 'connection', 'device'].includes(ref.kind)
    ? QUIET_WORDS.toastIgnored
    : NEEDS_YOU_IGNORE.done;
}

/** The items left once one is snoozed, ignored or decided (the optimistic Home). */
export function withoutNeedsYou<T extends { needsYou: NeedsYouItem[]; summary: { needsYou: number } }>(
  overview: T,
  ref: HomeRef,
): T {
  const needsYou = overview.needsYou.filter((i) => !(i.ref.kind === ref.kind && i.ref.id === ref.id));
  if (needsYou.length === overview.needsYou.length) return overview;
  const gone = overview.needsYou.length - needsYou.length;
  return {
    ...overview,
    needsYou,
    summary: { ...overview.summary, needsYou: Math.max(0, overview.summary.needsYou - gone) },
  };
}
