/**
 * The Inbox (Whombat inbox.md IBX-01…; needs-you-list.md NYL-01…NYL-09), the parts web and phone share: its groups —
 * **Needs you** (the only one that counts), **{assistant}’s on it**, **Heads-ups** (folded), **Later** (reminded
 * tomorrow) and **Settled** (folded) at the foot — each row's words and buttons, and what a button does. The server says
 * which group an item is in (`NeedsYouItem.group`, core's `needsYouGroupOf`; its `quiet` is Later or Settled by the
 * item's `state`); an older Whombat without the list gives its Needs you items, all in the first group. One set of words
 * everywhere: the step the assistant found, *Settle*, and in a row's More *Ask {assistant} to handle it*, *Talk to
 * {assistant} about it*, *Remind me tomorrow* and *Stop watching this*. Pure.
 */

import {
  type ChatSubject,
  fillQuietWords,
  type HomeOverview,
  type HomeRef,
  type NeedsYouAction,
  type NeedsYouGroup,
  type NeedsYouItem,
  type NeedsYouWatch,
  needsYouCount,
  needsYouGroupOf,
  QUIET_WORDS,
  stopWatchingLabel,
  type ThingSummary,
  thingId,
} from '@whombat/core';
import {
  APPROVAL_ASK_WORDS,
  type ApprovalTonightView,
  approvalPermissionText,
  approvalTonight,
} from '@whombat/core/approvals';
import { formatClock } from '@whombat/core/text';
import { type AgentWords, agentWords } from '../agentName';
import { type LookResearchView, lookResearchView, lookThreadHref } from './lookResearch';
import { type NeedsYouGlyph, needsYouGlyph } from './needsYou';
import { needsYouWhen, tomorrowMorning, untilText } from './time';

/* Words ------------------------------------------------------------------------------------------------------------ */

/**
 * Where a row sits in the Inbox: the server's groups, its `quiet` split into what comes back tomorrow (`later`) and what
 * the person settled (`settled`).
 */
export type InboxGroup = Exclude<NeedsYouGroup, 'quiet'> | 'later' | 'settled';

export const NEEDS_YOU_WORDS = {
  title: 'Inbox',
  /** The page's line under its title. */
  subtitle: (w: Pick<AgentWords, 'Name'>) => `What only you can decide, and what ${w.Name} is on.`,
  empty: 'All good. Nothing needs you.',
  /** Above the other groups when nothing needs the person. */
  nothing: 'Nothing needs you right now.',
  groups: {
    you: 'Needs you',
    assistant: '{Name}’s on it',
    fyi: 'Heads-ups',
    later: 'Later',
    settled: 'Settled',
  } satisfies Record<InboxGroup, string>,
  /** The folded groups' rows. */
  showHeadsUps: (n: number) => `Show ${n} heads-up${n === 1 ? '' : 's'}`,
  hideHeadsUps: 'Hide heads-ups',
  showSettled: (n: number) => `Show ${n} settled`,
  hideSettled: 'Hide settled',
  /** Settled with nothing in it (it is always shown, last). */
  noneSettled: 'Nothing settled. What you settle waits here, and comes back if it happens again.',
  ask: (w: Pick<AgentWords, 'name'>) => `Ask ${w.name}`,
  /** A problem's one verb, whether the assistant looks into it or fixes what only the person could. */
  askFix: (w: Pick<AgentWords, 'name'>) => `Ask ${w.name} to handle it`,
  handle: (w: Pick<AgentWords, 'name'>) => `Ask ${w.name} to handle it`,
  talk: (w: Pick<AgentWords, 'name'>) => `Talk to ${w.name} about it`,
  looking: (w: Pick<AgentWords, 'Name'>) => `${w.Name} is looking into it`,
  fixing: (w: Pick<AgentWords, 'Name'>) => `${w.Name} is on it`,
  see: 'See it',
  settle: 'Settle',
  snooze: 'Remind me tomorrow',
  back: 'Bring it back',
  /** A settled or later row's swipe. */
  backShort: 'Bring back',
  more: 'More',
  /** What a screen reader calls a row's More: “More for blackbox’s disk array failed”. */
  moreFor: (title: string) => `More for ${title}`,
  /** The toasts. */
  snoozed: 'I’ll remind you tomorrow morning.',
  /** Settle on a line Whombat watches: it comes back when it happens again. */
  settledLine: 'Settled. It comes back if it happens again.',
  settledOwn: 'Settled.',
  /** *Ask {assistant} to handle it* went through: the row moves to its group. */
  handling: (w: Pick<AgentWords, 'Name'>) => `${w.Name} is on it.`,
  /** Stop watching this: “Whombat stopped watching “Plex can’t be reached…”.”, with Undo. */
  stopped: (name: string) => fillQuietWords(QUIET_WORDS.toastStopped, { name }),
  backDone: 'It’s back.',
  undo: QUIET_WORDS.undo,
  failed: 'That didn’t work. Try again in a moment.',
  /** An item's page once it has left the list. */
  gone: 'This doesn’t need you any more.',
  /** The list's read states: loading, nothing in it, a first read that failed, a refresh that failed. */
  loading: 'Loading the Inbox…',
  emptyBody: 'New questions and things that need you appear here.',
  backToChat: 'Back to Chat',
  readFailed: 'Couldn’t read the Inbox.',
  refreshFailed: 'Couldn’t refresh the Inbox.',
  noSaved: 'There’s no saved copy to show on this device yet.',
  saved: 'Showing the saved details already on this device.',
  retry: 'Try again',
  moreDetail: 'More detail',
  /** An approval row's Details: the approval itself, with its target and lasting yes. */
  openApproval: 'Open approval',
  /** What *Ask {assistant}* says when the list couldn't be read. */
  readFailedAsk: 'Please check why I couldn’t read the Inbox.',
} as const;

