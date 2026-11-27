/**
 * View models of the mobile automations screens shared by the list, an automation's page (`@whombat/client`
 * automationView) and a run: the list's words and tiles, the runs' colours, what waits for a person, Delete, the agent's
 * schedules that only tell you, and a run's steps. Automations are made and changed by talking to the agent (Whombat
 * automation-chat.md; the phone's automation-chat-mobile.md). A run reads in plain words: an assessment as tags and a
 * sentence with its technical details folded, a recipe's checks as their story, a finished run's skipped tail as one
 * row (AP-1010…), and a write back to a tracker as what it wrote (report-trackers.md TA-11). Pure, like the other
 * `data/` helpers; copy matches the web screens.
 */

import {
  ApiError,
  AUTOMATION_ACTION_TEXT,
  AUTOMATION_WAITING_TEXT,
  DECISION_WAITING,
  trackerReplyOutcome,
  trackerWriteOutcome,
} from '@whombat/client';
import {
  type AgentScheduleView,
  type Automation,
  AutomationAssessment,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunStep,
  type AutomationStepState,
  assessmentLine,
  scheduleCopy,
  stepKindLabel,
  type Tone,
  type TrackerWords,
  UNKNOWN_TRACKER_WORDS,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import { type ScheduleRow, scheduleRows } from './schedules';

// The list's and the page's words are the web's too (`@whombat/client` automationView).
export {
  AUTOMATION_ACTION_TEXT,
  AUTOMATION_SOURCE_LABELS,
  type AutomationTileView,
  canDeleteAutomation,
  RUN_BAR_TONES,
  type RunBarTone,
  type WaitingLineView,
  waitingLine,
} from '@whombat/client';

/**
 * A run's status and its colour. Red says something doesn't work now, so a failed run, or one that needs a look, is
 * `warn`: it happened, and the automation isn't broken for it. A finished run's page says how it went
 * (`automationRunLabel`: “Finished · worked”).
 */
export function runStatusCopy(locale?: string): Record<AutomationRunStatus, { label: string; tone: Tone }> {
  const { t } = mobileTranslator(locale);
  return {
    queued: { label: t('automations.runStatusCopy.queued.label'), tone: 'neutral' },
    running: { label: t('automations.runStatusCopy.running.label'), tone: 'ok' },
    waiting: { label: t('automations.runStatusCopy.waiting.label'), tone: 'warn' },
    paused: { label: t('automations.runStatusCopy.paused.label'), tone: 'warn' },
    succeeded: { label: t('automations.runStatusCopy.succeeded.label'), tone: 'ok' },
    failed: { label: t('automations.runStatusCopy.failed.label'), tone: 'warn' },
    cancelled: { label: t('automations.runStatusCopy.cancelled.label'), tone: 'neutral' },
    skipped: { label: t('automations.runStatusCopy.skipped.label'), tone: 'neutral' },
    needs_review: { label: t('automations.runStatusCopy.needs_review.label'), tone: 'warn' },
  };
}
export const RUN_STATUS_COPY = runStatusCopy();

export function stepStateCopy(locale?: string): Record<AutomationStepState, { label: string; tone: Tone }> {
  const { t } = mobileTranslator(locale);
  return {
    pending: { label: t('automations.stepStateCopy.pending.label'), tone: 'neutral' },
    running: { label: t('automations.stepStateCopy.running.label'), tone: 'ok' },
    waiting: { label: t('automations.stepStateCopy.waiting.label'), tone: 'warn' },
    succeeded: { label: t('automations.stepStateCopy.succeeded.label'), tone: 'ok' },
    failed: { label: t('automations.stepStateCopy.failed.label'), tone: 'bad' },
    skipped: { label: t('automations.stepStateCopy.skipped.label'), tone: 'neutral' },
    cancelled: { label: t('automations.stepStateCopy.cancelled.label'), tone: 'neutral' },
    blocked: { label: t('automations.stepStateCopy.blocked.label'), tone: 'bad' },
    uncertain: { label: t('automations.stepStateCopy.uncertain.label'), tone: 'bad' },
  };
}
export const STEP_STATE_COPY = stepStateCopy();

/** “Message in #bugs” → “Message in #bugs.”; a sentence keeps its own stop. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/* The list's words, its tiles and runs (automation-page.md AP-6330) ------------------------------------------ */

export function automationListText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    /** Under the title: the list is an overview, the agent makes and changes them. */
    intro: (agent: string) => t('automations.automationListText.intro', { agent }),
    /** Over the field. */
    tellIntro: (agent: string) => t('automations.automationListText.tellIntro', { agent }),
    /** The field-like button that starts a new Chat thread. */
    tell: (agent: string) => t('automations.automationListText.tell', { agent }),
    /** The field's words: short, so attach, the mic and send keep one row at any text size. */
    tellShort: (agent: string) => t('automations.automationListText.tellShort', { agent }),
    // In the sheet it opens, which has the room.
    tellPlaceholder: (agent: string) => t('automations.automationListText.tellPlaceholder', { agent }),
    tellTitle: (agent: string) => t('automations.automationListText.tellTitle', { agent }),
    tellHint: t('automations.automationListText.tellHint'),
    automations: t('automations.automationListText.automations'),
    loading: t('automations.automationListText.loading'),
    emptyTitle: t('automations.automationListText.emptyTitle'),
    empty: (agent: string) => t('automations.automationListText.empty', { agent }),
    emptyButton: (agent: string) => t('automations.automationListText.emptyButton', { agent }),
    readFailed: t('automations.automationListText.readFailed'),
    readFailedText: t('automations.automationListText.readFailedText'),
    refreshFailed: t('automations.automationListText.refreshFailed'),
    savedAt: (when: string) => t('automations.automationListText.savedAt', { when }),
    tryAgain: t('automations.automationListText.tryAgain'),
    ask: (agent: string) => t('automations.automationListText.ask', { agent }),
    /** What “Ask Dusty” puts in the field, unsent. */
    askText: t('automations.automationListText.askText'),
    moreDetail: t('automations.automationListText.moreDetail'),
    /** A plan waiting for a yes. */
    planWaiting: t('automations.automationListText.planWaiting'),
    /** Talk about it without a plan's thread: a new one, with this ready to finish. */
    talkAbout: AUTOMATION_ACTION_TEXT.about,
    /** The agent's schedules on the list. */
    onlyTellsYou: t('automations.automationListText.onlyTellsYou'),
    noRuns: t('automations.automationListText.noRuns'),
    open: AUTOMATION_WAITING_TEXT.open,
  } as const;
}
export const AUTOMATION_LIST_TEXT = automationListText();

