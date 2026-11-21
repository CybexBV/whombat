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
  formatClock,
  formatDate,
  type GitHubTriggerEvent,
  type PlanNames,
  planPrompts,
  planSections,
  planTryIt,
} from '@whombat/core';
import { automationTrackerWords, unknownTracker } from './trackerItem';

/** A sentence keeps its own stop: “Run #5 is waiting for a yes.” stays as it is. */
const stop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** How many runs the page's bars show, newest right. */
export const ROW_RUN_BARS = 5;

export const AUTOMATION_PAGE_TEXT = {
  on: 'On',
  off: 'Off',
  notOn: 'Not on yet',
  waiting: 'Waiting for you',
  runsByItself: 'Runs on its own',
  stopped: 'Doesn’t run until you switch it on',
  notOnLine: 'It starts once you say yes to its plan in Chat',
  noRuns: 'No runs yet',
  /** “Last run worked · 23 Sep, 11:06”; a run that hasn't finished says when it started. */
  lastRun: (result: string, when: string) => `Last run ${result} · ${when}`,
  started: (when: string) => `started ${when}`,
  /** “Next run 24 Sep, 08:30”, “Next run on a new issue”, “Next run when you start it”. */
  nextRun: (when: string) => `Next run ${when}`,
  nextOn: (event: string) => `Next run on ${event}`,
  nextByHand: 'Next run when you start it',
  noNext: 'No next run',
  noNextYet: 'No next run yet',
  planWaits: 'A change waits for your yes in Chat',
  newPlanWaits: 'Its plan waits for your yes in Chat',
  whatHappens: 'WHAT HAPPENS',
  asks: 'ASKS YOU FIRST',
  limits: 'LIMITS',
  runs: 'RECENT RUNS',
  prompts: (agent: string) => `What ${agent} is asked`,
  promptsCount: (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`,
  delete: 'Delete automation',
  notFound: 'This automation is gone.',
  failed: 'This automation didn’t load.',
  /** The right page beside the list, before one is picked. */
  pick: 'Pick an automation to see what it does.',
  unknownWhen: 'Not set up yet',
} as const;

/** A run's status in a word: “Done”, “Needs you”. */
export const AUTOMATION_RUN_STATUS_LABELS: Record<AutomationRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  paused: 'Paused',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  skipped: 'Skipped',
  needs_review: 'Needs you',
};

/**
 * A run's result in a word, as the list, the page and a run's page say it after “Last run” or “Finished ·”: “worked”,
 * “skipped”, “waiting for you”.
 */
export const AUTOMATION_RUN_RESULT_WORDS: Record<AutomationRunStatus, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for you',
  paused: 'paused',
  succeeded: 'worked',
  failed: 'failed',
  cancelled: 'stopped',
  skipped: 'skipped',
  needs_review: 'waiting for you',
};

/** A run that is over and has its finish time: it says “Finished · worked”, never “Finished” alone. */
const FINISHED: ReadonlySet<AutomationRunStatus> = new Set(['succeeded', 'failed', 'skipped']);

/**
 * A run's state on its page: “Finished · worked”, “Finished · failed”, “Finished · skipped” once it has finished, else
 * its status (“Running”, “Waiting”, “Stopped”).
 */
export function automationRunLabel(run: Pick<AutomationRunSummary, 'status' | 'finishedAt'>): string {
  return FINISHED.has(run.status) && run.finishedAt
    ? `Finished · ${AUTOMATION_RUN_RESULT_WORDS[run.status]}`
    : AUTOMATION_RUN_STATUS_LABELS[run.status];
}

/** “23 Sep, 11:06”, with the year when it isn't this one's. */
export function runMoment(iso: string, now: Date, timeZone: string): string {
  return `${formatDate(iso, timeZone, { now })}, ${formatClock(iso, timeZone)}`;
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
export const AUTOMATION_SOURCE_LABELS: Record<AutomationSource, string> = {
  github: 'GitHub',
  tracker: 'Report tracker',
  schedule: 'Schedule',
  message: 'Message',
  reaction: 'Reaction',
  webhook: 'Webhook',
  manual: 'Started by hand',
};

/** The tile at the row's start: what starts the automation (AP-1090). */
export interface AutomationTileView {
  source: AutomationSource;
  /** The GitHub owner whose picture fills the tile (`acme` of `acme/Fusebox`); null: none to ask for. */
  owner: string | null;
  /** “GitHub · acme/Fusebox”, “Acme Desk”, “Schedule”. */
  label: string;
}

/** What waits for a person, and the word that opens it. */
export const AUTOMATION_WAITING_TEXT = {
  approval: (n: number) => `Run #${n} is waiting for a yes.`,
  review: (n: number) => `Run #${n} needs you to look at it.`,
  open: 'Open',
} as const;

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
): WaitingLineView | null {
  const run = runs.find((r) => r.waitingOn);
  if (!run?.waitingOn) return null;
  const text = AUTOMATION_WAITING_TEXT[run.waitingOn](run.number);
  return { number: run.number, text, accessibilityLabel: `${text} ${AUTOMATION_WAITING_TEXT.open}.` };
}