/** A group's heading, with the assistant's name. */
export function needsYouGroupLabel(group: InboxGroup, words: Pick<AgentWords, 'Name'>): string {
  return NEEDS_YOU_WORDS.groups[group].replace('{Name}', words.Name);
}

/** Where an item sits in the Inbox: the server's group, its quiet ones by whether they come back tomorrow. */
export function inboxGroupOf(item: NeedsYouItem): InboxGroup {
  const group = item.group ?? needsYouGroupOf(item);
  if (group !== 'quiet') return group;
  return item.state === 'snoozed' ? 'later' : 'settled';
}

/* Buttons ---------------------------------------------------------------------------------------------------------- */

/**
 * A row's button: the step the assistant found (`fix`, `looks.fix`), *Ask {assistant} to fix it* (`askFix`), one of
 * the server's (`action`: Yes, do it · Tonight · No, Answer, Sign in again…), *See it* (`see`, its place), *Settle*
 * (`settle`: gone until it happens again), *Ask {assistant} to handle it* (`handle`: the assistant takes it on,
 * `looks.handle`), *Talk to {assistant} about it* (`talk`: a thread with it, `needsYou.discuss`), *Remind me tomorrow*
 * (`snooze`), *Stop watching this* (`stop`, the check behind it switched off: on-purpose.md) and *Bring it back*
 * (`back`).
 */
export type NeedsYouButtonKind =
  | 'fix'
  | 'askFix'
  | 'action'
  | 'see'
  | 'settle'
  | 'handle'
  | 'talk'
  | 'snooze'
  | 'stop'
  | 'back';

export interface NeedsYouButton {
  id: string;
  kind: NeedsYouButtonKind;
  label: string;
  /** `primary` filled, `secondary` outlined, `quiet` words only. */
  look: 'primary' | 'secondary' | 'quiet';
  /** The server's button, for `action`. */
  action?: NeedsYouAction;
  /** In the row's More (the web's ⋯, the phone's swipe): the row shows its way forward and Settle. */
  more?: boolean;
}

