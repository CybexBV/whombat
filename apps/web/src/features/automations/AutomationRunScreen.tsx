import { useQueryClient } from '@tanstack/react-query';
import type { CommitResult } from '@whombat/client';
import {
  automationRunLabel,
  automationTrackerWords,
  problemText,
  trackerReplyOutcome,
  trackerWriteOutcome,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import {
  type Automation,
  AutomationAssessment,
  type AutomationRun,
  type AutomationRunDetail,
  type AutomationRunStep,
  assessmentLine,
  chatThreadHref,
  formatClock,
  formatRecent,
  missingAttachmentsText,
  stepKindLabel,
  type TrackerWords,
  unknownTrackerWords,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useId, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { ScreenPlaceholder } from '../../components/Placeholder';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot, StatusPill } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { liveTranslator } from '../../i18n/live';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import { usePrHref } from '../branch/usePrHref';
import { MessageText } from '../messaging/MessageRow';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import styles from './Automations.module.css';
import { RUN_STATUS, runActive, STEP_STATE } from './automationModel';
import { automationPaths, useAutomationRooms, useAutomationRun } from './hooks';
import { TrackerItemSection } from './TrackerItemSection';
import { fromTrackerItem, trackerDecisionOutcome, trackerReplySent } from './trackerItem';

export interface AutomationRunScreenProps {
  burrow: string;
  number: number;
}

/** A pull request's page on GitHub, from an `open_pull_request` step's output (“PR #215 is open: https://…”). */
export function pullRequestUrl(step: AutomationRunStep): string | null {
  if (step.kind !== 'open_pull_request') return null;
  const o = step.output as Record<string, unknown>;
  if (typeof o.url === 'string' && o.url.startsWith('https://')) return o.url;
  const found = typeof o.text === 'string' ? /https:\/\/\S+/.exec(o.text)?.[0] : undefined;
  return found ? found.replace(/[.,;)]+$/, '') : null;
}

/** What the server adds to an assessment beside its fields: the line, and a GitHub comment's parts (0.68). */
const SERVER_PARTS = new Set(['line', 'heading', 'detailsBlock']);

/**
 * An agent step's assessment (0.67, CT-323; AP-991): its line — the server's `line`, else said again with
 * `assessmentLine` — its summary, its technical details (0.68, CT-324; AP-1002: Markdown, empty without any) and
 * whether the agent recommends a change (0.71, AR-51: `recommends: 'change'`; absent on older rows is `nothing`). Null
 * when the step reported none.
 */
export function stepAssessment(
  step: AutomationRunStep,
): { line: string; summary: string; details: string; suggests: boolean } | null {
  if (step.kind !== 'dispatch_agent') return null;
  const raw = (step.output as Record<string, unknown>).assessment;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const all = raw as Record<string, unknown>;
  const fields = Object.fromEntries(Object.entries(all).filter(([key]) => !SERVER_PARTS.has(key)));
  const parsed = AutomationAssessment.safeParse(fields);
  const text =
    typeof all.line === 'string' && all.line.trim()
      ? all.line
      : parsed.success
        ? assessmentLine(parsed.data)
        : null;
  if (!text) return null;
  const said = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    line: text,
    summary: said(fields.summary),
    details: said(fields.details),
    suggests: fields.recommends === 'change',
  };
}

/**
 * What a recipe's check decided, in plain words (0.68, CT-324; AP-1003): the server's `story` (“No: Banjo says it’s not
 * a bug.”). Null for any other step, and from an older Whombat or an automation that isn't a recipe.
 */
export function conditionStory(step: AutomationRunStep): string | null {
  if (step.kind !== 'condition') return null;
  const story = (step.output as Record<string, unknown>).story;
  return typeof story === 'string' && story.trim() ? story.trim() : null;
}

/**
 * What a request for a person's yes asked (AP-1054): its title, as the card in the thread says it — “Fix #212: …”, from
 * 0.71 “Suggested change for #214: …” for a change the agent suggests. Null for any other step.
 */