/** How a mark looks on the automation's page: `plain` reaches a place, `warn` changes code or calls out, `bad` merges. */
export type AutomationTagTone = 'plain' | 'warn' | 'bad';

/* Deleting (contracts 0.66 `automations.delete`, CT-322; automation-recipes.md AP-980…) ---------------------------- */

export function automationDeleteText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    delete: t('automations.automationDeleteText.delete'),
    cancel: t('automations.automationDeleteText.cancel'),
    confirmTitle: (name: string) => t('automations.automationDeleteText.confirmTitle', { name }),
    confirmBody: t('automations.automationDeleteText.confirmBody'),
    /** The alert's title when the Whombat refused; its body is the server's message. */
    failed: t('automations.automationDeleteText.failed'),
    /** The run page of a deleted automation. */
    deleted: t('automations.automationDeleteText.deleted'),
    deleteHint: (name: string) => t('automations.automationDeleteText.deleteHint', { name }),
  } as const;
}
export const AUTOMATION_DELETE_TEXT = automationDeleteText();

/**
 * The automation is gone: the `automation.deleted` frame marked it, or the Whombat answers 404 (someone deleted it
 * first). A Delete answered 404 keeps the row gone, any other refusal brings it back with the server's words.
 */
export function automationGone(
  detail: { automation: Pick<Automation, 'deletedAt'> } | undefined,
  error: unknown,
): boolean {
  return !!detail?.automation.deletedAt || (error instanceof ApiError && error.status === 404);
}

/* The agent's schedules on the list (Whombat automation-chat.md) ------------------------------------------------- */

export interface OnlyTellsYouRow extends ScheduleRow {
  /** NEXT, while it has one: the list shows when it runs next and leaves the rest to Settings → Agent. */
  next: { label: string; value: string } | null;
}