/** Kinds that are a line Whombat watches (a server's, a connection's, a device's, a failed run), not an ask. */
const LINE_KINDS: ReadonlySet<NeedsYouItem['kind']> = new Set([
  'alert',
  'hint',
  'connection',
  'device',
  'automation_run',
]);

/** Asks someone waits on the person's answer to: they are answered, never settled. */
const WAITING_KINDS: ReadonlySet<NeedsYouItem['kind']> = new Set([
  'approval',
  'question',
  'device_skill',
  'enrollment',
]);

/** Whether an item is a line Whombat watches (not an approval, a question, a skill or an enrolment). */
export function isNeedsYouLine(item: Pick<NeedsYouItem, 'kind'>): boolean {
  return LINE_KINDS.has(item.kind);
}

/** Whether someone waits on the person's answer to it (an approval, a question, a skill, an enrolment): no Settle. */
export function isNeedsYouWaiting(item: Pick<NeedsYouItem, 'kind'>): boolean {
  return WAITING_KINDS.has(item.kind);
}

/** The server's own buttons a row keeps: the asks' and where it is done (`open`); a line's Look into it and snooze are drawn here. */
function ownActions(item: Pick<NeedsYouItem, 'kind' | 'actions'>): NeedsYouAction[] {
  if (!isNeedsYouLine(item)) return item.actions.filter((a) => a.kind !== 'snooze');
  return item.actions.filter((a) => a.kind === 'open');
}

const actionButton = (a: NeedsYouAction, look?: NeedsYouButton['look']): NeedsYouButton => ({
  id: a.id,
  kind: 'action',
  label: a.label,
  look: look ?? (a.style === 'primary' ? 'primary' : 'secondary'),
  action: a,
});

/**
 * An approval's answers in the one order and words every place uses (core's `APPROVAL_ASK_WORDS`): Yes, now · Yes,
 * tonight · No where it offers a later time, Yes, do it · No where it doesn't, whatever an older Whombat called them.
 */
function approvalAnswers(actions: readonly NeedsYouAction[]): NeedsYouAction[] {
  const W = APPROVAL_ASK_WORDS;
  const later = actions.some((a) => a.kind === 'approve_later');
  const rank = (a: NeedsYouAction) =>
    a.kind === 'approve' ? 0 : a.kind === 'approve_later' ? 1 : a.kind === 'decline' ? 2 : 3;
  // An older Whombat's “Not now” isn't an answer: it is the quiet Remind me tomorrow after them.
  return actions
    .filter((a) => a.kind !== 'snooze')
    .sort((a, b) => rank(a) - rank(b))
    .map((a) =>
      a.kind === 'approve'
        ? { ...a, label: later ? W.now : W.yes }
        : a.kind === 'approve_later'
          ? { ...a, label: W.later }
          : a.kind === 'decline'
            ? { ...a, label: W.no }
            : a,
    );
}

/**
 * A row's buttons by its group and what the assistant knows (inbox.md IBX-03…IBX-06). Shown: its one way forward and
 * *Settle*; in More: *Ask {assistant} to handle it* (when that isn't already its way forward), *Talk to {assistant}
 * about it*, *Remind me tomorrow* and *Stop watching this*.
 *
 * - Needs you: an approval its yes, tonight and no; another ask its own (Answer, Choose, Review); neither settles. A line
 *   the assistant found something about its step first, then where it is done; a line it isn't looking at *Ask
 *   {assistant} to handle it* (a problem) or *Ask {assistant} to fix it* (an only-you line it can do) or where it is
 *   done; a suggestion its own buttons.
 * - {assistant}’s on it: only More, with *Talk to {assistant} about it* (its thread).
 * - Heads-ups: *Settle*, the rest in More.
 * - Later and Settled: *Bring it back*, *Talk to {assistant} about it* and *Stop watching this* in More.
 */
