/**
 * Cards that settle into a line (docs/decisions/card-settle.md AP-730…): what web and mobile share. A card is a card
 * while it is active — running, or waiting on someone — and one line once it is settled; the line opens the card in
 * place. Side effects of a run (a turn it scheduled, a deploy) show inside that run instead of as messages of their own. No DOM and no React Native here.
 */
import type {
  Approval,
  AssessmentCard,
  DeployCard,
  DeviceSkillCard,
  FeatureRequestView,
  FindMyWatchStatus,
  FindMyWatchView,
  MessageCard,
  Plan,
  ReportCard,
  Run,
  ScheduleCard,
  TaskCard,
  TaskCardState,
  ThingWatchView,
  TurnFailedCard,
} from '@whombat/core';
import {
  assessmentHeadline,
  DEVICE_SKILL_COPY,
  describeScheduleWhen,
  deviceSkillCopy,
  FEEDBACK_ASSESSMENT_STATE_LABELS,
  FEEDBACK_OUTCOME_LABELS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TYPE_LABELS,
  featureRequestOutcome,
  findMyWatchCardLines,
  formatTaskDuration,
  planProgress,
  reportCardState,
  SCHEDULE_END_LABELS,
  SCHEDULE_STATUS_LABELS,
  schedulePromptLine,
  TASK_CARD_WORDS,
  taskCardActive,
  taskCardElapsedMs,
  taskCardLine,
  taskResultLine,
  thingWatchCardLines,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { formatClock, formatDuration, shortSha } from '@whombat/core/text';
import { lookPlanCardView } from './home/lookPlan';
import { clientTree } from './i18n/catalog';
import { CARDS_AREA_WORDS } from './i18n/messages/chatWork/cards';
import { runShowsAsLine } from './runs';

/** The settled lines' own words, in a locale (English when none). */
function words(locale?: string | null) {
  return clientTree(locale, CARDS_AREA_WORDS).display;
}

/* How a card shows --------------------------------------------------------------------------------------------- */

/**
 * `full`: the card. `line`: one line that opens the card in place. `live`: a run at work — the compact live card (its
 * bar, what it does now, how long it has run), which opens the full card — or a server task Whombat follows while it
 * runs (task-feedback.md AP-4300).
 */
export type CardDisplay = 'full' | 'line' | 'live';

/**
 * A run: a run that changed nothing is the run line in every state (AP-668). One that changed something is the
 * compact live card while it works, the full card while it needs a person (it stopped without finishing, is paused,
 * failed), and one line once it is done or taken over.
 */
export function runDisplay(run: Pick<Run, 'status' | 'attention' | 'diff' | 'prNumber'>): CardDisplay {
  if (runShowsAsLine(run)) return 'line';
  switch (run.status) {
    case 'live':
      return run.attention?.trim() ? 'full' : 'live';
    case 'paused':
    case 'failed':
      return 'full';
    case 'done':
    case 'taken_over':
      return 'line';
  }
}

/** An approval is a card while it is pending or its action is executing; decided and settled, a line. */
export function approvalSettled(approval: Pick<Approval, 'state' | 'execution'>): boolean {
  if (approval.state === 'pending') return false;
  return approval.execution.state !== 'running';
}

/** A plan is a card while any step is still to do (active, queued, at a gate, blocked); all done or cancelled, a line. */
export function planSettled(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.length > 0 && plan.steps.every((s) => s.state === 'done' || s.state === 'cancelled');
}

/** An assessment is a card until someone chose its decision; one without a decision to choose is a line at once. */
export function assessmentSettled(card: Pick<AssessmentCard, 'decision' | 'decided'>): boolean {
  return card.decision === null || card.decided !== null;
}

/**
 * How a message's card shows. Content cards (research, review, commits, pill, answer, digest) and guide steps are
 * always cards: they are what the message says, not a status. A Whombat Feedback report is a line in its conversation
 * in every state (docs/decisions/report-rows.md RR-01, John: the cards took too much room): its outcome and one
 * sentence, with Details opening the whole report in place; its thread shows the whole report (RR-07).
 */
export function cardDisplay(card: MessageCard): CardDisplay {
  switch (card.kind) {
    case 'run':
      return runDisplay(card.run);
    case 'approval':
      return approvalSettled(card.approval) ? 'line' : 'full';
    case 'plan':
      return planSettled(card.plan) ? 'line' : 'full';
    case 'schedule':
      // A schedule is never more than a line: when, and Cancel while it is still to come.
      return 'line';
    case 'assessment':
      return assessmentSettled(card) ? 'line' : 'full';
    case 'turn_failed':
      return card.retriedAt ? 'line' : 'full';
    case 'report':
      return 'line';
    case 'deploy':
      // A recorded deploy is a fact, never waiting on anyone: one line (contracts 0.55, CT-297).
      return 'line';
    case 'device_skill':
      // A device skill is a card until the person switches it on or says not now (one-whombat-shell.md AP-1274).
      return card.status === 'proposed' ? 'full' : 'line';
    case 'task':
      // A server task Whombat follows (contracts 0.116, CT-880; task-feedback.md AP-4300): the live card while it runs,
      // one line with how it went once it ended.
      return taskCardActive(card) ? 'live' : 'line';
    case 'feature_request':
      // A feature request is a card while it waits for the person; one line once decided, replaced or stopped (Whombat
      // report-trackers.md TA-45).
      return card.request?.state === 'waiting' ? 'full' : 'line';
    case 'look_plan':
      // A thing's plan (handle-it.md): a card while it waits, is taken or says what was done; one line once no longer
      // needed.
      return lookPlanCardView(card.plan)?.state === 'gone' || !card.plan ? 'line' : 'full';
    case 'thing_watch':
    case 'findmy_watch':
      // A Find My watch is a card with Cancel while it watches, one line once it ended (findmy-watch.md).
      return card.watch?.status === 'watching' ? 'full' : 'line';
    default:
      return 'full';
  }
}

/* What a line says --------------------------------------------------------------------------------------------- */

/** One settled line: the lead (“Approved by John”), what it is about, and its tone (the dot's colour). */
export interface SettledLine {
  lead: string;
  detail: string | null;
  tone: 'live' | 'warn' | 'ok' | 'bad' | 'mut';
}

/** `Approved by John · Deploy feat/invoice-pdf to staging`; `Declined by John · …`. */
export function approvalLine(
  approval: Pick<Approval, 'state' | 'title'>,
  deciderName: string | null,
  locale?: string | null,
): SettledLine {
  const w = words(locale);
  const name = deciderName ?? '';
  return approval.state === 'declined'
    ? {
        lead: deciderName ? interpolate(w.declinedBy, { name }) : w.declined,
        detail: approval.title,
        tone: 'mut',
      }
    : {
        lead: deciderName ? interpolate(w.approvedBy, { name }) : w.approved,
        detail: approval.title,
        tone: 'ok',
      };
}

/**
 * A recorded deploy (contracts 0.55, CT-297): `Deployed api to production · 3f9c2a` in ok, `Deploy of api to production
 * failed · 3f9c2a` in bad — core's `deployLine`, its sha as the detail.
 */
export function deploySettledLine(
  card: Pick<DeployCard, 'status' | 'service' | 'environment' | 'sha'>,
  locale?: string | null,
): SettledLine {
  const w = words(locale);
  const lead = interpolate(card.status === 'succeeded' ? w.deployed : w.deployFailed, {
    service: card.service,
    environment: card.environment,
  });
  return {
    lead,
    detail: card.sha ? shortSha(card.sha.toLowerCase()) : null,
    tone: card.status === 'succeeded' ? 'ok' : 'bad',
  };
}

/**
 * A feature request no longer waiting (Whombat report-trackers.md TA-45): `Approved by John · Planned`, `Approved by
 * John · Being built`, `Declined by John`, `John asked the customer`, `Replaced by a newer assessment`, `No longer
 * waiting` — the request's title as the detail.
 */
export function featureRequestLine(
  request: Pick<FeatureRequestView, 'state' | 'choice' | 'note' | 'declineReason' | 'title'>,
  deciderName: string | null,
  locale?: string | null,
): SettledLine {
  const outcome = featureRequestOutcome(request, deciderName);
  if (!outcome) return { lead: words(locale).waitingForYou, detail: request.title, tone: 'live' };
  const approved = request.choice === 'approve' || request.choice === 'build';
  return {
    lead: approved && outcome.detail ? `${outcome.lead} · ${outcome.detail}` : outcome.lead,
    detail: request.title,
    tone: outcome.tone,
  };
}

/** `Plan · 5 of 5 done · Ship the invoice PDF`; a plan whose every step was cancelled: `Plan · Cancelled`. */
export function planLine(plan: Pick<Plan, 'steps' | 'title'>, locale?: string | null): SettledLine {
  const { done, total } = planProgress(plan);
  const w = words(locale);
  return total === 0
    ? { lead: w.planCancelled, detail: plan.title, tone: 'mut' }
    : { lead: interpolate(w.planDone, { done, total }), detail: plan.title, tone: 'ok' };
}

/** `Switched on · Daikin Altherma heat pump`; `Not switched on · …` (one-whombat-shell.md AP-1274). */
export function deviceSkillLine(
  card: Pick<DeviceSkillCard, 'status' | 'name'>,
  locale?: string | null,
): SettledLine {
  const copy = locale ? deviceSkillCopy(locale) : DEVICE_SKILL_COPY;
  return card.status === 'declined'
    ? { lead: copy.declined, detail: card.name, tone: 'mut' }
    : { lead: copy.on, detail: card.name, tone: 'ok' };
}

/**
 * `Every weekday at 08:30` with what it will do (the agent posted it, so it needn't say who); paused: `Paused · …`;
 * ended: `Done` / `Cancelled`; a schedule the viewer can't see: `Banjo scheduled a task`.
 */
export function scheduleLine(
  card: Pick<ScheduleCard, 'schedule'>,
  agentName: string,
  timeZone: string,
  /** Leaves out this year (`Sun 4 Oct`); the year shows without it. */
  nowMs?: number,
  locale?: string | null,
): SettledLine {
  const schedule = card.schedule;
  if (!schedule)
    return { lead: interpolate(words(locale).scheduledTask, { agentName }), detail: null, tone: 'mut' };
  const when = describeScheduleWhen(schedule.when, timeZone, nowMs);
  const prompt = schedule.prompt ? schedulePromptLine(schedule.prompt) : null;
  if (schedule.status === 'ended') {
    const why = schedule.endedReason
      ? SCHEDULE_END_LABELS[schedule.endedReason]
      : SCHEDULE_STATUS_LABELS.ended;
    return { lead: why, detail: prompt, tone: 'mut' };
  }
  if (schedule.status === 'paused')
    return { lead: `${SCHEDULE_STATUS_LABELS.paused} · ${when}`, detail: prompt, tone: 'warn' };
  return { lead: when, detail: prompt, tone: 'live' };
}

/** `Assessment · FB-3B50-6X0Q · Real bug · high confidence` with who chose what: `John chose “Hand to Banjo”`. */
export function assessmentLine(
  card: Pick<AssessmentCard, 'reference' | 'decided' | 'assessment'>,
  locale?: string | null,
): SettledLine {
  const w = words(locale);
  const chose = card.decided ? interpolate(w.chose, { label: card.decided.label }) : null;
  return {
    lead: interpolate(w.assessment, { reference: card.reference }),
    detail: [assessmentHeadline(card.assessment), chose].filter(Boolean).join(' · '),
    tone: 'ok',
  };
}

/** `Turn failed · Tried again at 13:02`. */
export function turnFailedLine(
  card: Pick<TurnFailedCard, 'retriedAt'>,
  timeZone: string,
  locale?: string | null,
): SettledLine {
  const w = words(locale);
  return {
    lead: w.turnFailed,
    detail: card.retriedAt
      ? interpolate(w.triedAgain, { clock: formatClock(card.retriedAt, timeZone) })
      : null,
    tone: 'mut',
  };
}

/* A one-time Find My watch ------------------------------------------------------------------------------------- */

/** A watch's dot: watching live, seen to happen ok, its Find My gone warn, stopped by someone or by time quiet. */
export const FIND_MY_WATCH_TONES = {
  watching: 'live',
  happened: 'ok',
  cancelled: 'mut',
  expired: 'mut',
  stopped: 'warn',
} as const satisfies Record<FindMyWatchStatus, SettledLine['tone']>;

/** The watch card's few words of its own, in a locale: its button, and why a Cancel didn't go through. */
export function findMyWatchWords(locale?: string | null) {
  const w = words(locale);
  return { cancel: w.watchCancel, failed: w.watchFailed };
}

/** The watch card's few words of its own: its button, and why a Cancel didn't go through (the rest is core's). */
export const FIND_MY_WATCH_WORDS = findMyWatchWords();

/**
 * An ended watch's one line, in core's words (`findMyWatchCardLines`) split at its last ` · ` the way a task's line
 * is, so what happened is the lead and when it happened the detail: “Noor Visser left Keizersgracht” · “14:05”.
 */
export function findMyWatchLine(watch: FindMyWatchView, timeZone: string, nowMs: number): SettledLine {
  const { title } = findMyWatchCardLines(watch, timeZone, nowMs);
  return watchLine(title, FIND_MY_WATCH_TONES[watch.status]);
}

export function thingWatchLine(watch: ThingWatchView, timeZone: string, nowMs: number): SettledLine {
  const { title } = thingWatchCardLines(watch, timeZone, nowMs);
  const tone = watch.status === 'happened' ? (watch.event === 'down' ? 'bad' : 'ok') : 'mut';
  return watchLine(title, tone);
}

function watchLine(title: string, tone: SettledLine['tone']): SettledLine {
  const at = title.lastIndexOf(' · ');
  return {
    lead: at < 0 ? title : title.slice(0, at),
    detail: at < 0 ? null : title.slice(at + 3),
    tone,
  };
}

/* A report's row ------------------------------------------------------------------------------------------------ */

/**
 * A Whombat Feedback report as one row (docs/decisions/report-rows.md RR-02): the dot, the lead (the assessment's
 * outcome, or where the assessment is), and one sentence — the assessment's summary once there is one, else the
 * visitor's words; then the reference and the muted facts. Its line's text is plain text (the visitor's words never
 * become Markdown, links or mentions).
 */
export interface ReportLine extends SettledLine {
  /** `FB-3B50-6X0Q`, in the mono face. */
  reference: string;
  /** After the reference, muted: `Website Feedback`, the status once it isn't New (`Resolved`), `2 screenshots`. */
  meta: string[];
  /** The detail is a placeholder (“Content removed”), not anybody's words: shown muted. */
  quiet: boolean;
  /** The row's name: `Bug report FB-3B50-6X0Q: Website Feedback · New · Confirmed bug`. */
  label: string;
}

/**
 * The dot's tone (RR-03): a bug the assessor confirmed or finds likely in the waiting tone (someone should fix it), an
 * assessment at work live, one that failed bad and one that is blocked waiting; a report resolved `ok`; the rest
 * (queued, a feature request, a duplicate, support, not enough to go on, closed) muted.
 */
export function reportTone(card: Pick<ReportCard, 'status' | 'assessment'>): SettledLine['tone'] {
  if (card.status === 'resolved') return 'ok';
  if (card.status === 'closed') return 'mut';
  switch (card.assessment.state) {
    case 'running':
      return 'live';
    case 'failed':
      return 'bad';
    case 'blocked':
      return 'warn';
    case 'done':
      return card.assessment.outcome === 'confirmed_bug' || card.assessment.outcome === 'likely_bug'
        ? 'warn'
        : 'mut';
    default:
      return 'mut';
  }
}

/**
 * `Confirmed bug · The homepage displays two redundant feedback launchers…`; before an assessment the report's type
 * (`Bug report · {the visitor's words}`), while it runs `Assessing · …`, and `Assessment failed` / `blocked` / `paused`
 * when it can't. Content removed: `… · Content removed`, quiet.
 */
export function reportLine(card: ReportCard, locale?: string | null): ReportLine {
  const { assessment } = card;
  const w = words(locale);
  let lead: string;
  if (assessment.state === 'done')
    lead = assessment.outcome ? FEEDBACK_OUTCOME_LABELS[assessment.outcome] : FEEDBACK_TYPE_LABELS[card.type];
  else if (assessment.state === 'running') lead = w.assessing;
  else if (assessment.state === 'failed' || assessment.state === 'blocked' || assessment.state === 'paused')
    lead = FEEDBACK_ASSESSMENT_STATE_LABELS[assessment.state];
  else lead = FEEDBACK_TYPE_LABELS[card.type];
  const assessed = assessment.state === 'done' ? assessment.summary?.trim() : '';
  const said = card.summary.trim();
  const detail = card.contentRemoved ? w.contentRemoved : assessed || said || null;
  return {
    lead,
    detail,
    tone: reportTone(card),
    reference: card.reference,
    meta: [
      card.product,
      card.status === 'new' ? null : FEEDBACK_STATUS_LABELS[card.status],
      card.attachments > 0 ? w.screenshots(card.attachments) : null,
    ].filter((m): m is string => !!m),
    quiet: card.contentRemoved,
    label: `${FEEDBACK_TYPE_LABELS[card.type]} ${card.reference}: ${reportCardState(card)}`,
  };
}

/**
 * Whether a message's text only repeats its report card (RR-04): the header the server posts a report with,
 * `Bug report FB-3B50-6X0Q · Website Feedback` (the type, the reference and the integration's name at the time). The
 * row says all of it, so the text doesn't show above it. Anything else someone wrote stays.
 */
export function reportHeaderOnly(text: string, card: Pick<ReportCard, 'type' | 'reference'>): boolean {
  const head = `${FEEDBACK_TYPE_LABELS[card.type]} ${card.reference}`;
  const t = text.trim();
  if (t === head) return true;
  // The integration's name may have changed since; it is at most 60 characters and one line.
  if (!t.startsWith(`${head} · `)) return false;
  const product = t.slice(head.length + 3);
  return product.length > 0 && product.length <= 60 && !/[\n\r]/.test(product);
}

/**
 * Whether a message's text only repeats its task card (AP-4302): the words the runtime writes for an app that can't show
 * the card (CT-884) — the card's line or title (“Installing 23 updates on Home Assistant · 0 s”), its result's first
 * sentence, or the card as text (`[task: …]`). Anything else someone wrote stays.
 */
export function taskTextOnly(text: string, card: Pick<TaskCard, 'title' | 'result'>): boolean {
  const t = text.trim();
  if (!t || t.startsWith('[task: ') || t.startsWith(card.title)) return true;
  const said = card.result ? taskResultLine(card.result) : '';
  return said !== '' && t.startsWith(said);
}

/**
 * Whether a message's text folds into its card (RR-04): a report's standard header, a task card's own words, a
 * resolved feature request's (its text is only for an app that doesn't know the card, Whombat report-trackers.md
 * TA-44).
 */
export function textFoldsIntoCard(text: string, card: MessageCard | null | undefined): boolean {
  if (card?.kind === 'task') return taskTextOnly(text, card);
  if (card?.kind === 'feature_request') return card.request !== null;
  return card?.kind === 'report' && reportHeaderOnly(text, card);
}

/**
 * The message's files that show beside its card: all but those the card shows itself (a council's pictures of what
 * changed, Whombat council.md CNL-33, and a delegation's tasks' pictures, delegate.md DLG-27), so no picture shows
 * twice.
 */
export function attachmentsBesideCard<A extends { id: string }>(
  attachments: readonly A[],
  card: MessageCard | null | undefined,
): readonly A[] {
  if (!attachments.length) return attachments;
  const shots =
    card?.kind === 'council'
      ? card.shots
      : card?.kind === 'delegation'
        ? card.tasks.flatMap((t) => t.shots ?? [])
        : [];
  if (!shots.length) return attachments;
  const shown = new Set<string>(shots.map((s) => s.attachmentId));
  return attachments.filter((a) => !shown.has(a.id));
}

/**
 * The words a message shows under its card, as its own words: a council's latest thoughts, then its conclusion, under the
 * card while the message's words above it say what was asked (Whombat council.md CNL-40, CNL-42).
 */
export function wordsUnderCard(card: MessageCard | null | undefined): string | null {
  // A delegation's too: the agent's intro above its checklist, its latest words and its summary under it (delegate.md).
  if (!((card?.kind === 'council' || card?.kind === 'delegation') && card.note)) return null;
  // A finished council's “The council finished.” says what its card's head says already.
  if (card.kind === 'council' && !card.live && (COUNCIL_ENDED_NOTES as readonly string[]).includes(card.note))
    return null;
  return card.note;
}

/** Whombat's own status under a council's card once it ended, which its head (“Done · Council”) already says. */
const COUNCIL_ENDED_NOTES = ['The council finished.', 'The council stopped.'] as const;

/* A server task Whombat follows ----------------------------------------------------------------------------------- */

/** A task's state as a line's tone (AP-4301): running live, done ok, with warnings warn, didn't work bad, lost muted. */
export const TASK_TONES = {
  running: 'live',
  ok: 'ok',
  warning: 'warn',
  error: 'bad',
  lost: 'mut',
} as const satisfies Record<TaskCardState, SettledLine['tone']>;

/**
 * A task card's one line (contracts CT-881; AP-4301): core's `taskCardLine` split at its last ` · `, so the lead is what
 * happened (“Home Assistant is up to date: 23 updates installed”, “Backing up web on pve-02 didn’t work: the storage is
 * full”) and the detail how long it took (“4 min”), or “lost track” for a task Whombat lost.
 */
export function taskLine(
  card: Pick<TaskCard, 'title' | 'state' | 'startedAt' | 'endedAt' | 'result'>,
  nowMs: number,
): SettledLine {
  const text = taskCardLine(card, nowMs);
  const at = text.lastIndexOf(' · ');
  return {
    lead: at < 0 ? text : text.slice(0, at),
    detail: at < 0 ? null : text.slice(at + 3),
    tone: TASK_TONES[card.state],
  };
}

/** What a task card says besides its line (AP-4300): its title, the time it ran so far or took, its state's label. */
export interface TaskCardView {
  title: string;
  /** “12 s”, “4 min”, “1 h 5 min”; null for a task Whombat lost track of (the time to giving up says nothing). */
  elapsed: string | null;
  /** “Running”, “Done”, “Done with warnings”, “Didn’t work”, “Lost track”. */
  state: string;
  /** The card's name: “Task on Home Assistant: Installing 23 updates on Home Assistant”. */
  label: string;
}

export function taskCardView(
  card: Pick<TaskCard, 'title' | 'server' | 'state' | 'startedAt' | 'endedAt'>,
  nowMs: number,
  locale?: string | null,
): TaskCardView {
  return {
    title: card.title,
    elapsed: card.state === 'lost' ? null : formatTaskDuration(taskCardElapsedMs(card, nowMs)),
    state: TASK_CARD_WORDS.states[card.state],
    label: interpolate(words(locale).taskOn, { server: card.server, title: card.title }),
  };
}

/** What a run's line shows beside its text: its pull request and diff (`+12 −8`), when it has them. */
export interface RunChips {
  prNumber: number | null;
  /** `+12 −8` with the minus sign; null when no file changed. */
  diff: string | null;
  /** `3 files`; null when no file changed. */
  files: string | null;
}

export function runChips(run: Pick<Run, 'prNumber' | 'diff'>, locale?: string | null): RunChips {
  const changed = run.diff.files > 0;
  return {
    prNumber: run.prNumber,
    diff: changed ? `+${run.diff.add} −${run.diff.del}` : null,
    files: changed ? words(locale).files(run.diff.files) : null,
  };
}

/** The compact live card's text: `Run #5 · Verify and deploy`, `Now: Running pnpm test`, and `3m 12s` so far. */
export interface RunLiveText {
  title: string;
  now: string | null;
  elapsed: string;
}

export function runLiveText(
  run: Pick<Run, 'number' | 'title' | 'activity' | 'startedAt'>,
  nowMs: number,
  locale?: string | null,
): RunLiveText {
  const activity = run.activity.trim();
  const w = words(locale);
  return {
    title: interpolate(w.runTitle, { number: run.number, title: run.title }),
    now: activity ? interpolate(w.runNow, { activity }) : null,
    elapsed: formatDuration(Math.max(0, nowMs - new Date(run.startedAt).getTime()), locale),
  };
}

/* Inside their run ---------------------------------------------------------------------------------------------- */

/** What `foldIntoRuns` needs of a message. */
export interface FoldableMessage {
  id: string;
  card?: MessageCard | null;
}

/** The run a message's card came out of, when it can show inside that run: a schedule or a deploy that carries `runId`. */
export function nestedRunId(card: MessageCard | null | undefined): string | null {
  if (!card) return null;
  if (card.kind === 'schedule') return card.runId ?? null;
  // A deploy the run did (contracts 0.55, CT-297).
  if (card.kind === 'deploy') return card.runId ?? null;
  return null;
}

export interface RunFolds<M extends FoldableMessage> {
  /** By run message id: the messages that show inside that run, oldest first. */
  inside: Map<string, M[]>;
  /** Messages the list leaves out because their run shows them. */
  hidden: Set<string>;
}

/**
 * Which messages of a list show inside their run (AP-732): a schedule or deploy card whose run card is in the same list
 * (above it). Without its run in the list — an older page, another thread — it stays a line of its own.
 */
export function foldIntoRuns<M extends FoldableMessage>(messages: readonly M[]): RunFolds<M> {
  const runMessage = new Map<string, string>();
  const inside = new Map<string, M[]>();
  const hidden = new Set<string>();
  for (const m of messages) {
    if (m.card?.kind === 'run') {
      runMessage.set(m.card.run.id, m.id);
      continue;
    }
    const runId = nestedRunId(m.card);
    const host = runId ? runMessage.get(runId) : undefined;
    if (!host) continue;
    inside.set(host, [...(inside.get(host) ?? []), m]);
    hidden.add(m.id);
  }
  return { inside, hidden };
}