/**
 * The agent's schedules that still run or are paused, as rows that only tell you (a reminder needs no yes); the ended
 * ones stay in Settings → Agent → Schedules.
 */
export function onlyTellsYouRows(
  schedules: readonly AgentScheduleView[],
  agentName: string,
  timeZone: string,
  now: Date,
): OnlyTellsYouRow[] {
  const next = scheduleCopy(agentName).next;
  return scheduleRows(
    schedules.filter((s) => s.status !== 'ended'),
    agentName,
    timeZone,
    now,
  ).map((row) => ({
    ...row,
    next: row.facts.find((f) => f.label === next) ?? null,
    accessibilityLabel: `${sentence(row.what)} Only tells you. ${row.when}.`,
  }));
}

export function runActive(status: AutomationRunStatus): boolean {
  return ['queued', 'running', 'waiting', 'paused', 'needs_review'].includes(status);
}

/** The fold under a step's assessment that opens its technical part (contracts 0.68 `details`; AP-1010). */
export const TECHNICAL_DETAILS = 'Technical details';

/**
 * An agent step's assessment in plain words (contracts 0.67/0.68, CT-323/CT-324; automation-recipes.md AP-1010): its
 * line as tags, the one-sentence summary, and the technical Markdown that stays folded.
 */
export interface RunStepAssessment {
  /** “Not a bug · low importance · fairly sure”: the server's `line`, else `assessmentLine` of the fields. */
  line: string;
  /** The line's parts, one tag each; the first is the kind. */
  tags: string[];
  /** One plain sentence; empty when the agent gave none. */
  summary: string;
  /** Markdown (files and lines, what was checked); null when there is none, and then nothing to open. */
  details: string | null;
  /**
   * The agent recommends a change (contracts 0.71 `recommends: 'change'`, Whombat AR-51; AP-1057): a “Suggests a
   * change” tag after the line. Absent on older rows is `nothing`.
   */
  suggests: boolean;
}

export interface RunStepView {
  key: string;
  title: string;
  state: string;
  tone: Tone;
  /** The agent's answer or the step's outcome, shortened; a condition's story (AP-1011). */
  body: string | null;
  /** How many lines of `body` show: a condition's story whole (0: no limit), anything else two. */
  bodyLines: number;
  /** An agent step's assessment: shown instead of `body` (AP-1010). */
  assessment: RunStepAssessment | null;
  error: string | null;
  /** A pending approval step opens the approval screen. */
  approvalNumber: number | null;
  approvalOpen: boolean;
  /** What TalkBack reads for the row: its name, its state and what it shows (AP-1013). */
  accessibilityLabel: string;
}

/** A plain object from a step's output, else null. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The assessment an agent step reported (`output.assessment`, kept by the server with its `line`), or null when it
 * has none. The line is the server's; an older server's output without one is said again with `assessmentLine`.
 */
export function stepAssessment(step: Pick<AutomationRunStep, 'kind' | 'output'>): RunStepAssessment | null {
  if (step.kind !== 'dispatch_agent') return null;
  const a = record((step.output as Record<string, unknown>).assessment);
  if (!a) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  // The fields only: the server adds `line`, `heading` and `detailsBlock`, which the strict schema doesn't know.
  const parsed = AutomationAssessment.safeParse({
    kind: a.kind,
    importance: a.importance,
    confidence: a.confidence,
    size: a.size,
    summary: a.summary,
    fixPlan: a.fixPlan,
    details: a.details,
    duplicateOf: a.duplicateOf,
    ...(a.recommends !== undefined ? { recommends: a.recommends } : {}),
  });
  const line = text(a.line) || (parsed.success ? assessmentLine(parsed.data) : '');
  if (!line) return null;
  return {
    line,
    tags: line
      .split(' · ')
      .map((t) => t.trim())
      .filter(Boolean),
    summary: text(a.summary),
    details: text(a.details) || null,
    suggests: a.recommends === 'change',
  };
}

/** The tag after an assessment's line when the agent recommends a change (the web's words, AP-1053). */
export const SUGGESTS_A_CHANGE = 'Suggests a change';