export function needsYouButtons(
  item: Pick<
    NeedsYouItem,
    'kind' | 'nature' | 'actions' | 'fixable' | 'href' | 'research' | 'watch' | 'subject'
  >,
  group: InboxGroup,
  words: Pick<AgentWords, 'name'>,
  research: LookResearchView | null,
): NeedsYouButton[] {
  const W = NEEDS_YOU_WORDS;
  // Something set up so on purpose: switch its check off (on-purpose.md); a settled one too.
  const stop: NeedsYouButton[] = item.watch
    ? [{ id: 'stop', kind: 'stop', label: stopWatchingLabel(item.watch.subject), look: 'quiet', more: true }]
    : [];
  // A question opens the thread it was asked in with its own Answer: no second way there.
  const talk: NeedsYouButton[] =
    item.kind === 'question'
      ? []
      : [{ id: 'talk', kind: 'talk', label: W.talk(words), look: 'quiet', more: true }];
  const settle: NeedsYouButton = { id: 'settle', kind: 'settle', label: W.settle, look: 'secondary' };
  const snooze: NeedsYouButton = { id: 'snooze', kind: 'snooze', label: W.snooze, look: 'quiet', more: true };
  const handle: NeedsYouButton = {
    id: 'handle',
    kind: 'handle',
    label: W.handle(words),
    look: 'quiet',
    more: true,
  };
  if (group === 'later' || group === 'settled')
    return [{ id: 'back', kind: 'back', label: W.back, look: 'secondary' }, ...talk, ...stop];
  if (group === 'assistant') return talk;
  if (group === 'fyi') return [settle, handle, ...talk, snooze, ...stop];
  if (isNeedsYouWaiting(item)) {
    const own = item.kind === 'approval' ? approvalAnswers(item.actions) : ownActions(item);
    // An approval is reminded of only where its Whombat offers that (inbox.md IBX-04).
    const remind = item.kind !== 'approval' || item.actions.some((a) => a.kind === 'snooze');
    return [...own.map((a) => actionButton(a)), ...talk, ...(remind ? [snooze] : [])];
  }
  if (!isNeedsYouLine(item))
    return [...ownActions(item).map((a) => actionButton(a)), settle, ...talk, snooze];
  const own = ownActions(item);
  // A line that needs the person shows one way forward; Settle and the rest wait in its More.
  const oneWay = (buttons: NeedsYouButton[]): NeedsYouButton[] => {
    const lead = buttons.findIndex((b) => !b.more);
    return buttons.map((b, i) => (i === lead || b.more ? b : { ...b, more: true }));
  };
  if (research) {
    const out: NeedsYouButton[] = [];
    if (research.fix) out.push({ id: 'fix', kind: 'fix', label: research.fix, look: 'primary' });
    out.push(...own.map((a) => actionButton(a, out.length ? 'secondary' : undefined)));
    // While it takes its step the line doesn't settle (the research says so).
    if (research.ignore) out.push(settle);
    return oneWay([...out, ...talk, snooze, ...stop]);
  }
  const lead: NeedsYouButton[] =
    item.nature === 'you'
      ? item.fixable
        ? [{ id: 'askFix', kind: 'askFix', label: W.askFix(words), look: 'primary' }]
        : own.length
          ? []
          : item.href
            ? [{ id: 'see', kind: 'see', label: W.see, look: 'primary' }]
            : []
      : [{ ...handle, look: 'primary', more: false }];
  const rest = own.map((a) => actionButton(a, lead.length ? 'secondary' : undefined));
  return oneWay([...lead, ...rest, settle, ...talk, snooze, ...stop]);
}

/** The button a row's swipe runs at its edge (the phone): Settle, or Bring it back on Later and Settled; null without. */
export function needsYouSwipe(row: Pick<NeedsYouListRow, 'buttons'>): NeedsYouButton | null {
  return row.buttons.find((b) => b.kind === 'settle' || b.kind === 'back') ?? null;
}

/** What a row's More holds: the buttons behind its ⋯ (web) or its swipe's More (phone). */
export function needsYouMore(row: Pick<NeedsYouListRow, 'buttons'>): NeedsYouButton[] {
  return row.buttons.filter((b) => b.more);
}

/* Rows and groups -------------------------------------------------------------------------------------------------- */

