/**
 * The Automations list's rows and one automation's page, on the web and the phone (docs/app/decisions/automation-page.md):
 * a row is the whole name, what starts it and one status line; the page says what the automation does, step by step,
 * in the plan card's words (core `automationFlow`, `planSections`, `planPrompts`), what it asks first, its limits and
 * its runs. Pure.
 */
import {
  type Automation,
  type AutomationFlowItem,
  type AutomationPlanLine,
  type AutomationPlanPrompt,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunSummary,
  type AutomationSource,
  type AutomationTrigger,
  automationFlow,
  type Decider,
  findMyWhenText,
  formatClock,
  formatDate,
  type PlanNames,
  planPrompts,
  planSections,
  planTryIt,
  thingWhenText,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { AUTOMATIONS_AREA_WORDS } from './i18n/messages/chatWork/automations';
import { automationTrackerWords, unknownTracker } from './trackerItem';

const tree = (locale?: string | null) => clientTree(locale, AUTOMATIONS_AREA_WORDS);

/** A sentence keeps its own stop: “Run #5 is waiting for a yes.” stays as it is. */
const stop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** How many runs the page's bars show, newest right. */
export const ROW_RUN_BARS = 5;

/** One automation's page and the list's words, in a locale (English when none). */
export function automationPageText(locale?: string | null) {
  const w = tree(locale).page;
  return {
    on: w.on,
    off: w.off,
    notOn: w.notOn,
    waiting: w.waiting,
    runsByItself: w.runsByItself,
    stopped: w.stopped,
    notOnLine: w.notOnLine,
    noRuns: w.noRuns,
    /** “Last run worked · 23 Sep, 11:06”; a run that hasn't finished says when it started. */
    lastRun: (result: string, when: string) => interpolate(w.lastRun, { result, when }),
    started: (when: string) => interpolate(w.started, { when }),
    /** “Next run 24 Sep, 08:30”, “Next run on a new issue”, “Next run when you start it”. */
    nextRun: (when: string) => interpolate(w.nextRun, { when }),
    nextOn: (event: string) => interpolate(w.nextOn, { event }),
    /** “Next run when Mara Visser arrives at Home” (a Find My trigger's own words). */
    nextWhen: (when: string) => interpolate(w.nextRun, { when }),
    nextByHand: w.nextByHand,
    noNext: w.noNext,
    noNextYet: w.noNextYet,
    planWaits: w.planWaits,
    newPlanWaits: w.newPlanWaits,
    whatHappens: w.whatHappens,
    asks: w.asks,
    limits: w.limits,
    runs: w.runs,
    prompts: (agent: string) => interpolate(w.prompts, { agent }),
    promptsCount: (n: number) => w.promptsCount(n),
    delete: w.delete,
    notFound: w.notFound,
    failed: w.failed,
    /** The right page beside the list, before one is picked. */
    pick: w.pick,
    unknownWhen: w.unknownWhen,
  };
}

export const AUTOMATION_PAGE_TEXT = automationPageText();

/** A run's status in a word: “Done”, “Needs you”. */
export function runStatusLabels(locale?: string | null): Record<AutomationRunStatus, string> {
  const s = tree(locale).status;
  return {
    queued: s.queued,
    running: s.running,
    waiting: s.waiting,
    paused: s.paused,
    succeeded: s.succeeded,
    failed: s.failed,
    cancelled: s.cancelled,
    skipped: s.skipped,
    needs_review: s.needs_review,
  };
}

export const AUTOMATION_RUN_STATUS_LABELS: Record<AutomationRunStatus, string> = runStatusLabels();

/**
 * A run's result in a word, as the list, the page and a run's page say it after “Last run” or “Finished ·”: “worked”,
 * “skipped”, “waiting for you”.
 */
export function runResultWords(locale?: string | null): Record<AutomationRunStatus, string> {
  const r = tree(locale).result;
  return {
    queued: r.queued,
    running: r.running,
    waiting: r.waiting,
    paused: r.paused,
    succeeded: r.succeeded,
    failed: r.failed,
    cancelled: r.cancelled,
    skipped: r.skipped,
    needs_review: r.needs_review,
  };
}

export const AUTOMATION_RUN_RESULT_WORDS: Record<AutomationRunStatus, string> = runResultWords();

/** A run that is over and has its finish time: it says “Finished · worked”, never “Finished” alone. */
const FINISHED: ReadonlySet<AutomationRunStatus> = new Set(['succeeded', 'failed', 'skipped']);

/**
 * A run's state on its page: “Finished · worked”, “Finished · failed”, “Finished · skipped” once it has finished, else
 * its status (“Running”, “Waiting”, “Stopped”).
 */
export function automationRunLabel(
  run: Pick<AutomationRunSummary, 'status' | 'finishedAt'>,
  locale?: string | null,
): string {
  return FINISHED.has(run.status) && run.finishedAt
    ? interpolate(tree(locale).page.finished, { result: runResultWords(locale)[run.status] })
    : runStatusLabels(locale)[run.status];
}

/** “23 Sep, 11:06”, with the year when it isn't this one's. */
export function runMoment(iso: string, now: Date, timeZone: string, locale?: string | null): string {
  return `${formatDate(iso, timeZone, { now }, locale)}, ${formatClock(iso, timeZone)}`;
}

/**
 * A run's colour on the bars and of its status word (AP-1093); `quiet` (stopped, skipped) is a short `line2` bar. Red
 * says something doesn't work now, so a run that failed or needs a look is `warn`: it is something that happened, and
 * never makes the automation look broken.
 */
export type RunBarTone = 'ok' | 'bad' | 'warn' | 'brand' | 'quiet';

export const RUN_BAR_TONES: Record<AutomationRunStatus, RunBarTone> = {
  succeeded: 'ok',
  failed: 'warn',
  waiting: 'warn',
  paused: 'warn',
  needs_review: 'warn',
  running: 'brand',
  queued: 'brand',
  cancelled: 'quiet',
  skipped: 'quiet',
};

/**
 * What the tile is called (a screen reader's words), by what starts the automation (AP-1090). A tracker's tile says the
 * tracker's own name when it is known (`automationTile`); this is its word otherwise.
 */
export function automationSourceLabels(locale?: string | null): Record<AutomationSource, string> {
  const s = tree(locale).source;
  return {
    github: s.github,
    tracker: s.tracker,
    mail: s.mail,
    findmy: s.findmy,
    thing: s.thing,
    schedule: s.schedule,
    message: s.message,
    reaction: s.reaction,
    webhook: s.webhook,
    manual: s.manual,
  };
}

export const AUTOMATION_SOURCE_LABELS: Record<AutomationSource, string> = automationSourceLabels();

/** The tile at the row's start: what starts the automation (AP-1090). */
export interface AutomationTileView {
  source: AutomationSource;
  /** The GitHub owner whose picture fills the tile (`acme` of `acme/Fusebox`); null: none to ask for. */
  owner: string | null;
  /** “GitHub · acme/Fusebox”, “Acme Desk”, “Schedule”. */
  label: string;
}

/** What waits for a person, and the word that opens it. */
export function automationWaitingText(locale?: string | null) {
  const w = tree(locale).waitingOn;
  return {
    approval: (n: number) => interpolate(w.approval, { n }),
    review: (n: number) => interpolate(w.review, { n }),
    open: w.open,
  };
}

export const AUTOMATION_WAITING_TEXT = automationWaitingText();

/** The newest run that waits for a person, with “Open” (AP-1094). */
export interface WaitingLineView {
  /** The run “Open” opens. */
  number: number;
  /** “Run #7 is waiting for a yes.” */
  text: string;
  accessibilityLabel: string;
}

/** The newest run waiting for a person (`waitingOn`, contracts 0.72), in words; null when none is. */
export function waitingLine(
  runs: readonly Pick<AutomationRunSummary, 'number' | 'waitingOn'>[],
  locale?: string | null,
): WaitingLineView | null {
  const run = runs.find((r) => r.waitingOn);
  if (!run?.waitingOn) return null;
  const words = automationWaitingText(locale);
  const text = words[run.waitingOn](run.number);
  return { number: run.number, text, accessibilityLabel: `${text} ${words.open}.` };
}

/** The automation's buttons (Whombat automation-chat.md). */
export function automationActionText(locale?: string | null) {
  const w = tree(locale).actions;
  return {
    talk: w.talk,
    run: w.run,
    try: w.try,
    talkHint: (name: string) => interpolate(w.talkHint, { name }),
    talkNewHint: (name: string) => interpolate(w.talkNewHint, { name }),
    runHint: (name: string) => interpolate(w.runHint, { name }),
    tryHint: (name: string) => interpolate(w.tryHint, { name }),
    /** Talk about it without a plan's thread: a new one, with this ready to finish. */
    about: (name: string) => interpolate(w.about, { name }),
  };
}

export const AUTOMATION_ACTION_TEXT = automationActionText();

/** “Tell Dusty…” for Talk about it without a plan's thread: a new one, with this ready to finish. */
export const talkAboutText = (name: string, locale?: string | null): string =>
  automationActionText(locale).about(name);

/**
 * Whether the viewer may delete the automation (`automations.delete`, AP-981): the person deletes any of them, the
 * agent none (one-person-android.md AP-5736); the server decides again.
 */
export function canDeleteAutomation(viewer: Decider): boolean {
  return viewer.kind === 'person';
}

/** What a row's tile shows: the first trigger's kind, and the GitHub owner's picture when there is one. */
const SOURCE_OF: Record<AutomationTrigger['kind'], AutomationSource> = {
  github: 'github',
  tracker: 'tracker',
  mail: 'mail',
  findmy: 'findmy',
  thing: 'thing',
  // Home Assistant and UniFi Protect show as the things they are.
  home_state: 'thing',
  protect: 'thing',
  schedule: 'schedule',
  message_posted: 'message',
  reaction_added: 'reaction',
  webhook: 'webhook',
  manual: 'manual',
};

/**
 * `names`: the tracker connections' labels, for a tracker automation whose recipe doesn't keep its tracker's words: its
 * tile is called what the tracker is (“Acme Desk”, the recipe's words), else its connection (“Acme Desk dev”), else
 * “Report tracker”.
 */
export function automationTile(
  a: Automation,
  names?: Pick<PlanNames, 'connectionLabel'>,
  locale?: string | null,
): AutomationTileView {
  const trigger = (a.definition ?? a.draft)?.triggers[0];
  const source = a.glance?.source ?? (trigger ? SOURCE_OF[trigger.kind] : 'manual');
  const repo = a.glance?.repo ?? (trigger?.kind === 'github' ? trigger.repo : null);
  const slash = repo?.indexOf('/') ?? -1;
  const owner = source === 'github' && repo && slash > 0 ? repo.slice(0, slash) : null;
  const label = automationSourceLabels(locale)[source];
  if (source === 'tracker') return { source, owner, label: trackerName(a, names) ?? label };
  return { source, owner, label: source === 'github' && repo ? `${label} · ${repo}` : label };
}

/** What a tracker automation's tracker is called: its recipe's words, else its connection's label; null: neither. */
function trackerName(a: Automation, names: Pick<PlanNames, 'connectionLabel'> | undefined): string | null {
  const words = automationTrackerWords(a);
  if (!unknownTracker(words)) return words.product;
  const connectionId = (a.definition ?? a.draft)?.triggers.flatMap((t) =>
    t.kind === 'tracker' ? [t.connectionId] : [],
  )[0];
  return (connectionId && names?.connectionLabel?.(connectionId)?.trim()) || null;
}

/** The definition the page and the row describe: the live one, else the plan's draft. */
function definitionOf(a: Automation) {
  return a.definition ?? a.draft;
}

/** What starts it, in the plan card's words (“A new report in Acme Desk dev”). */
export function automationStartWords(a: Automation, names: PlanNames, locale?: string | null): string {
  const d = definitionOf(a);
  const first = d ? automationFlow(d, a.grants, names)[0] : null;
  return first?.kind === 'when'
    ? first.text
    : (a.glance?.trigger ?? (a.triggerSummary || automationPageText(locale).unknownWhen));
}

export type AutomationStateTone = 'on' | 'off' | 'waiting' | 'draft';

/** Whether it runs, apart from anything that waits: on, off, or not on yet (its plan was never said yes to). */
export type AutomationRunsTone = 'on' | 'off' | 'draft';

export interface AutomationState {
  /** What the page leads with: `waiting` when a run or a plan waits for the person, else whether it runs. */
  tone: AutomationStateTone;
  /** Whether it runs: on, off or not on yet, whatever waits. */
  runs: AutomationRunsTone;
  /** “On”, “Off”, “Not on yet”: whether it runs, never how its last run went. */
  label: string;
  /** The line under it on the page: its last run, or what waits (“Run #48 is waiting for a yes.”). */
  line: string;
  /** “Last run worked · 23 Sep, 11:06”, “Last run waiting for you · started 23 Sep, 11:18”, “No runs yet”. */
  last: string;
  /** “Next run on a new issue”, “Next run 24 Sep, 08:30”, “No next run”; null when nothing says. */
  next: string | null;
  /** A plan that waits for the person's yes in Chat, in words; null when none does. */
  planWaits: string | null;
  /** The run that waits for a person, which “Open” opens; null when none does. */
  waitingRun: number | null;
}

/** Its last run in words: the result and when it finished, or when it started while it hasn't finished. */
export function lastRunWords(
  last: Pick<AutomationRunSummary, 'status' | 'startedAt' | 'finishedAt'> | null,
  now: Date,
  timeZone: string,
  locale?: string | null,
): string {
  const text = automationPageText(locale);
  if (!last) return text.noRuns;
  const result = runResultWords(locale)[last.status];
  if (last.finishedAt) return text.lastRun(result, runMoment(last.finishedAt, now, timeZone, locale));
  return last.startedAt
    ? text.lastRun(result, text.started(runMoment(last.startedAt, now, timeZone, locale)))
    : interpolate(tree(locale).page.lastRunOnly, { result });
}

/** What a trigger waits for, in the words after “Next run on”; null for one that starts at a time or by hand. */
function triggerEvent(t: AutomationTrigger, locale?: string | null): string | null {
  const e = tree(locale).events;
  switch (t.kind) {
    case 'github':
      return e[t.event];
    case 'tracker':
      return t.event === 'item_opened' ? e.newReport : e.customerReply;
    case 'mail':
      return e.mail;
    case 'message_posted':
      return e.message;
    case 'reaction_added':
      return e.reaction;
    case 'webhook':
      return e.webhook;
    default:
      return null;
  }
}

/**
 * What its next run waits for, from its triggers: “a new issue or pull request”, “a new report or customer reply”.
 * Events that start the same way share it (“a new issue or pull request”).
 */
function nextEvent(triggers: readonly AutomationTrigger[], locale?: string | null): string | null {
  const events = [...new Set(triggers.map((t) => triggerEvent(t, locale)).filter((e): e is string => !!e))];
  // Sharing the start (“a new issue or pull request”) is how English reads; other languages list both whole.
  if (locale && !locale.toLowerCase().startsWith('en'))
    return events.length ? events.reduce((first, second) => orWords(first, second, locale)) : null;
  if (events.length === 2) {
    const [first, second] = events as [string, string];
    const shared = /^(a new |a )/.exec(first)?.[0];
    if (shared && second.startsWith(shared)) return `${first} or ${second.slice(shared.length)}`;
    if (shared === 'a new ' && second.startsWith('a ')) return `${first} or ${second.slice(2)}`;
  }
  return events.length ? events.join(' or ') : null;
}

/**
 * What monitoring and Find My triggers wait for, in their own words after “Next run”: “when Mara Visser arrives at Home”, two joined
 * with “or”. Null without one.
 */
function nextWhen(triggers: readonly AutomationTrigger[], locale?: string | null): string | null {
  const whens = [
    ...new Set(
      triggers.flatMap((t) => {
        const text = t.kind === 'findmy' ? findMyWhenText(t) : t.kind === 'thing' ? thingWhenText(t) : null;
        if (!text) return [];
        return [text.charAt(0).toLowerCase() + text.slice(1)];
      }),
    ),
  ];
  return whens.length ? whens.reduce((first, second) => orWords(first, second, locale)) : null;
}

/** “a new issue or a push to a branch”, in a locale. */
function orWords(first: string, second: string, locale?: string | null): string {
  return interpolate(tree(locale).page.or, { first, second });
}

/** When it runs next: a known time, the event that starts it, or that it doesn't run. */
export function nextRunText(
  a: Pick<Automation, 'status' | 'currentVersion' | 'nextRunAt' | 'definition'>,
  now: Date,
  timeZone: string,
  locale?: string | null,
): string | null {
  const text = automationPageText(locale);
  if (a.currentVersion === null) return text.noNextYet;
  if (a.status !== 'published') return text.noNext;
  if (a.nextRunAt) return text.nextRun(runMoment(a.nextRunAt, now, timeZone, locale));
  const triggers = a.definition?.triggers ?? [];
  const event = nextEvent(triggers, locale);
  const when = nextWhen(triggers, locale);
  if (event && when) return orWords(text.nextOn(event), when, locale);
  if (event) return text.nextOn(event);
  if (when) return text.nextWhen(when);
  if (triggers.some((t) => t.kind === 'manual')) return text.nextByHand;
  return null;
}

/** Its state in words: whether it runs, what waits for the person, and its last and next run. */
export function automationState(
  a: Automation,
  now: Date,
  timeZone: string,
  locale?: string | null,
): AutomationState {
  const AUTOMATION_PAGE_TEXT = automationPageText(locale);
  const runs: AutomationRunsTone =
    a.currentVersion === null ? 'draft' : a.status === 'published' ? 'on' : 'off';
  const label =
    runs === 'draft'
      ? AUTOMATION_PAGE_TEXT.notOn
      : runs === 'on'
        ? AUTOMATION_PAGE_TEXT.on
        : AUTOMATION_PAGE_TEXT.off;
  const last = lastRunWords(a.lastRun ?? a.recentRuns[0] ?? null, now, timeZone, locale);
  const next = nextRunText(a, now, timeZone, locale);
  const planWaits = a.waitingPlanId
    ? runs === 'draft'
      ? AUTOMATION_PAGE_TEXT.newPlanWaits
      : AUTOMATION_PAGE_TEXT.planWaits
    : null;
  const base = { runs, label, last, next, planWaits };
  if (runs === 'draft')
    return {
      ...base,
      tone: planWaits ? 'waiting' : 'draft',
      line: planWaits ?? AUTOMATION_PAGE_TEXT.notOnLine,
      waitingRun: null,
    };
  const waitingRun = waitingLine(a.recentRuns, locale);
  if (waitingRun) return { ...base, tone: 'waiting', line: waitingRun.text, waitingRun: waitingRun.number };
  if (planWaits) return { ...base, tone: 'waiting', line: planWaits, waitingRun: null };
  if (runs === 'on') return { ...base, tone: 'on', line: last, waitingRun: null };
  const ran = !!(a.lastRun ?? a.recentRuns[0]);
  return { ...base, tone: 'off', line: ran ? last : AUTOMATION_PAGE_TEXT.stopped, waitingRun: null };
}

/* The list's rows ---------------------------------------------------------------------------------------------- */

/** A part of a row's one line: whether it runs first (stronger), a plan that waits in `warn` text. */
export interface AutomationRowPart {
  key: 'state' | 'last' | 'next' | 'plan';
  text: string;
}

export interface AutomationListRow {
  id: string;
  /** The whole name, on as many lines as it needs. */
  name: string;
  /** What starts it: “A new report in Acme Desk dev”, the page's words for it. */
  when: string;
  tile: AutomationTileView;
  state: AutomationState;
  /**
   * The one line under the name, joined with “ · ”: “On”, “Last run worked · 23 Sep, 11:06”, “Next run on a new
   * issue”, then a plan that waits. Off and not on yet read as clearly as on.
   */
  line: AutomationRowPart[];
  accessibilityLabel: string;
}

export function automationListRow(
  a: Automation,
  now: Date,
  timeZone: string,
  names: PlanNames,
  locale?: string | null,
): AutomationListRow {
  const state = automationState(a, now, timeZone, locale);
  const tile = automationTile(a, names, locale);
  const line: AutomationRowPart[] = [
    { key: 'state', text: state.label },
    { key: 'last', text: state.last },
    ...(state.next ? [{ key: 'next' as const, text: state.next }] : []),
    ...(state.planWaits ? [{ key: 'plan' as const, text: state.planWaits }] : []),
  ];
  return {
    id: a.id,
    name: a.name,
    when: automationStartWords(a, names, locale),
    tile,
    state,
    line,
    accessibilityLabel: [tile.label, a.name, ...line.map((p) => p.text)].map(stop).join(' '),
  };
}

/** Its last few runs as small bars, oldest left, and the bars in words; on the automation's page. */
export function runBars(
  runs: readonly Pick<AutomationRunSummary, 'id' | 'status'>[],
  locale?: string | null,
): {
  bars: { key: string; tone: RunBarTone }[];
  label: string | null;
} {
  const last = runs.slice(0, ROW_RUN_BARS);
  return {
    bars: [...last].reverse().map((r) => ({ key: r.id, tone: RUN_BAR_TONES[r.status] })),
    label: runBarsLabel(last, locale),
  };
}

/**
 * The run bars in words, newest runs first counted by result: “Last 5 runs: 4 worked, 1 failed”, “Last run: worked”.
 * Null without runs.
 */
export function runBarsLabel(
  runs: readonly Pick<AutomationRunSummary, 'status'>[],
  locale?: string | null,
): string | null {
  if (!runs.length) return null;
  const results = runResultWords(locale);
  const counts = new Map<string, number>();
  for (const r of runs) {
    const word = results[r.status];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = [...counts].map(([word, n]) => (runs.length === 1 ? word : `${n} ${word}`)).join(', ');
  const page = tree(locale).page;
  return runs.length === 1
    ? interpolate(page.lastRunBars, { parts })
    : interpolate(page.lastRunsBars, { n: runs.length, parts });
}

/** The list's rows: deleted ones left out (a list cached before the `automation.deleted` frame might hold one). */
export function automationListRows(
  automations: readonly Automation[],
  now: Date,
  timeZone: string,
  names: PlanNames,
  locale?: string | null,
): AutomationListRow[] {
  return automations
    .filter((a) => !a.deletedAt)
    .map((a) => automationListRow(a, now, timeZone, names, locale));
}

/** One of the overview's reads: still on its first read, failed (the first read or a refresh), and what it listed. */
export interface OverviewRead {
  pending: boolean;
  failed: boolean;
  /** Rows listed from what was read; `null` before anything was read. */
  count: number | null;
}

export interface AutomationOverview {
  /** Under the field: row placeholders, nothing (the list's own notice says why), nothing yet, or the groups. */
  body: 'loading' | 'unread' | 'empty' | 'list';
  /** Only tells you: its rows, a notice with Retry over the rows already read, or no group at all. */
  schedules: 'rows' | 'failed' | 'hidden';
}

/**
 * What the Automations overview shows from its two reads, the automations and the agent's schedules, on web and phone
 * (docs/decisions/automations-final.md). “No automations yet” only when both reads worked and found nothing: a
 * schedules read that failed says so under Only tells you instead, so missing data never looks like none.
 */
export function automationOverview(automations: OverviewRead, schedules: OverviewRead): AutomationOverview {
  const section = schedules.failed ? 'failed' : schedules.count ? 'rows' : 'hidden';
  if (automations.pending) return { body: 'loading', schedules: section };
  if (automations.count === null) return { body: 'unread', schedules: section };
  if (automations.count > 0 || section !== 'hidden') return { body: 'list', schedules: section };
  return { body: schedules.pending ? 'loading' : 'empty', schedules: section };
}

/* One automation's page ---------------------------------------------------------------------------------------- */

export interface AutomationRunRow {
  number: number;
  /** What started it: “#3 · Export to PDF cuts off the last page”. */
  title: string;
  status: string;
  /** Its result in a word: “worked”, “failed”, “waiting for you”. */
  result: string;
  tone: RunBarTone;
  /** When it finished, else when it started: “23 Sep, 11:06”; its status when it has neither. */
  when: string;
  accessibilityLabel: string;
}

export interface AutomationPageView {
  id: string;
  name: string;
  tile: AutomationTileView;
  /** The agent's one sentence of what it does (its plan's); null when it has none. */
  description: string | null;
  state: AutomationState;
  /** The switch: every automation that was turned on once can be switched; null before (its plan waits in Chat). */
  switch: { on: boolean } | null;
  /** Run now (it starts by hand and is on) or Try it (on a recent item or now, `planTryIt`); null with nothing to run. */
  run: { kind: 'run' | 'try'; label: string; hint: string; tryIt: 'sample' | 'now' } | null;
  talkHint: string;
  /** What happens, step by step; null without a definition to read (the summary says it instead). */
  flow: AutomationFlowItem[] | null;
  summary: string;
  asks: AutomationPlanLine[];
  limits: AutomationPlanLine[];
  prompts: AutomationPlanPrompt[];
  canDelete: boolean;
}

export function automationPage(
  a: Automation,
  options: {
    now: Date;
    timeZone: string;
    names: PlanNames;
    viewer?: Decider;
    deletes?: boolean;
    /** The person's language (English when none). */
    locale?: string | null;
  },
): AutomationPageView {
  const { locale } = options;
  const AUTOMATION_ACTION_TEXT = automationActionText(locale);
  const d = definitionOf(a);
  const sections = d ? planSections(d, a.grants, options.names) : [];
  const lines = (id: string) => sections.find((s) => s.id === id)?.lines ?? [];
  const startsByHand = a.status === 'published' && !!a.definition?.triggers.some((t) => t.kind === 'manual');
  // Try it runs what waits for a yes, else the live version.
  const tried = a.draft ?? a.definition;
  return {
    id: a.id,
    name: a.name,
    tile: automationTile(a, options.names, locale),
    description: a.description.trim() || null,
    state: automationState(a, options.now, options.timeZone, locale),
    switch: a.currentVersion === null ? null : { on: a.status === 'published' },
    run: startsByHand
      ? {
          kind: 'run',
          label: AUTOMATION_ACTION_TEXT.run,
          hint: AUTOMATION_ACTION_TEXT.runHint(a.name),
          tryIt: 'now',
        }
      : tried
        ? {
            kind: 'try',
            label: AUTOMATION_ACTION_TEXT.try,
            hint: AUTOMATION_ACTION_TEXT.tryHint(a.name),
            tryIt: planTryIt(tried),
          }
        : null,
    talkHint: a.talk ? AUTOMATION_ACTION_TEXT.talkHint(a.name) : AUTOMATION_ACTION_TEXT.talkNewHint(a.name),
    flow: d ? automationFlow(d, a.grants, options.names) : null,
    summary: a.summary || a.triggerSummary || automationPageText(locale).unknownWhen,
    asks: lines('asks'),
    limits: lines('limits'),
    prompts: d ? planPrompts(d) : [],
    canDelete: !!options.deletes && !!options.viewer && canDeleteAutomation(options.viewer),
  };
}

/** Its runs, newest first, each opening the run, with its result in words and when it finished. */
export function automationRunRows(
  runs: readonly (Pick<AutomationRun, 'number' | 'status' | 'startedAt' | 'trigger'> &
    Partial<Pick<AutomationRun, 'finishedAt'>>)[],
  now: Date,
  timeZone: string,
  locale?: string | null,
): AutomationRunRow[] {
  const statuses = runStatusLabels(locale);
  const results = runResultWords(locale);
  const page = tree(locale).page;
  return runs.map((r) => {
    const status = statuses[r.status];
    const result = results[r.status];
    const what = r.trigger.summary.trim();
    const title = what ? `#${r.number} · ${what}` : `#${r.number}`;
    const at = r.finishedAt ?? r.startedAt;
    const when = at ? runMoment(at, now, timeZone, locale) : status;
    return {
      number: r.number,
      title,
      status,
      result,
      tone: RUN_BAR_TONES[r.status],
      when,
      accessibilityLabel: interpolate(page.runLabel, { number: r.number, result, when, what }).trim(),
    };
  });
}