/**
 * What a recipe's check decided, in plain words: the server's `story` (contracts 0.68 `recipeConditionStory`, “No:
 * Banjo says it’s not a bug.”). Null for any other step, and from an older Whombat or an automation that isn't a recipe.
 */
export function conditionStory(step: Pick<AutomationRunStep, 'kind' | 'output'>): string | null {
  if (step.kind !== 'condition') return null;
  const story = (step.output as Record<string, unknown>).story;
  return typeof story === 'string' && story.trim() ? story.trim() : null;
}

/**
 * What a step produced in a sentence, where its raw output says it in a URL (the web's AP-974, AP-993; AP-1012), what
 * a `tracker_update` step wrote to the report (contracts 0.69, TA-11): “Wrote to Acme Desk dev #15: Likely bug · high
 * priority.”, or why it wrote nothing (“Nothing to write: Banjo says it’s not a bug.”), what a `tracker_reply` step
 * did (0.75): “Replied to the customer and set Acme Desk dev #16 to “Needs information”.” — a decision's status
 * too: “Planned”, “In progress”, “Not planned” — or why it sent nothing, and where a feature request's decision is
 * (3.12): the server's words, “Asked you about feature request #21”, “Approved by John · Planned”, “Declined by
 * John · “…””, “A newer assessment of this report replaced it.”, “Not a feature request.”. `words`: the tracker's,
 * for a tracker step that doesn't name its connection.
 */
export function stepOutcome(
  step: Pick<AutomationRunStep, 'kind' | 'state'> & Partial<Pick<AutomationRunStep, 'inputSummary'>>,
  o: Record<string, unknown>,
  words: TrackerWords = UNKNOWN_TRACKER_WORDS,
): string | null {
  switch (step.kind) {
    case 'tracker_update':
      return trackerWriteOutcome(o, words);
    case 'tracker_reply':
      return trackerReplyOutcome(o, words);
    case 'tracker_decision':
      return decisionOutcome(step, o);
    case 'connection_actions':
      if (typeof o.summary === 'string' && o.summary.trim()) return o.summary.trim();
      if (typeof o.reason === 'string' && o.reason.trim()) return o.reason.trim();
      return null;
    case 'github_comment':
      if (typeof o.reason === 'string' && o.reason.trim()) return o.reason.trim();
      return step.state === 'succeeded' && typeof o.number === 'number' ? `Commented on #${o.number}.` : null;
    case 'open_pull_request':
      return o.opened === true && typeof o.prNumber === 'number'
        ? `Opened pull request #${o.prNumber}.`
        : null;
    default:
      return null;
  }
}

/**
 * A `tracker_decision` step in words, the web's rule (`trackerDecisionOutcome`): the server writes where it is in
 * `inputSummary` whatever its state (asked, decided, replaced, skipped and why), else its `reason`, said once as a
 * sentence, with where to answer while it waits; null for anything else (the drafts in its output never show here).
 */
function decisionOutcome(
  step: Pick<AutomationRunStep, 'state'> & Partial<Pick<AutomationRunStep, 'inputSummary'>>,
  o: Record<string, unknown>,
): string | null {
  const said = step.inputSummary?.trim() || (typeof o.reason === 'string' ? o.reason.trim() : '');
  if (!said) return null;
  // One that ends in a quote (the person's own words) has its stop inside.
  const words = /[\p{L}\p{N}]$/u.test(said) ? `${said}.` : said;
  return step.state === 'waiting' ? `${words} ${DECISION_WAITING}` : words;
}

/** Steps that say what they did in words (`stepOutcome`): their raw `text` never shows. */
const SAYS_IN_WORDS: ReadonlySet<AutomationRunStep['kind']> = new Set([
  'tracker_update',
  'tracker_reply',
  'tracker_decision',
  'connection_actions',
]);