export interface NeedsYouListRow {
  id: string;
  item: NeedsYouItem;
  group: InboxGroup;
  glyph: NeedsYouGlyph;
  tone: NeedsYouItem['severity'];
  /** The item's title, or the assistant's once it found out. */
  title: string;
  /** The grey words; empty once the assistant's summary says it. */
  body: string;
  /** “pve-02 · 3 days ago”, “Home Assistant · 10:12”, “09:40”. */
  meta: string;
  /** “Until tomorrow 09:00” on a Later row; null otherwise. */
  state: string | null;
  /** What the assistant says, beside its face: its finding, or “Neo is looking into it”; null without research. */
  says: LookResearchView | null;
  /** Where the title goes: the thing's tab, the guest, the connection, the run. */
  href: string | null;
  buttons: NeedsYouButton[];
  /** What a screen reader says for the row: “Problem: …”. */
  label: string;
}

export interface NeedsYouListGroupView {
  key: InboxGroup;
  label: string;
  rows: NeedsYouListRow[];
  /** Heads-ups and Settled start folded. */
  folded: boolean;
  /** The folded group's row: “Show 3 heads-ups”, and once open “Hide heads-ups”; null on a group that doesn't fold. */
  fold: { show: string; hide: string } | null;
}

export interface NeedsYouListView {
  /** The groups in their order, each only with rows. */
  groups: NeedsYouListGroupView[];
  /** What needs the person: the one count (the badge, the tab). */
  count: number;
  /** Nothing at all in the list. */
  empty: boolean;
}

const SEVERITY_WORDS: Record<NeedsYouItem['severity'], string | null> = {
  bad: 'Problem',
  warn: 'Needs a look',
  info: null,
};

/** Which items the list draws: the server's list, or an older Whombat's Needs you items. */
export function needsYouListItems(overview: Pick<HomeOverview, 'needsYou' | 'needsYouList'>): NeedsYouItem[] {
  return overview.needsYouList ?? overview.needsYou;
}

/** An item's group: the server's, else core's rule over what it carries. */
export function groupOf(item: NeedsYouItem): NeedsYouGroup {
  return item.group ?? needsYouGroupOf(item);
}

/**
 * What the assistant says about an item (LR-09) in the list: its finding (title, summary, step) once it found out, and
 * in the assistant's group the shared line — “Neo is looking into it”, “Neo is on it”, or green once fixed.
 */
export function needsYouSays(
  item: Pick<NeedsYouItem, 'research'>,
  words: Pick<AgentWords, 'name' | 'Name'>,
): LookResearchView | null {
  const view = lookResearchView(item.research, words.name);
  if (!view) return null;
  if (view.state === 'looking') return { ...view, text: NEEDS_YOU_WORDS.looking(words) };
  if (view.state === 'fixing') return { ...view, text: NEEDS_YOU_WORDS.fixing(words) };
  return view;
}

