/**
 * The job view (Whombat docs/decisions/t3code.md T3-30…T3-41; docs/app/decisions/job-view.md): a job handed to T3 Code,
 * in words and rows the web and the phone draw alike — T3 Code's plan, its pull request, what it changed, the pull
 * request's checks with the fix attempts, the question it waits on, the box to steer it, and the receipt and T3 Code's
 * whole answer once it ended — and which of its moments are worth a notification. Every part is null or empty where the
 * box gave nothing: the apps hide it. Pure, no DOM and no React Native.
 */
import {
  HANDOFF_ANSWER_MAX,
  type Handoff,
  type HandoffCheckState,
  type HandoffPlanStep,
  type HandoffPullRequest,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { handoffMinutes, pullRequestLabel, T3_CODE_NAME } from './handoff';
import { clientTree } from './i18n/catalog';
import { WORK_AREA_WORDS } from './i18n/messages/chatWork/work';

/** The job view's words, in a locale (English when none). */
export function jobWords(locale?: string | null) {
  const w = clientTree(locale, WORK_AREA_WORDS).job;
  const t3 = T3_CODE_NAME;
  return {
    /** Waiting for its pull request's checks, after “T3 Code ·” in a row. */
    waitingChecks: w.waitingChecks,
    waitingChecksOn: (pr: string) => interpolate(w.waitingChecksOn, { pr }),
    fixing: w.fixing,
    plan: {
      title: w.plan.title,
      count: (done: number, of: number) => interpolate(w.plan.count, { done, of }),
      show: w.plan.show,
      hide: w.plan.hide,
      state: { done: w.plan.state.done, now: w.plan.state.now, next: w.plan.state.next } satisfies Record<
        HandoffPlanStep['state'],
        string
      >,
    },
    pullRequest: {
      title: w.pullRequest.title,
      state: {
        open: w.pullRequest.state.open,
        draft: w.pullRequest.state.draft,
        merged: w.pullRequest.state.merged,
        closed: w.pullRequest.state.closed,
      } satisfies Record<HandoffPullRequest['state'], string>,
      line: (n: number, state: string) => `#${n} · ${state}`,
      spoken: (n: number, state: string) => interpolate(w.pullRequest.spoken, { n, state }),
    },
    changes: {
      title: w.changes.title,
      summary: (files: number, plus: number, minus: number) => w.changes.summary(files, { plus, minus }),
      more: (n: number) => w.changes.more(n),
      open: w.changes.open,
      spokenFile: (path: string, plus: number, minus: number) =>
        interpolate(w.changes.spokenFile, { path, plus, minus }),
    },
    checks: {
      title: w.checks.title,
      state: {
        queued: w.checks.state.queued,
        running: w.checks.state.running,
        passed: w.checks.state.passed,
        failed: w.checks.state.failed,
        skipped: w.checks.state.skipped,
      } satisfies Record<HandoffCheckState, string>,
      count: (passed: number, of: number) => interpolate(w.checks.count, { passed, of }),
      fixing: (attempt: number) => interpolate(w.checks.fixing, { t3, attempt }),
      failed: (name: string) => interpolate(w.checks.failed, { name }),
    },
    question: {
      title: interpolate(w.question.title, { t3 }),
      answered: (label: string) => interpolate(w.question.answered, { label }),
      failed: w.question.failed,
    },
    message: {
      open: interpolate(w.message.open, { t3 }),
      placeholder: interpolate(w.message.placeholder, { t3 }),
      now: w.message.now,
      next: w.message.next,
      nowHint: w.message.nowHint,
      nextHint: w.message.nextHint,
      sentNow: interpolate(w.message.sentNow, { t3 }),
      sentNext: interpolate(w.message.sentNext, { t3 }),
      failed: w.message.failed,
      close: w.message.close,
    },
    receipt: {
      title: {
        completed: w.receipt.title.completed,
        merged: w.receipt.title.merged,
        failed: w.receipt.title.failed,
        stopped: w.receipt.title.stopped,
      },
      testsPassed: w.receipt.testsPassed,
      testsFailed: w.receipt.testsFailed,
      pullRequest: (label: string, state: string) => interpolate(w.receipt.pullRequest, { label, state }),
      prState: {
        open: w.receipt.prState.open,
        draft: w.receipt.prState.draft,
        merged: w.receipt.prState.merged,
        closed: w.receipt.prState.closed,
      },
      took: (time: string) => interpolate(w.receipt.took, { time }),
      screenshot: w.receipt.screenshot,
    },
    /** T3 Code's whole answer under the receipt, folded until the person opens it. */
    answer: {
      read: w.answer.read,
      hide: w.answer.hide,
      rest: interpolate(w.answer.rest, { t3 }),
    },
    /** A phone notification's words, one per moment worth one. */
    notice: {
      needsYou: (title: string) => interpolate(w.notice.needsYou, { title, t3 }),
      done: (title: string) => interpolate(w.notice.done, { title }),
      failed: (title: string) => interpolate(w.notice.failed, { title }),
    },
  };
}

/** The job view's words, in English. */
export const JOB_WORDS = jobWords();

const wordsIn = (locale?: string | null) => (locale ? jobWords(locale) : JOB_WORDS);

/** `40s`, `6m`, `1h 05m`: how long a job took. */
export function stageTime(durationMs: number): string {
  if (durationMs < 60_000) return `${Math.max(1, Math.round(durationMs / 1000))}s`;
  return handoffMinutes(0, durationMs);
}

/** The job's title without the assistant's one-word name the box puts in front (“Dusty - Fix it” → “Fix it”). */
export const jobTitle = (h: Pick<Handoff, 'title'>): string =>
  h.title.replace(/^\S{1,30} [-–:] +/, '') || h.title;

/**
 * The ended job's result is a message in the thread (`Handoff.resultMessageId`): the message says how it went, with the
 * facts under it, so the job draws no receipt, answer or parts of its own.
 */
export const jobInMessage = (h: Pick<Handoff, 'state' | 'resultMessageId'>): boolean =>
  h.state === 'ended' && !!h.resultMessageId;

const live = (h: Handoff) =>
  h.state === 'working' || h.state === 'finishing' || h.state === 'asked' || h.state === 'needs_ok';

/* The plan ------------------------------------------------------------------------------------------------------------ */

export interface JobPlan {
  rows: { text: string; state: HandoffPlanStep['state']; spoken: string }[];
  /** `2 of 4 done`. */
  count: string;
  /** Open by default while the job works. */
  open: boolean;
}

export function jobPlan(h: Handoff, locale?: string | null): JobPlan | null {
  const JOB_WORDS = wordsIn(locale);
  const plan = h.plan ?? [];
  if (!plan.length || jobInMessage(h)) return null;
  return {
    rows: plan.map((p) => ({ ...p, spoken: `${p.text}, ${JOB_WORDS.plan.state[p.state]}` })),
    count: JOB_WORDS.plan.count(plan.filter((p) => p.state === 'done').length, plan.length),
    open: live(h),
  };
}

/* The pull request --------------------------------------------------------------------------------------------------- */

export interface JobPullRequest {
  /** `#48 · open`, `#48 · merged`. */
  text: string;
  state: HandoffPullRequest['state'];
  url: string;
  /** For a screen reader: “Pull request #48, merged”. */
  spoken: string;
}

/**
 * The job's pull request and whether it is merged, as GitHub says, until the receipt says it; null without one. Facts
 * only: what the job does before it has one is its step, in T3 Code's line.
 */
export function jobPullRequest(h: Handoff, locale?: string | null): JobPullRequest | null {
  const JOB_WORDS = wordsIn(locale);
  const pr = h.pullRequest ?? null;
  if (!pr || jobReceipt(h) || jobInMessage(h)) return null;
  const state = JOB_WORDS.pullRequest.state[pr.state];
  return {
    text: JOB_WORDS.pullRequest.line(pr.number, state),
    state: pr.state,
    url: pr.url,
    spoken: JOB_WORDS.pullRequest.spoken(pr.number, state),
  };
}

/* Changes -------------------------------------------------------------------------------------------------------------- */

export interface JobChanges {
  /** `12 files · +340 −58`. */
  summary: string;
  /** The pull request's title: the change in one line. */
  title: string | null;
  files: { path: string; name: string; dir: string; plus: string; minus: string; spoken: string }[];
  /** `7 more files`, when the list is shorter than the count. */
  more: string | null;
  /** The pull request's Files page. */
  url: string | null;
}

/** What the job changed; `shown`: how many files the list shows (the rest are counted). */
export function jobChanges(h: Handoff, shown = 20, locale?: string | null): JobChanges | null {
  const JOB_WORDS = wordsIn(locale);
  const c = h.changes ?? null;
  if (!c || jobInMessage(h)) return null;
  const files = c.files.slice(0, shown).map((f) => {
    const parts = f.path.split('/');
    const name = parts.pop() ?? f.path;
    return {
      path: f.path,
      name,
      dir: parts.length ? `${parts.join('/')}/` : '',
      plus: `+${f.additions}`,
      minus: `−${f.deletions}`,
      spoken: JOB_WORDS.changes.spokenFile(f.path, f.additions, f.deletions),
    };
  });
  const rest = c.fileCount - files.length;
  return {
    summary: JOB_WORDS.changes.summary(c.fileCount, c.additions, c.deletions),
    title: c.summary,
    files,
    more: rest > 0 ? JOB_WORDS.changes.more(rest) : null,
    url: c.url,
  };
}

/* Checks --------------------------------------------------------------------------------------------------------------- */

export interface JobChecks {
  rows: {
    name: string;
    state: HandoffCheckState;
    word: string;
    tone: 'ok' | 'bad' | 'live' | 'quiet';
    url: string | null;
  }[];
  /** `3 of 4 passed`. */
  count: string;
  /** `T3 Code is fixing it · attempt 2` while it works on a failed check, `Unit tests failed` otherwise. */
  failure: string | null;
  tone: 'ok' | 'bad' | 'live';
}

const CHECK_TONE: Record<HandoffCheckState, JobChecks['rows'][number]['tone']> = {
  passed: 'ok',
  failed: 'bad',
  running: 'live',
  queued: 'quiet',
  skipped: 'quiet',
};

export function jobChecks(h: Handoff, locale?: string | null): JobChecks | null {
  const JOB_WORDS = wordsIn(locale);
  const c = h.checks ?? null;
  if (!c?.runs.length || jobInMessage(h)) return null;
  const rows = c.runs.map((r) => ({
    name: r.name,
    state: r.state,
    word: JOB_WORDS.checks.state[r.state],
    tone: CHECK_TONE[r.state],
    url: r.url,
  }));
  const passed = c.runs.filter((r) => r.state === 'passed' || r.state === 'skipped').length;
  const failure = c.failing
    ? live(h)
      ? JOB_WORDS.checks.fixing(c.attempts + 1)
      : JOB_WORDS.checks.failed(c.failing)
    : null;
  return {
    rows,
    count: JOB_WORDS.checks.count(passed, c.runs.length),
    failure,
    tone: c.failing || rows.some((r) => r.tone === 'bad') ? 'bad' : passed === c.runs.length ? 'ok' : 'live',
  };
}

/* The question ------------------------------------------------------------------------------------------------------ */

export interface JobQuestion {
  handoffId: string;
  requestId: string;
  text: string;
  /** Each option as a button; its `answers` is what `conversations.handoffAnswer` sends. */
  options: { label: string; description: string | null; answers: Record<string, string> }[];
  multiSelect: boolean;
}

/** The question the job waits on, while it does. */
export function jobQuestion(h: Handoff): JobQuestion | null {
  const q = h.question ?? null;
  if (!q || h.state !== 'asked') return null;
  return {
    handoffId: h.id,
    requestId: q.requestId,
    text: q.text,
    options: q.options.map((o) => ({ ...o, answers: { [q.questionId]: o.label } })),
    multiSelect: q.multiSelect,
  };
}

/** Whether the steer box shows: the box knows the job's actions (it gave a stage) and the job isn't over. */
export const jobCanMessage = (h: Handoff): boolean => h.stage !== undefined && h.state !== 'ended';

/* Where the parts go ---------------------------------------------------------------------------------------------- */

/**
 * The message a thread draws an ended job's parts under, or null for the thread's end. While the job works, and after
 * it ended until someone wrote, they are the thread's last; once the chat went on they stay under the last message from
 * before it ended, so the receipt reads where the job finished and the newest messages stay last. `messages` are the
 * thread's rows as drawn, oldest first (a row folded into another isn't one).
 */
export function jobPartsAfter(
  h: Pick<Handoff, 'state' | 'endedAt'>,
  messages: readonly { id: string; at: string }[],
): string | null {
  if (h.state !== 'ended' || !h.endedAt) return null;
  const ended = Date.parse(h.endedAt);
  if (!Number.isFinite(ended)) return null;
  let before: string | null = null;
  for (const m of messages) {
    if (Date.parse(m.at) > ended) return before;
    before = m.id;
  }
  return null;
}

/* The receipt ---------------------------------------------------------------------------------------------------------- */

export interface JobReceipt {
  title: string;
  tone: 'ok' | 'bad' | 'quiet';
  summary: string | null;
  lines: {
    key: 'tests' | 'pullRequest' | 'model' | 'time';
    text: string;
    tone: 'ok' | 'bad' | null;
    url: string | null;
  }[];
  screenshot: { url: string; alt: string } | null;
}

export function jobReceipt(h: Handoff, locale?: string | null): JobReceipt | null {
  const JOB_WORDS = wordsIn(locale);
  const r = h.receipt ?? null;
  if (!r || h.state !== 'ended' || jobInMessage(h)) return null;
  const merged = h.pullRequest?.state === 'merged';
  const title =
    h.outcome === 'failed'
      ? JOB_WORDS.receipt.title.failed
      : h.outcome === 'stopped'
        ? JOB_WORDS.receipt.title.stopped
        : merged
          ? JOB_WORDS.receipt.title.merged
          : JOB_WORDS.receipt.title.completed;
  const lines: JobReceipt['lines'] = [];
  if (r.tests)
    lines.push({
      key: 'tests',
      text: r.tests === 'passed' ? JOB_WORDS.receipt.testsPassed : JOB_WORDS.receipt.testsFailed,
      tone: r.tests === 'passed' ? 'ok' : 'bad',
      url: null,
    });
  if (h.pullRequest)
    lines.push({
      key: 'pullRequest',
      text: JOB_WORDS.receipt.pullRequest(
        `#${h.pullRequest.number}`,
        JOB_WORDS.receipt.prState[h.pullRequest.state],
      ),
      tone: null,
      url: h.pullRequest.url,
    });
  if (h.program) lines.push({ key: 'model', text: h.program, tone: null, url: null });
  if (r.durationMs !== null)
    lines.push({ key: 'time', text: JOB_WORDS.receipt.took(stageTime(r.durationMs)), tone: null, url: null });
  return {
    title,
    tone: h.outcome === 'failed' ? 'bad' : h.outcome === 'stopped' ? 'quiet' : 'ok',
    summary: r.summary,
    lines,
    screenshot: r.screenshot,
  };
}

/* The answer ----------------------------------------------------------------------------------------------------------- */

export interface JobAnswer {
  /** What T3 Code answered, as it wrote it (markdown). */
  text: string;
  /** The thread keeps only its start: the rest is in T3 Code (`url`, when the box knows the thread's page). */
  cut: boolean;
  url: string | null;
}

const squeezed = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The ended job's whole answer to read in the thread, or null: the box gave none, the job isn't over, or the receipt's
 * line already says all of it.
 */
export function jobAnswer(h: Handoff): JobAnswer | null {
  const text = h.answer?.trim();
  if (!text || h.state !== 'ended' || jobInMessage(h)) return null;
  if (h.receipt?.summary && squeezed(text) === squeezed(h.receipt.summary)) return null;
  return { text, cut: (h.answer?.length ?? 0) >= HANDOFF_ANSWER_MAX, url: h.url };
}

/* Notifications -------------------------------------------------------------------------------------------------------- */

export type JobNoticeKind = 'needsYou' | 'done' | 'failed';

/**
 * Whether a job's move from `before` to `after` is worth a phone notification, and its words: only when it starts to
 * need the person's OK, when it is done and when it failed. A new stage, a step, a check or a question for the assistant
 * (which the assistant answers) never is; neither is one the person stopped.
 */
export function jobNotice(
  before: Handoff | null | undefined,
  after: Handoff,
  locale?: string | null,
): { kind: JobNoticeKind; text: string } | null {
  const JOB_WORDS = wordsIn(locale);
  const title = jobTitle(after);
  if (after.state === 'needs_ok' && before?.state !== 'needs_ok')
    return { kind: 'needsYou', text: JOB_WORDS.notice.needsYou(title) };
  if (after.state !== 'ended' || before?.state === 'ended') return null;
  if (after.outcome === 'completed') return { kind: 'done', text: JOB_WORDS.notice.done(title) };
  if (after.outcome === 'failed') return { kind: 'failed', text: JOB_WORDS.notice.failed(title) };
  return null;
}

/* The work line's part ------------------------------------------------------------------------------------------------- */

/**
 * What a job does that the box knows for sure: fixing a check that failed on its pull request, or waiting for its checks
 * once its run ended; null otherwise, and the step T3 Code is on says it. Never the furthest stage it reached: work goes
 * back and forth, and most jobs (a look, a sync) never get near a pull request.
 */
export function jobDoing(h: Handoff, locale?: string | null): string | null {
  const JOB_WORDS = wordsIn(locale);
  if (h.checks?.failing && h.state === 'working') return JOB_WORDS.fixing;
  if (h.state !== 'checks') return null;
  const pr = h.pullRequest
    ? `#${h.pullRequest.number}`
    : (h.pullRequests.map(pullRequestLabel).find(Boolean) ?? null);
  return pr ? JOB_WORDS.waitingChecksOn(pr) : JOB_WORDS.waitingChecks;
}