/** `words`: the tracker's as the automation keeps them (`automationTrackerWords`), for its tracker steps. */
export function runSteps(
  run: AutomationRun,
  words: TrackerWords = UNKNOWN_TRACKER_WORDS,
  locale?: string,
): RunStepView[] {
  const states = stepStateCopy(locale);
  return run.steps.map((s) => {
    const o = s.output as Record<string, unknown>;
    // A step of a kind this version doesn't know (an older version's) without a name is “An earlier step”.
    const name = s.name.trim() || stepKindLabel(s.kind);
    // A tracker write, reply or decision says what it did in words (`stepOutcome`), never its raw text.
    const text = typeof o.text === 'string' && !SAYS_IN_WORDS.has(s.kind) ? o.text : null;
    const decision = o.decision === 'approved' ? 'Approved.' : o.decision === 'declined' ? 'Declined.' : null;
    const result =
      typeof o.result === 'boolean' ? (o.result ? 'True: it went on.' : 'False: it stopped here.') : null;
    // Coding work and reviews (docs/decisions/bp-automations.md BP-C26, BP-C27).
    const branch = (o.workspace as { branch?: string } | undefined)?.branch ?? 'its branch';
    const coding =
      [
        typeof o.commits === 'number'
          ? `${o.commits} new commit${o.commits === 1 ? '' : 's'} on ${branch}.`
          : null,
        o.verdict === 'approve'
          ? 'Verdict: Approve.'
          : o.verdict === 'changes_needed'
            ? 'Verdict: Changes needed.'
            : null,
      ]
        .filter(Boolean)
        .join(' ') || null;
    const story = conditionStory(s);
    // What a request for a person's yes asks, in the card's words (“Suggested change for #214: …”, AP-1057).
    const asked =
      s.kind === 'request_approval' && typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null;
    const assessment = stepAssessment(s);
    // A condition's input is its expression: never shown on the phone (AP-1011).
    const input = s.kind === 'condition' ? null : s.inputSummary || null;
    const body =
      story ??
      stepOutcome(s, o, words) ??
      decision ??
      asked ??
      result ??
      coding ??
      (text ? text.slice(0, 280) : input);
    const state = states[s.state];
    const approvalOpen = s.approvalNumber !== null && s.state === 'waiting';
    const says = assessment
      ? [
          `Assessment: ${[...assessment.tags, ...(assessment.suggests ? [SUGGESTS_A_CHANGE.toLowerCase()] : [])].join(', ')}.`,
          assessment.summary,
        ]
      : [s.error ? null : body];
    return {
      key: s.stepId,
      title: name,
      state: state.label,
      tone: state.tone,
      body,
      bodyLines: story ? 0 : 2,
      assessment,
      error: s.error,
      approvalNumber: s.approvalNumber,
      approvalOpen,
      accessibilityLabel: [
        `${name}, ${state.label}.`,
        ...says,
        s.error,
        approvalOpen ? 'Opens the request.' : null,
      ]
        .filter(Boolean)
        .map((part) => sentence(part as string))
        .join(' '),
    };
  });
}

/** A finished run's last steps, all skipped, as one row that opens them (AP-1014). */
export interface SkippedStepsView {
  /** “4 more steps skipped”; “4 steps skipped” when no step ran before them. */
  label: string;
  steps: RunStepView[];
}

/** A step the run never reached: skipped without starting (a check stopped the run before it). */
const unreached = (step: AutomationRunStep | undefined) => step?.state === 'skipped' && !step.startedAt;

/**
 * A run's steps for its page: each one, except that a finished run's last steps, when two or more were skipped without
 * starting (a check stopped it), fold into one row; a single one, a step skipped with its own reason (it started) and
 * every step of a run still going show as they are. The web's rule (AP-1004).
 */
export function runStepsView(
  run: AutomationRun,
  words: TrackerWords = UNKNOWN_TRACKER_WORDS,
  locale?: string,
): { steps: RunStepView[]; skipped: SkippedStepsView | null } {
  const all = runSteps(run, words, locale);
  if (runActive(run.status)) return { steps: all, skipped: null };
  let first = all.length;
  while (first > 0 && unreached(run.steps[first - 1])) first--;
  const tail = all.slice(first);
  if (tail.length < 2) return { steps: all, skipped: null };
  return {
    steps: all.slice(0, first),
    skipped: {
      label: mobileTranslator(locale).t(first > 0 ? 'automations.skippedMore' : 'automations.skipped', {
        count: tail.length,
      }),
      steps: tail,
    },
  };
}