function rowOf(
  item: NeedsYouItem,
  words: AgentWords,
  names: ReadonlyMap<string, string>,
  now: Date | number,
  timeZone: string,
): NeedsYouListRow {
  const group = inboxGroupOf(item);
  // Its face says what it found on what needs the person, and what it is doing on its own group's rows; a line only
  // the person can do keeps its own words while the assistant looks into the rest of that thing.
  const view = needsYouSays(item, words);
  const says = group === 'assistant' || (group === 'you' && view?.state === 'found') ? view : null;
  const found = says && says.state !== 'looking';
  const title = found ? says.title || item.title : item.title;
  const body = found ? '' : item.body;
  const where = item.subject
    ? (names.get(`${item.subject.kind}:${item.subject.id}`) ?? item.subject.name)
    : null;
  const when = needsYouWhen(item.at, now, timeZone);
  const state =
    group === 'later' && item.snoozedUntil ? capitalized(untilText(item.snoozedUntil, now, timeZone)) : null;
  const severity = group === 'you' && !says?.fixed ? SEVERITY_WORDS[item.severity] : null;
  const spoken = [title, body, says?.text ?? ''].map((s) => s.trim()).filter(Boolean);
  return {
    id: item.id,
    item,
    group,
    glyph: needsYouGlyph(item),
    tone: item.severity,
    title,
    body,
    meta: where && !title.includes(where) ? `${where} · ${when}` : when,
    state,
    says,
    href: item.href ?? null,
    buttons: needsYouButtons(item, group, words, found ? says : null),
    label: `${severity ? `${severity}: ` : ''}${spoken.map(sentence).join(' ')}`,
  };
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => (/[.?!…:]$/.test(s) ? s : `${s}.`);

const ORDER: readonly InboxGroup[] = ['you', 'assistant', 'fyi', 'later', 'settled'];

/** The folded groups' rows. */
function foldOf(key: InboxGroup, count: number): NeedsYouListGroupView['fold'] {
  if (key === 'fyi') return { show: NEEDS_YOU_WORDS.showHeadsUps(count), hide: NEEDS_YOU_WORDS.hideHeadsUps };
  if (key === 'settled')
    return { show: NEEDS_YOU_WORDS.showSettled(count), hide: NEEDS_YOU_WORDS.hideSettled };
  return null;
}

/**
 * The Inbox as both apps draw it: the groups in order — Needs you, {assistant}’s on it, Heads-ups (folded), Later,
 * Settled (folded; always there, at the very end, empty or not) — each in the server's order (worst first, then
 * newest), with what isn't working first in Needs you whatever the server's order, and the one count. `assistant` is the
 * assistant's name for its words.
 */
export function needsYouListView(
  overview: Pick<HomeOverview, 'needsYou' | 'needsYouList'> & {
    things?: readonly Pick<ThingSummary, 'id' | 'name'>[];
  },
  options: { now: Date | number; timeZone: string; assistant: string | null | undefined },
): NeedsYouListView {
  const words = agentWords(options.assistant);
  const names = new Map((overview.things ?? []).map((t) => [t.id, t.name]));
  const items = needsYouListItems(overview);
  const rows = items.map((item) => rowOf(item, words, names, options.now, options.timeZone));
  const groups = ORDER.flatMap((key): NeedsYouListGroupView[] => {
    const inGroup = rows.filter((r) => r.group === key);
    // Not working comes first in Needs you (a stable sort keeps the server's order otherwise).
    if (key === 'you') inGroup.sort((a, b) => Number(b.tone === 'bad') - Number(a.tone === 'bad'));
    // Settled is always there, last: where to look for what was put away, even before anything was.
    if (!inGroup.length && key !== 'settled') return [];
    const fold = inGroup.length ? foldOf(key, inGroup.length) : null;
    return [{ key, label: needsYouGroupLabel(key, words), rows: inGroup, folded: fold !== null, fold }];
  });
  return {
    groups,
    count: needsYouCount(items.map((i) => ({ group: groupOf(i) }))),
    empty: rows.length === 0,
  };
}

/** One item as the list draws it (an item's own page or sheet, opened from a row or a push). */
export function needsYouListRow(
  item: NeedsYouItem,
  options: {
    now: Date | number;
    timeZone: string;
    assistant: string | null | undefined;
    things?: readonly Pick<ThingSummary, 'id' | 'name'>[];
  },
): NeedsYouListRow {
  const names = new Map((options.things ?? []).map((t) => [t.id, t.name]));
  return rowOf(item, agentWords(options.assistant), names, options.now, options.timeZone);
}

/**
 * An approval row drawn as the one approval card (approval-card.md): who asks and when, its title, where, what happens,
 * the permission (an Inbox item names no key: *Not supplied in this request*) and the exact moment *Yes, tonight* means
 * (its `approve_later.at`). Its answers are the row's buttons. Null for anything but an approval.
 */
export interface NeedsYouApprovalCard {
  /** “Neo needs your OK” */
  status: string;
  /** “13:58” */
  asked: string;
  title: string;
  /** “pve-02” */
  subject: string | null;
  happens: string[];
  permission: string;
  tonight: ApprovalTonightView | null;
}

export function needsYouApprovalCard(
  row: Pick<NeedsYouListRow, 'item' | 'title' | 'body'>,
  options: { timeZone: string; assistant: string | null | undefined },
): NeedsYouApprovalCard | null {
  const { item } = row;
  if (item.kind !== 'approval') return null;
  const later = item.actions.find((a) => a.kind === 'approve_later');
  return {
    status: APPROVAL_ASK_WORDS.needs.replace('{name}', agentWords(options.assistant).Name),
    asked: formatClock(item.at, options.timeZone),
    title: row.title,
    subject: item.subject?.name.trim() || null,
    happens: row.body ? [row.body] : [],
    permission: approvalPermissionText(null),
    tonight: approvalTonight(later?.at, options.timeZone),
  };
}

/** The one count from Home (NYL-04): the server's; an older Whombat's Needs you items. */
export function needsYouBadge(overview: Pick<HomeOverview, 'summary'> | undefined): number | null {
  return overview ? overview.summary.needsYou : null;
}

const SEVERITY_RANK: Record<NeedsYouItem['severity'], number> = { bad: 0, warn: 1, info: 2 };

/** The worst severity among what needs the person (the badge's colour), or null with nothing. */
export function needsYouWorst(
  overview: Pick<HomeOverview, 'needsYou' | 'needsYouList'>,
): NeedsYouItem['severity'] | null {
  let worst: NeedsYouItem['severity'] | null = null;
  for (const item of needsYouListItems(overview))
    if (groupOf(item) === 'you' && (worst === null || SEVERITY_RANK[item.severity] < SEVERITY_RANK[worst]))
      worst = item.severity;
  return worst;
}

/** One row by its item's id (a push or a link names it, `needsYouItemHref`). */
export function needsYouRowById(view: NeedsYouListView, id: string): NeedsYouListRow | null {
  for (const g of view.groups) for (const r of g.rows) if (r.id === id) return r;
  return null;
}

/* What a button does ----------------------------------------------------------------------------------------------- */

/**
 * What pressing a row's button does, for the screen to carry out: the step (`fix`, the research), a question in the
 * thing's own thread (`ask`, `chats.start` with `reuseThread`), handing it to the assistant (`handle`, `looks.handle` on
 * the thing, else that question), a thread to talk it over (`talk`, `needsYou.discuss`), going somewhere (`open`), the
 * server's own (`action`, as `needsYouIntent`), Settle (`needsYou.ignore`), Remind me tomorrow (until tomorrow 09:00
 * local), Stop watching this, Bring it back.
 */
export type NeedsYouListIntent =
  | { type: 'fix' }
  | { type: 'ask'; text: string; subject: ChatSubject | null }
  | { type: 'handle'; key: string; text: string; subject: ChatSubject }
  | { type: 'talk'; ref: HomeRef }
  | { type: 'open'; href: string }
  | { type: 'action'; action: NeedsYouAction }
  | { type: 'settle'; ref: HomeRef }
  | { type: 'snooze'; ref: HomeRef; until: string }
  | { type: 'stop'; watch: NeedsYouWatch }
  | { type: 'back'; ref: HomeRef };

/**
 * The first line of a question about a thing, which becomes a new thread's title: the item's title, named by its thing
 * when the title doesn't say it (“pve-02: Disk 1 is 89 % full”).
 */
export function askTitle(item: Pick<NeedsYouItem, 'title' | 'subject'>): string {
  const name = item.subject?.name.trim();
  return name && !item.title.includes(name) ? `${name}: ${item.title}` : item.title;
}

/** What *Ask {assistant} to handle it* says in the thing's thread when there is no look to hand over: its title, then the ask. */
export function askText(item: Pick<NeedsYouItem, 'title' | 'subject'>): string {
  return `${askTitle(item)}\nCan you look into it?`;
}

/** What *Ask {assistant} to fix it* says: its title, what it says (which guests, what to do), then the ask. */
export function askFixText(item: Pick<NeedsYouItem, 'title' | 'body' | 'subject'>): string {
  return [askTitle(item), item.body.trim(), 'Can you fix it?'].filter(Boolean).join('\n');
}

export function needsYouListIntent(
  item: Pick<NeedsYouItem, 'ref' | 'title' | 'body' | 'subject' | 'href' | 'research' | 'watch'>,
  button: Pick<NeedsYouButton, 'kind' | 'action'>,
  now: Date | number,
  timeZone: string,
): NeedsYouListIntent | null {
  switch (button.kind) {
    case 'fix':
      return item.research ? { type: 'fix' } : null;
    case 'handle': {
      const text = askText(item);
      // About a server, a connection or a device: the assistant takes on everything there; else the question.
      return item.subject
        ? { type: 'handle', key: thingId(item.subject.kind, item.subject.id), text, subject: item.subject }
        : { type: 'ask', text, subject: null };
    }
    case 'talk': {
      // Once the assistant looked into it, its thread holds the whole story: talk there.
      const thread = item.research ? lookThreadHref(item.research) : null;
      return thread ? { type: 'open', href: thread } : { type: 'talk', ref: item.ref };
    }
    case 'askFix':
      return { type: 'ask', text: askFixText(item), subject: item.subject ?? null };
    case 'see':
      return item.href ? { type: 'open', href: item.href } : null;
    case 'action':
      // The person's yes to what the assistant proposes (first-day.md): their words, as their message to it.
      if (button.action?.kind === 'ask' && button.action.text)
        return { type: 'ask', text: button.action.text, subject: null };
      return button.action ? { type: 'action', action: button.action } : null;
    case 'settle':
      return { type: 'settle', ref: item.ref };
    case 'snooze':
      return { type: 'snooze', ref: item.ref, until: tomorrowMorning(now, timeZone) };
    case 'stop':
      return item.watch ? { type: 'stop', watch: item.watch } : null;
    case 'back':
      return { type: 'back', ref: item.ref };
  }
}

/** Settle's toast: on a line Whombat watches it comes back when it happens again; anything else simply settles. */
export function needsYouSettledText(ref: Pick<HomeRef, 'kind'>): string {
  return ['alert', 'hint', 'connection', 'device', 'automation_run'].includes(ref.kind)
    ? NEEDS_YOU_WORDS.settledLine
    : NEEDS_YOU_WORDS.settledOwn;
}

/**
 * The list the moment an item is settled, snoozed or decided (the server's answer then takes over): a decision takes
 * it out, Settle moves it to Settled and Remind me tomorrow to Later. The count follows.
 */
export function withNeedsYouListItem<T extends Pick<HomeOverview, 'needsYou' | 'needsYouList' | 'summary'>>(
  overview: T,
  ref: HomeRef,
  change: 'gone' | 'quiet' | 'snoozed',
  snoozedUntil?: string,
): T {
  const same = (i: NeedsYouItem) => i.ref.kind === ref.kind && i.ref.id === ref.id;
  const list = overview.needsYouList;
  const needsYou = overview.needsYou.filter((i) => !same(i));
  if (!list) {
    const gone = overview.needsYou.length - needsYou.length;
    if (!gone) return overview;
    return {
      ...overview,
      needsYou,
      summary: { ...overview.summary, needsYou: Math.max(0, overview.summary.needsYou - gone) },
    };
  }
  if (!list.some(same)) return overview;
  const next = list.flatMap((i): NeedsYouItem[] =>
    !same(i)
      ? [i]
      : change === 'gone'
        ? []
        : change === 'snoozed'
          ? [
              {
                ...i,
                state: 'snoozed' as const,
                group: 'quiet' as const,
                ...(snoozedUntil ? { snoozedUntil } : {}),
              },
            ]
          : [{ ...i, state: 'acknowledged' as const, group: 'quiet' as const }],
  );
  return {
    ...overview,
    needsYou,
    needsYouList: next,
    summary: { ...overview.summary, needsYou: needsYouCount(next) },
  };
}