export function approvalAsked(step: Pick<AutomationRunStep, 'kind' | 'output'>): string | null {
  if (step.kind !== 'request_approval') return null;
  const title = (step.output as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

/**
 * The rule a check evaluated, whole (AP-1054): the server cuts a step's input at 300 characters (299 and “…”), and
 * 0.71's “Does a person need to say yes?” is longer. The definition's own `if` — the live one, else the draft's — when
 * it is the same rule; else what the step says.
 */
export function fullRule(
  step: Pick<AutomationRunStep, 'kind' | 'stepId' | 'inputSummary'>,
  automation: Pick<Automation, 'definition' | 'draft'>,
): string {
  const shown = step.inputSummary;
  if (step.kind !== 'condition') return shown;
  const cut = shown.endsWith('…') ? shown.slice(0, -1) : null;
  for (const definition of [automation.definition, automation.draft]) {
    const own = definition?.steps.find((s) => s.id === step.stepId);
    if (own?.kind !== 'condition') continue;
    if (own.if === shown || (cut && own.if.length > cut.length && own.if.startsWith(cut))) return own.if;
  }
  return shown;
}

/** A step the run never reached: skipped without starting (a check stopped the run before it). */
const unreached = (step: AutomationRunStep) => step.state === 'skipped' && step.startedAt === null;

/**
 * The steps a finished run lists (AP-1004): when its last steps were all skipped without starting — a check stopped
 * it — two or more of them fold into one line (`skipped`); a single one, and every step that ran, stay as they are.
 */
export function foldSkipped(run: Pick<AutomationRun, 'status' | 'steps'>): {
  shown: AutomationRunStep[];
  skipped: AutomationRunStep[];
} {
  const all = run.steps;
  if (runActive(run.status)) return { shown: all, skipped: [] };
  let end = all.length;
  while (end > 0 && unreached(all[end - 1] as AutomationRunStep)) end--;
  return all.length - end >= 2
    ? { shown: all.slice(0, end), skipped: all.slice(end) }
    : { shown: all, skipped: [] };
}

/** The tag beside an assessment's line when the agent recommends a change, in English (the screen reads its own). */
export const SUGGESTS_A_CHANGE = 'Suggests a change';

/** “8 more steps skipped” (two or more: one is shown as itself). */
export const skippedLine = (n: number) => liveTranslator().tp('automations.run.skipped', n);

/**
 * What a step produced, in a sentence or two (full agent text in the box below it). `steps`: the run's, so a condition
 * that skipped ahead says where it went on (AP-992); `words`: the tracker's, for a tracker step that doesn't name its
 * connection.
 */
export function stepOutcome(
  step: AutomationRunStep,
  nameOf: (id: string) => string,
  steps: readonly AutomationRunStep[] = [],
  words: TrackerWords = unknownTrackerWords(currentLocale()),
): string | null {
  const o = step.output as Record<string, unknown>;
  const { t, tp } = liveTranslator();
  switch (step.kind) {
    case 'request_approval': {
      const by = typeof o.decidedById === 'string' ? nameOf(o.decidedById) : null;
      if (o.decision === 'approved')
        return by ? t('automations.outcome.approvedBy', { name: by }) : t('automations.outcome.approved');
      if (o.decision === 'declined')
        return by ? t('automations.outcome.declinedBy', { name: by }) : t('automations.outcome.declined');
      return null;
    }
    case 'condition': {
      if (typeof o.result !== 'boolean') return null;
      // A step named as a question (“A bug worth fixing?”) is answered Yes or No.
      const question = step.name.trim().endsWith('?');
      if (o.result) return t(question ? 'automations.outcome.yesWentOn' : 'automations.outcome.trueWentOn');
      // Skipped ahead (`else: {skipTo}`): the first later step that wasn't skipped is where it went on.
      const next = steps.find((s) => s.index > step.index && s.state !== 'skipped');
      if (next)
        return t(question ? 'automations.outcome.noSkippedTo' : 'automations.outcome.falseSkippedTo', {
          step: next.name,
        });
      return t(question ? 'automations.outcome.noStopped' : 'automations.outcome.falseStopped');
    }
    case 'wait':
      return typeof o.waited === 'number' ? t('automations.outcome.waited', { n: String(o.waited) }) : null;
    case 'open_pull_request':
      if (o.opened === true && typeof o.prNumber === 'number')
        return t('automations.outcome.openedPr', { n: String(o.prNumber) });
      return typeof o.text === 'string' ? `${o.text.charAt(0).toUpperCase()}${o.text.slice(1)}.` : null;
    case 'http_callback':
      return typeof o.status === 'number'
        ? t('automations.outcome.answered', { status: String(o.status) })
        : null;
    case 'github_comment':
      // 0.66 (AP-974): the comment on the issue or pull request, or why it was left out.
      if (typeof o.reason === 'string' && o.reason) return o.reason;
      return typeof o.number === 'number'
        ? t('automations.outcome.commented', { n: String(o.number) })
        : null;
    case 'tracker_update':
      // 0.69 (AP-1026): what it wrote on the report, or why it wrote nothing.
      return trackerWriteOutcome(o, words);
    case 'tracker_reply':
      // 0.75 (AP-1110): that it answered the customer and the status in the tracker's words, or why it sent nothing.
      return trackerReplyOutcome(o, words);
    case 'tracker_decision':
      // 3.12: what the person decided, that it waits for them, or why it was skipped.
      return trackerDecisionOutcome(step);
    case 'connection_actions':
      if (typeof o.summary === 'string' && o.summary) return o.summary;
      if (typeof o.reason === 'string' && o.reason) return o.reason;
      return null;
    case 'run_action':
      // What it did and how it came out, in one line (“Shut down nas-01 at 21:14 — it’s switching off.”).
      return typeof o.summary === 'string' && o.summary ? o.summary : null;
    case 'dispatch_agent': {
      // Coding work and reviews (bp-automations BP-C26, BP-C27).
      const ws = o.workspace as { branch?: string } | undefined;
      const parts: string[] = [];
      if (typeof o.commits === 'number')
        parts.push(
          tp('automations.outcome.commits', o.commits, {
            branch: ws?.branch ?? t('automations.outcome.itsBranch'),
          }),
        );
      if (o.verdict === 'approve') parts.push(t('automations.outcome.approve'));
      if (o.verdict === 'changes_needed') parts.push(t('automations.outcome.changesNeeded'));
      return parts.length ? parts.join(' ') : null;
    }
    default:
      return null;
  }
}

/**
 * An automation run (docs/decisions/bp-automations.md BP-C13): its steps as a timeline with their state, what
 * went in and what came out, links to the dispatches' agents and runs, the approval, the messages and the PR, and
 * Pause / Resume / Cancel. A step whose outcome is uncertain after a crash waits for a person to say what happened.
 */
export function AutomationRunScreen({ burrow, number }: AutomationRunScreenProps) {
  const { t, tag: uiLocale, locale } = useWebI18n();
  const params = { burrow, number };
  const { data, error, isPending, refetch } = useAutomationRun({ params });
  const { rooms } = useAutomationRooms(burrow);
  const viewer = useBurrowViewer(burrow);
  const prHref = usePrHref(burrow);
  const navigate = useNavigateHref();
  const toast = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  // The steps a stopped run never reached, folded into one line until someone opens it (AP-1004).
  const [showSkipped, setShowSkipped] = useState(false);
  const pause = useApiMutation(api.automations.pauseRun);
  const resume = useApiMutation(api.automations.resumeRun);
  const cancel = useApiMutation(api.automations.cancelRun);
  const review = useApiMutation(api.automations.reviewStep);

  if (!data) {
    if (isPending)
      return (
        <section className={styles.scroll} aria-busy="true">
          <div className={styles.page}>
            <SkeletonRows count={5} lines={2} />
          </div>
        </section>
      );
    const notFound = error && 'status' in error && error.status === 404;
    return (
      <ScreenPlaceholder
        screen="automation-run"
        title={t('automations.run.title', { n: String(number) })}
        subtitle={t(notFound ? 'automations.run.notFound' : 'automations.run.loadFailed')}
      >
        {!notFound && (
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            {t('automations.run.retry')}
          </Button>
        )}
      </ScreenPlaceholder>
    );
  }

  const { run, automation } = data;
  const status = RUN_STATUS[run.status];
  // The run's thread in the room it answered in: Chat or Feedback (one-agent.md AP-4931).
  const room = rooms.find((r) => r.id === run.conversationId);
  const threadHref = room && run.threadRootId ? chatThreadHref(room.room, run.threadRootId) : null;
  const now = new Date();
  const { shown, skipped } = foldSkipped(run);
  // The tracker's words the automation keeps, for its report and its tracker steps.
  const words = automationTrackerWords(automation);

  const done = (message: string) => (res: CommitResult<AutomationRunDetail>) => {
    if (res.status === 'ok') {
      qc.setQueryData(queryKeys.automations.run({ params }), res.data);
      toast.show(message);
    } else toast.show(res.status === 'blocked' ? res.message : t('automations.run.needsApproval'));
  };
  const control = (action: 'pause' | 'resume' | 'cancel') => {
    const m = action === 'pause' ? pause : action === 'resume' ? resume : cancel;
    setPending(action);
    m.mutate(
      { params },
      {
        onSuccess: done(
          t(
            action === 'pause'
              ? 'automations.run.pausedNote'
              : action === 'resume'
                ? 'automations.run.resumedNote'
                : 'automations.run.stoppedNote',
          ),
        ),
        onError: (err) => toast.show(problemText(err, undefined, uiLocale)),
        onSettled: () => setPending(null),
      },
    );
  };
  const settle = (step: AutomationRunStep, resolution: 'done' | 'failed' | 'retry') => {
    setPending(`review:${step.stepId}`);
    review.mutate(
      { params: { ...params, stepId: step.stepId }, body: { resolution } },
      {
        onSuccess: done(
          t(resolution === 'retry' ? 'automations.run.retryNote' : 'automations.run.goesOnNote'),
        ),
        onError: (err) => toast.show(problemText(err, undefined, uiLocale)),
        onSettled: () => setPending(null),
      },
    );
  };

  const stepItem = (step: AutomationRunStep) => (
    <StepItem
      key={step.stepId}
      run={run}
      rule={fullRule(step, automation)}
      step={step}
      words={words}
      timeZone={viewer.timeZone}
      nameOf={viewer.shortName}
      threadHref={threadHref}
      canReview
      pending={pending === `review:${step.stepId}`}
      prHref={prHref}
      onNavigate={navigate}
      onSettle={(r) => settle(step, r)}
    />
  );

  return (
    <div className={styles.scroll} data-screen="automation-run">
      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <div className={styles.kicker}>
              {automation.deletedAt ? (
                <span>{automation.name.toUpperCase()}</span>
              ) : (
                <a
                  className={styles.back}
                  href={automationPaths.one(automation.id)}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(automationPaths.one(automation.id));
                  }}
                >
                  {automation.name.toUpperCase()}
                </a>
              )}
              <span aria-hidden="true">/</span>
              <span>
                {t('automations.run.kicker', { n: String(run.number) })}
                {run.test ? ` ${t('automations.run.kickerTest')}` : ''}{' '}
                {t('automations.run.kickerVersion', {
                  version: run.version ? String(run.version) : t('automations.run.draft'),
                })}
              </span>
            </div>
            <h1 className={styles.title}>{t('automations.run.heading', { n: String(run.number) })}</h1>
            <p className={styles.subtitle}>
              {run.trigger.summary} ·{' '}
              {formatRecent(run.startedAt ?? run.createdAt, now, viewer.timeZone, uiLocale)}
              {run.tokens !== null
                ? ` ${t('automations.run.tokens', { n: run.tokens.toLocaleString(locale) })}`
                : ''}
            </p>
          </div>
          <div className={styles.actions}>
            <StatusPill tone={status.tone}>{automationRunLabel(run)}</StatusPill>
            {threadHref && (
              <Button variant="secondary" onClick={() => navigate(threadHref)}>
                {t('automations.run.openThread')}
              </Button>
            )}
            {runActive(run.status) && run.status !== 'paused' && run.status !== 'needs_review' && (
              <Button variant="secondary" disabled={pending !== null} onClick={() => control('pause')}>
                {t('automations.run.pause')}
              </Button>
            )}
            {run.status === 'paused' && (
              <Button variant="secondary" disabled={pending !== null} onClick={() => control('resume')}>
                {t('automations.run.resume')}
              </Button>
            )}
            {runActive(run.status) && (
              <Button variant="secondary" disabled={pending !== null} onClick={() => control('cancel')}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </div>

        {automation.deletedAt && (
          <p className={styles.note} data-automation-deleted="">
            {t('automations.run.deleted')}
          </p>
        )}
        {run.error && (
          <p
            className={`${styles.note} ${run.status === 'failed' || run.status === 'needs_review' ? styles.noteBad : styles.noteWarn}`}
          >
            {run.error}
          </p>
        )}
        {run.missingAttachments?.length || run.missingAttachmentsOmitted ? (
          <p className={`${styles.note} ${styles.noteWarn}`} data-missing-attachments="">
            {missingAttachmentsText(run.missingAttachments ?? [], run.missingAttachmentsOmitted ?? 0)}
          </p>
        ) : null}

        {fromTrackerItem(run) && (
          <TrackerItemSection burrow={burrow} runId={run.id} timeZone={viewer.timeZone} words={words} />
        )}

        <section className={styles.section} aria-labelledby="run-steps">
          <SectionLabel as="h2" id="run-steps">
            {t('automations.run.steps')}
          </SectionLabel>
          <div className={styles.card}>
            <ol className={styles.timeline} aria-label={t('automations.run.stepsLabel')}>
              {shown.map(stepItem)}
              {skipped.length > 0 && (
                <li className={styles.timelineItem} data-skipped-steps="">
                  <StatusDot className={styles.timelineDot} tone="mut" label={null} />
                  <div className={styles.timelineBody}>
                    <button
                      type="button"
                      className={styles.disclosure}
                      aria-expanded={showSkipped}
                      onClick={() => setShowSkipped((open) => !open)}
                    >
                      <Icon name="chevronDown" size={15} className={styles.chevron} />
                      {skippedLine(skipped.length)}
                    </button>
                  </div>
                </li>
              )}
              {showSkipped && skipped.map(stepItem)}
            </ol>
          </div>
        </section>
      </div>
    </div>
  );
}

function StepItem({
  run,
  rule,
  step,
  words,
  timeZone,
  nameOf,
  threadHref,
  canReview,
  pending,
  prHref,
  onNavigate,
  onSettle,
}: {
  run: AutomationRun;
  /** A check's rule, whole (`fullRule`). */
  rule: string;
  step: AutomationRunStep;
  /** The tracker's words, for a tracker step's outcome. */
  words: TrackerWords;
  timeZone: string;
  nameOf: (id: string) => string;
  threadHref: string | null;
  canReview: boolean;
  pending: boolean;
  /** The branch room of a PR number (its repo when known, AP-497). */
  prHref: (number: number) => string;
  onNavigate: (href: string) => void;
  onSettle: (resolution: 'done' | 'failed' | 'retry') => void;
}) {
  const { t } = useWebI18n();
  const state = STEP_STATE[step.state];
  const o = step.output as Record<string, unknown>;
  // A comment repeats the agent's answer above it: its outcome line says where it went instead. A write-back to the
  // tracker says what it wrote in its outcome line too (AP-1026), and a reply to the customer what it sent (AP-1110).
  // An action Whombat did itself says it once, in its outcome line.
  const text =
    typeof o.text === 'string' &&
    step.kind !== 'open_pull_request' &&
    step.kind !== 'github_comment' &&
    step.kind !== 'tracker_update' &&
    step.kind !== 'tracker_reply' &&
    step.kind !== 'run_action'
      ? o.text
      : null;
  // What the customer read, signature included, as plain text: the tracker emails it as it is (AP-1110).
  const sent = step.kind === 'tracker_reply' ? trackerReplySent(o) : null;
  const commentUrl =
    step.kind === 'github_comment' && typeof o.url === 'string' && o.url.startsWith('https://')
      ? o.url
      : null;
  const outcome = stepOutcome(step, nameOf, run.steps, words);
  // A recipe's check says what it decided in words; its rule stays one click away (AP-1003).
  const story = conditionStory(step);
  // What a request for a person's yes asks, in the card's words (AP-1054).
  const asked = approvalAsked(step);
  const assessment = stepAssessment(step);
  const prUrl = pullRequestUrl(step);
  // A request waiting for a person is the thing to do on this page: a button that opens it (AP-993).
  const approvalHref = step.approvalNumber
    ? `${automationPaths.run(run.number)}?approval=${step.approvalNumber}`
    : null;
  const awaiting = step.state === 'waiting' && approvalHref !== null;
  const link = (href: string, label: string) => (
    <a
      key={href}
      className={styles.stepLink}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(href);
      }}
    >
      {label}
    </a>
  );
  const links = [
    ...(step.messageIds.length && threadHref ? [link(threadHref, t('automations.run.messages'))] : []),
    ...(approvalHref && !awaiting
      ? [link(approvalHref, t('automations.run.request', { n: String(step.approvalNumber) }))]
      : []),
    ...step.runNumbers.map((n) => link(`/runs/${n}`, t('automations.run.agentRun', { n: String(n) }))),
    ...(step.prNumber ? [link(prHref(step.prNumber), `PR #${step.prNumber}`)] : []),
    ...(prUrl
      ? [
          <a key={prUrl} className={styles.stepLink} href={prUrl} target="_blank" rel="noreferrer">
            {t('automations.run.prOnGitHub')}
          </a>,
        ]
      : []),
    ...(commentUrl
      ? [
          <a key={commentUrl} className={styles.stepLink} href={commentUrl} target="_blank" rel="noreferrer">
            {t('automations.run.commentOnGitHub')}
          </a>,
        ]
      : []),
  ];
  const agentName = typeof o.agentId === 'string' ? nameOf(o.agentId) : null;
  return (
    <li className={styles.timelineItem}>
      <StatusDot className={styles.timelineDot} tone={state.tone} label={state.label} />
      <div className={styles.timelineBody}>
        <div className={styles.timelineHead}>
          {/* A step of a kind this version doesn't know (an older version's) is “An earlier step” without a name. */}
          <span className={styles.timelineName}>{step.name.trim() || stepKindLabel(step.kind)}</span>
          <span className={styles.mono}>
            {state.label.toUpperCase()}
            {step.attempt > 0 ? ` ${t('automations.run.try', { n: String(step.attempt + 1) })}` : ''}
            {step.finishedAt
              ? ` · ${formatClock(step.finishedAt, timeZone)}`
              : step.startedAt
                ? ` · ${formatClock(step.startedAt, timeZone)}`
                : ''}
            {step.state === 'waiting' && step.wakeAt
              ? ` ${t('automations.run.until', { clock: formatClock(step.wakeAt, timeZone) })}`
              : ''}
          </span>
        </div>
        {/* A feature request's step says its input as its outcome: once is enough. */}
        {(step.inputSummary || agentName) && !story && step.kind !== 'tracker_decision' && (
          // A condition's input is its expression: shown as code (AP-992).
          <span
            className={step.kind === 'condition' ? `${styles.rowMeta} ${styles.expression}` : styles.rowMeta}
          >
            {step.inputSummary || t('automations.run.asked', { name: agentName ?? '' })}
          </span>
        )}
        {asked && (
          <p className={styles.story} data-step-asked="">
            {asked}
          </p>
        )}
        {story ? (
          <ConditionStory story={story} rule={rule} />
        ) : (
          outcome && (
            // An action's line is the whole of what happened: it wraps rather than being cut off on a phone.
            <span className={step.kind === 'run_action' ? styles.rowMetaWrap : styles.rowMeta}>
              {outcome}
            </span>
          )
        )}
        {assessment && (
          <div className={styles.assessment} data-step-assessment="">
            <ul
              className={styles.assessmentLine}
              aria-label={t('automations.run.assessment', {
                line: `${assessment.line}${assessment.suggests ? ` · ${t('automations.run.suggestsChange').toLowerCase()}` : ''}`,
              })}
            >
              {/* The line's parts differ (kind, importance, confidence, size), so each is its own key. */}
              {assessment.line.split(' · ').map((part, i) => (
                <li key={part}>
                  <Tag tone={i === 0 ? 'ink' : undefined}>{part}</Tag>
                </li>
              ))}
              {/* The agent recommends a change (AP-1053): what the card in the thread offers. */}
              {assessment.suggests && (
                <li data-suggests="">
                  <Tag tone="brand">{t('automations.run.suggestsChange')}</Tag>
                </li>
              )}
            </ul>
            {assessment.summary && <p className={styles.assessmentSummary}>{assessment.summary}</p>}
          </div>
        )}
        {/* What the agent said, with the message renderer chat uses (never raw markup). */}
        {text && <MessageText text={text} className={styles.output} />}
        {sent && (
          <p className={styles.output} data-step-reply="">
            {sent}
          </p>
        )}
        {/* The technical part of an assessment, folded under the plain answer (AP-1002). */}
        {assessment?.details && (
          <details className={styles.techDetails} data-step-details="">
            <summary>
              <Icon name="chevronDown" size={15} className={styles.chevron} />
              {t('automations.run.technicalDetails')}
            </summary>
            <MessageText text={assessment.details} className={styles.detailsText} />
          </details>
        )}
        {step.error && <span className={styles.error}>{step.error}</span>}
        {links.length > 0 && <div className={styles.links}>{links}</div>}
        {awaiting && approvalHref && (
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={() => onNavigate(approvalHref)}>
              {t('automations.run.reviewRequest', { n: String(step.approvalNumber) })}
            </Button>
          </div>
        )}
        {step.state === 'uncertain' && canReview && run.status === 'needs_review' && (
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => onSettle('done')}>
              {t('automations.run.happened')}
            </Button>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => onSettle('failed')}>
              {t('automations.run.didntHappen')}
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => onSettle('retry')}>
              {t('automations.run.tryAgain')}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** A recipe's check in plain words, and a toggle that shows the rule it evaluated (AP-1003). */
function ConditionStory({ story, rule }: { story: string; rule: string }) {
  const { t } = useWebI18n();
  const [open, setOpen] = useState(false);
  const ruleId = useId();
  return (
    <>
      <p className={styles.story}>{story}</p>
      {rule && (
        <>
          <button
            type="button"
            className={`${styles.disclosure} ${styles.disclosureSmall}`}
            aria-expanded={open}
            aria-controls={ruleId}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="chevronDown" size={14} className={styles.chevron} />
            {t('automations.run.showRule')}
          </button>
          <code id={ruleId} className={styles.rule} hidden={!open}>
            {rule}
          </code>
        </>
      )}
    </>
  );
}