/** The automation's buttons (Whombat automation-chat.md). */
export const AUTOMATION_ACTION_TEXT = {
  talk: 'Talk about it',
  run: 'Run now',
  try: 'Try it',
  talkHint: (name: string) => `Opens the conversation about ${name}`,
  talkNewHint: (name: string) => `Starts a conversation about ${name} in Chat`,
  runHint: (name: string) => `Starts ${name} now`,
  tryHint: (name: string) => `Runs ${name} once as a test`,
  /** Talk about it without a plan's thread: a new one, with this ready to finish. */
  about: (name: string) => `About “${name}”: `,
} as const;

/** “Tell Dusty…” for Talk about it without a plan's thread: a new one, with this ready to finish. */
export const talkAboutText = AUTOMATION_ACTION_TEXT.about;

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
): AutomationTileView {
  const trigger = (a.definition ?? a.draft)?.triggers[0];
  const source = a.glance?.source ?? (trigger ? SOURCE_OF[trigger.kind] : 'manual');
  const repo = a.glance?.repo ?? (trigger?.kind === 'github' ? trigger.repo : null);
  const slash = repo?.indexOf('/') ?? -1;
  const owner = source === 'github' && repo && slash > 0 ? repo.slice(0, slash) : null;
  const label = AUTOMATION_SOURCE_LABELS[source];
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
export function automationStartWords(a: Automation, names: PlanNames): string {
  const d = definitionOf(a);
  const first = d ? automationFlow(d, a.grants, names)[0] : null;
  return first?.kind === 'when'
    ? first.text
    : (a.glance?.trigger ?? (a.triggerSummary || AUTOMATION_PAGE_TEXT.unknownWhen));
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
): string {
  if (!last) return AUTOMATION_PAGE_TEXT.noRuns;
  const result = AUTOMATION_RUN_RESULT_WORDS[last.status];
  if (last.finishedAt) return AUTOMATION_PAGE_TEXT.lastRun(result, runMoment(last.finishedAt, now, timeZone));
  return last.startedAt
    ? AUTOMATION_PAGE_TEXT.lastRun(
        result,
        AUTOMATION_PAGE_TEXT.started(runMoment(last.startedAt, now, timeZone)),
      )
    : `Last run ${result}`;
}

/** A GitHub event as what the next run waits for (“a new issue”). */
const GITHUB_NEXT: Record<GitHubTriggerEvent, string> = {
  issue_opened: 'a new issue',
  pr_opened: 'a new pull request',
  pr_updated: 'new commits on a pull request',
  checks_completed: 'checks finishing on a pull request',
  review_submitted: 'a review on a pull request',
  branch_pushed: 'a push to a branch',
};

/** What a trigger waits for, in the words after “Next run on”; null for one that starts at a time or by hand. */
function triggerEvent(t: AutomationTrigger): string | null {
  switch (t.kind) {
    case 'github':
      return GITHUB_NEXT[t.event];
    case 'tracker':
      return t.event === 'item_opened' ? 'a new report' : 'a customer reply';
    case 'message_posted':
      return 'the next matching message';
    case 'reaction_added':
      return 'the next matching reaction';
    case 'webhook':
      return 'the next call to its web address';
    default:
      return null;
  }
}

/**
 * What its next run waits for, from its triggers: “a new issue or pull request”, “a new report or customer reply”.
 * Events that start the same way share it (“a new issue or pull request”).
 */
function nextEvent(triggers: readonly AutomationTrigger[]): string | null {
  const events = [...new Set(triggers.map(triggerEvent).filter((e): e is string => !!e))];
  if (events.length === 2) {
    const [first, second] = events as [string, string];
    const shared = /^(a new |a )/.exec(first)?.[0];
    if (shared && second.startsWith(shared)) return `${first} or ${second.slice(shared.length)}`;
    if (shared === 'a new ' && second.startsWith('a ')) return `${first} or ${second.slice(2)}`;
  }
  return events.length ? events.join(' or ') : null;
}

/** When it runs next: a known time, the event that starts it, or that it doesn't run. */
export function nextRunText(
  a: Pick<Automation, 'status' | 'currentVersion' | 'nextRunAt' | 'definition'>,
  now: Date,
  timeZone: string,
): string | null {
  if (a.currentVersion === null) return AUTOMATION_PAGE_TEXT.noNextYet;
  if (a.status !== 'published') return AUTOMATION_PAGE_TEXT.noNext;
  if (a.nextRunAt) return AUTOMATION_PAGE_TEXT.nextRun(runMoment(a.nextRunAt, now, timeZone));
  const triggers = a.definition?.triggers ?? [];
  const event = nextEvent(triggers);
  if (event) return AUTOMATION_PAGE_TEXT.nextOn(event);
  if (triggers.some((t) => t.kind === 'manual')) return AUTOMATION_PAGE_TEXT.nextByHand;
  return null;
}

/** Its state in words: whether it runs, what waits for the person, and its last and next run. */
export function automationState(a: Automation, now: Date, timeZone: string): AutomationState {
  const runs: AutomationRunsTone =
    a.currentVersion === null ? 'draft' : a.status === 'published' ? 'on' : 'off';
  const label =
    runs === 'draft'
      ? AUTOMATION_PAGE_TEXT.notOn
      : runs === 'on'
        ? AUTOMATION_PAGE_TEXT.on
        : AUTOMATION_PAGE_TEXT.off;
  const last = lastRunWords(a.lastRun ?? a.recentRuns[0] ?? null, now, timeZone);
  const next = nextRunText(a, now, timeZone);
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
  const waitingRun = waitingLine(a.recentRuns);
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
): AutomationListRow {
  const state = automationState(a, now, timeZone);
  const tile = automationTile(a, names);
  const line: AutomationRowPart[] = [
    { key: 'state', text: state.label },
    { key: 'last', text: state.last },
    ...(state.next ? [{ key: 'next' as const, text: state.next }] : []),
    ...(state.planWaits ? [{ key: 'plan' as const, text: state.planWaits }] : []),
  ];
  return {
    id: a.id,
    name: a.name,
    when: automationStartWords(a, names),
    tile,
    state,
    line,
    accessibilityLabel: [tile.label, a.name, ...line.map((p) => p.text)].map(stop).join(' '),
  };
}

/** Its last few runs as small bars, oldest left, and the bars in words; on the automation's page. */
export function runBars(runs: readonly Pick<AutomationRunSummary, 'id' | 'status'>[]): {
  bars: { key: string; tone: RunBarTone }[];
  label: string | null;
} {
  const last = runs.slice(0, ROW_RUN_BARS);
  return {
    bars: [...last].reverse().map((r) => ({ key: r.id, tone: RUN_BAR_TONES[r.status] })),
    label: runBarsLabel(last),
  };
}

/**
 * The run bars in words, newest runs first counted by result: “Last 5 runs: 4 worked, 1 failed”, “Last run: worked”.
 * Null without runs.
 */
export function runBarsLabel(runs: readonly Pick<AutomationRunSummary, 'status'>[]): string | null {
  if (!runs.length) return null;
  const counts = new Map<string, number>();
  for (const r of runs) {
    const word = AUTOMATION_RUN_RESULT_WORDS[r.status];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = [...counts].map(([word, n]) => (runs.length === 1 ? word : `${n} ${word}`));
  return `${runs.length === 1 ? 'Last run' : `Last ${runs.length} runs`}: ${parts.join(', ')}`;
}

/** The list's rows: deleted ones left out (a list cached before the `automation.deleted` frame might hold one). */
export function automationListRows(
  automations: readonly Automation[],
  now: Date,
  timeZone: string,
  names: PlanNames,
): AutomationListRow[] {
  return automations.filter((a) => !a.deletedAt).map((a) => automationListRow(a, now, timeZone, names));
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
  options: { now: Date; timeZone: string; names: PlanNames; viewer?: Decider; deletes?: boolean },
): AutomationPageView {
  const d = definitionOf(a);
  const sections = d ? planSections(d, a.grants, options.names) : [];
  const lines = (id: string) => sections.find((s) => s.id === id)?.lines ?? [];
  const startsByHand = a.status === 'published' && !!a.definition?.triggers.some((t) => t.kind === 'manual');
  // Try it runs what waits for a yes, else the live version.
  const tried = a.draft ?? a.definition;
  return {
    id: a.id,
    name: a.name,
    tile: automationTile(a, options.names),
    description: a.description.trim() || null,
    state: automationState(a, options.now, options.timeZone),
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
    summary: a.summary || a.triggerSummary || AUTOMATION_PAGE_TEXT.unknownWhen,
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
): AutomationRunRow[] {
  return runs.map((r) => {
    const status = AUTOMATION_RUN_STATUS_LABELS[r.status];
    const result = AUTOMATION_RUN_RESULT_WORDS[r.status];
    const what = r.trigger.summary.trim();
    const title = what ? `#${r.number} · ${what}` : `#${r.number}`;
    const at = r.finishedAt ?? r.startedAt;
    const when = at ? runMoment(at, now, timeZone) : status;
    return {
      number: r.number,
      title,
      status,
      result,
      tone: RUN_BAR_TONES[r.status],
      when,
      accessibilityLabel: `Run ${r.number}, ${result}, ${when}. ${what}`.trim(),
    };
  });
}
