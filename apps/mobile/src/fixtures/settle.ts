/**
 * Cards that settle into a line, in the app's demo world (`EXPO_PUBLIC_WHOMBAT_SETTLE=1`; docs/decisions/card-settle.md
 * AP-730…AP-735): PR #482's room gets a thread modelled on John's reports thread — a bug report as its root, the
 * settled assessment, two done runs with a pull request and a diff followed by the turn one scheduled (`runId`, folded
 * into its run), a decided approval, a plan that is done, a retried failed turn, a run
 * that changed nothing, a live run that changed something and one that needs a person — and two more roots: one with a
 * live run in its thread (`Neo is working · 38%` in the demo world) and one where the agent thinks. The agent reports what it does in
 * the report thread (`activity.updated`) while it thinks there (Whombat one-agent.md OA-01: every turn is the one
 * agent's). Pure data and a small timer, unit-tested.
 */
import type {
  Activity,
  Approval,
  AssessmentCard,
  Message,
  MessageCard,
  MessagePage,
  Plan,
  RealtimeEvent,
  Run,
  ScheduleCard,
} from '@whombat/core';
import {
  AGENT,
  assessmentCardOf,
  at,
  BURROW_ID,
  deployApproval,
  mara,
  plan,
  reportCardOf,
  reportLikelyBug,
  run,
} from '@whombat/fixtures';

/** The room the thread is in: PR #482's (the contracts' world has no channels, OA-04). */
export const SETTLE_ROOM = 'cnv_pr482';
/** The report thread's root. */
export const REPORT_ROOT = 'msg_settle-report';
/** A root whose thread has a live run (AP-735). */
export const DEPLOY_ROOT = 'msg_settle-deploy';
/** A root where the agent is thinking. */
export const QUESTION_ROOT = 'msg_settle-question';

function message(
  id: string,
  hhmm: string,
  authorId: string,
  text: string,
  card: MessageCard | null = null,
  threadRootId: string | null = REPORT_ROOT,
): Message {
  return {
    id,
    conversationId: SETTLE_ROOM,
    authorId,
    createdAt: at(hhmm),
    editedAt: null,
    text,
    mentions: [],
    reactions: [],
    attachments: [],
    threadRootId,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    card,
    suggestions: [],
    more: null,
  } as Message;
}

function fixtureRun(o: Partial<Run> & Pick<Run, 'id' | 'number' | 'title'>): Run {
  return {
    ...run,
    conversationId: SETTLE_ROOM,
    messageId: null,
    threadRootId: REPORT_ROOT,
    askedById: mara.id,
    status: 'done',
    progress: 100,
    attention: null,
    summary: null,
    ...o,
  } as Run;
}

/** Run #1: the fix, done with PR #3. */
export const runFix = fixtureRun({
  id: 'run_settle-fix',
  number: 3101,
  title: 'Fix VAT rounding on the invoice PDF',
  branch: 'fix/vat-rounding',
  prNumber: 3,
  diff: { add: 12, del: 8, files: 3 },
  startedAt: at('11:02'),
  finishedAt: '2026-09-23T09:08:12.000Z',
  summary: 'Rounded once after summing; a test with seven lines.',
  activity: '',
});

/** Run #2: the follow-up, done with PR #4, which scheduled a check. */
export const runFollow = fixtureRun({
  id: 'run_settle-follow',
  number: 3102,
  title: 'Check older invoices',
  branch: 'fix/vat-older',
  prNumber: 4,
  diff: { add: 31, del: 2, files: 2 },
  startedAt: at('11:09'),
  finishedAt: '2026-09-23T09:12:40.000Z',
  summary: 'Older invoices match; a backfill note in PR #4.',
  activity: '',
});

/** Run #3: a question, changed nothing (the run line, AP-668). */
export const runCheck = fixtureRun({
  id: 'run_settle-check',
  number: 3103,
  title: 'Check the staging export',
  branch: 'fix/vat-rounding',
  prNumber: null,
  diff: { add: 0, del: 0, files: 0 },
  startedAt: at('11:13'),
  finishedAt: '2026-09-23T09:14:05.000Z',
  summary: 'The export matches the page.',
  activity: '',
});

/** Run #4: live, changed something: the compact live card (AP-733). */
export const runLive = fixtureRun({
  id: 'run_settle-live',
  number: 3104,
  title: 'Verify and deploy',
  branch: 'fix/vat-rounding',
  prNumber: 3,
  diff: { add: 14, del: 8, files: 4 },
  status: 'live',
  progress: 62,
  startedAt: at('11:16'),
  finishedAt: null,
  activity: 'Running pnpm test',
});

/** Run #5: live, needs a person: the full card. */
export const runStuck = fixtureRun({
  id: 'run_settle-stuck',
  number: 3105,
  title: 'Backfill the corrected PDFs',
  branch: 'fix/vat-backfill',
  prNumber: 5,
  diff: { add: 40, del: 0, files: 1 },
  status: 'live',
  progress: 30,
  startedAt: at('11:18'),
  finishedAt: null,
  activity: 'Waiting for storage access',
  attention: 'The run stopped before it finished.',
});

/** The live run in the deploy thread (AP-735): the agent working, at 38%. */
export const runDeploy = fixtureRun({
  id: 'run_settle-deploy',
  number: 3106,
  title: 'Deploy the website',
  branch: 'main',
  prNumber: 6,
  diff: { add: 5, del: 1, files: 1 },
  status: 'live',
  progress: 38,
  startedAt: at('11:19'),
  finishedAt: null,
  activity: 'Uploading the build',
  threadRootId: DEPLOY_ROOT,
});

/** The live runs `runs.list?status=live` adds (with their thread). */
export const SETTLE_LIVE_RUNS: readonly Run[] = [runLive, runStuck, runDeploy];

const runCard = (r: Run): MessageCard => ({ kind: 'run', run: r }) as MessageCard;

const followUp: ScheduleCard = {
  kind: 'schedule',
  scheduleId: 'sch_settle-follow',
  runId: runFollow.id,
  schedule: {
    id: 'sch_settle-follow',
    agentId: AGENT.id,
    conversationId: SETTLE_ROOM,
    threadRootId: REPORT_ROOT,
    prompt: 'Check that PR #4 was merged and the backfill ran.',
    when: { kind: 'at', at: '2026-09-23T13:23:00.000Z' },
    status: 'active',
    endedReason: null,
    nextAt: '2026-09-23T13:23:00.000Z',
    endsAt: null,
    runs: 0,
    lastRunAt: null,
    createdAt: at('11:12'),
    forName: 'Mara',
    canChange: true,
  },
} as ScheduleCard;

const approved: Approval = deployApproval({
  id: 'apr_settle-deploy',
  number: 31,
  state: 'approved',
  decidedById: mara.id,
  decidedAt: at('11:15'),
  execution: {
    state: 'succeeded',
    startedAt: at('11:15'),
    finishedAt: at('11:16'),
    durationMs: 42_000,
    resultUrl: null,
    error: null,
  },
} as Partial<Approval>);

const donePlan: Plan = {
  ...plan,
  id: 'pln_settle-fix',
  title: 'Fix the VAT total on invoice PDFs',
  steps: plan.steps.map((s) => ({ ...s, state: 'done' as const })),
};

const assessment = {
  ...(assessmentCardOf(reportLikelyBug) as AssessmentCard),
  decided: {
    option: 0,
    label: 'Fix it',
    action: 'hand_off',
    decidedById: mara.id,
    decidedAt: at('11:01'),
  },
} as AssessmentCard;

/** The report thread's replies, oldest first. */
export const REPORT_REPLIES: readonly Message[] = [
  message('msg_settle-assess', '11:00', AGENT.id, '', { ...assessment } as MessageCard),
  message('msg_settle-ask', '11:01', mara.id, 'Can you fix this?'),
  message('msg_settle-run1', '11:02', AGENT.id, 'On it.', runCard(runFix)),
  message('msg_settle-plan', '11:08', AGENT.id, '', { kind: 'plan', plan: donePlan } as MessageCard),
  message('msg_settle-run2', '11:09', AGENT.id, 'Checking older invoices too.', runCard(runFollow)),
  message('msg_settle-schedule', '11:12', AGENT.id, '', followUp as MessageCard),
  message('msg_settle-check', '11:13', AGENT.id, '', runCard(runCheck)),
  message('msg_settle-failed', '11:14', AGENT.id, 'I couldn’t start: the model was busy.', {
    kind: 'turn_failed',
    dispatchId: 'dsp_settle-failed',
    agentId: AGENT.id,
    code: 'provider',
    reason: 'I couldn’t start: the model was busy.',
    retriedAt: at('11:14'),
    retryDispatchId: 'dsp_settle-retry',
  } as unknown as MessageCard),
  message('msg_settle-approval', '11:15', AGENT.id, '', {
    kind: 'approval',
    approval: approved,
  } as MessageCard),
  message('msg_settle-live', '11:16', AGENT.id, 'Verifying before the deploy.', runCard(runLive)),
  message('msg_settle-stuck', '11:18', AGENT.id, '', runCard(runStuck)),
];

const reportRoot: Message = {
  // The header the server posts a report with; it folds into the report's row (docs/decisions/report-rows.md RR-04).
  ...message(
    'msg_settle-report',
    '10:58',
    AGENT.id,
    'Bug report FB-7K3Q-9M2X · Burrow Billing',
    reportCardOf(reportLikelyBug) as MessageCard,
    null,
  ),
  replyCount: REPORT_REPLIES.length,
  lastReplyAt: at('11:18'),
  threadParticipantIds: [AGENT.id, mara.id],
};

const deployRoot: Message = {
  ...message(DEPLOY_ROOT, '11:19', mara.id, 'Deploy the website once the fix is in.', null, null),
  replyCount: 1,
  lastReplyAt: at('11:19'),
  threadParticipantIds: [mara.id, AGENT.id],
};

const questionRoot: Message = {
  ...message(QUESTION_ROOT, '11:20', mara.id, 'Did VAT rounding change last month?', null, null),
  replyCount: 1,
  lastReplyAt: at('11:20'),
  threadParticipantIds: [mara.id, AGENT.id],
};

const DEPLOY_REPLIES: readonly Message[] = [
  message('msg_settle-deploy-run', '11:19', AGENT.id, 'Deploying.', runCard(runDeploy), DEPLOY_ROOT),
];
const QUESTION_REPLIES: readonly Message[] = [
  message('msg_settle-question-ack', '11:20', AGENT.id, 'Looking.', null, QUESTION_ROOT),
];

/** The roots it adds to the room's top level. */
export const SETTLE_ROOTS: readonly Message[] = [reportRoot, deployRoot, questionRoot];

/** The room with the three roots, in time order. */
export function withSettleMessages(conversationId: string, page: MessagePage): MessagePage {
  if (conversationId !== SETTLE_ROOM) return page;
  const shown = new Set(page.messages.map((m) => m.id));
  const messages = [...page.messages, ...SETTLE_ROOTS.filter((m) => !shown.has(m.id))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return { ...page, messages };
}

/** `messages.thread` for one of its roots; null for every other message. */
export function settleThread(messageId: string) {
  const replies =
    messageId === REPORT_ROOT
      ? REPORT_REPLIES
      : messageId === DEPLOY_ROOT
        ? DEPLOY_REPLIES
        : messageId === QUESTION_ROOT
          ? QUESTION_REPLIES
          : null;
  const root = SETTLE_ROOTS.find((m) => m.id === messageId);
  if (!replies || !root) return null;
  return {
    root,
    replies: [...replies],
    conversationId: SETTLE_ROOM,
    where: 'PR #482',
    topic: null,
    more: null,
  };
}

/** `runs.list` with its live runs added, for a `status=live` or unfiltered list. */
export function withSettleRuns(data: { runs: Run[] }, status: string | null): { runs: Run[] } {
  if (status && status !== 'live') return data;
  const have = new Set(data.runs.map((r) => r.id));
  return { ...data, runs: [...SETTLE_LIVE_RUNS.filter((r) => !have.has(r.id)), ...data.runs] };
}

/** The agent's latest action in the report thread: `Editing format.ts`, from 11:16:30 on. */
export function agentActivity(now: Date): Activity {
  return {
    id: 'act_settle-1',
    burrowId: BURROW_ID,
    dispatchId: 'dsp_settle-live',
    runId: runLive.id,
    agentId: AGENT.id,
    conversationId: SETTLE_ROOM,
    threadRootId: REPORT_ROOT,
    key: 'edit:billing/pdf/format.ts',
    attempt: 1,
    seq: 7,
    kind: 'edit',
    tool: 'Edit',
    status: 'running',
    title: 'Editing format.ts',
    object: 'billing/pdf/format.ts',
    detail: null,
    important: false,
    approvalId: null,
    link: null,
    evidence: null,
    startedAt: new Date(now.getTime() - 72_000).toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
  } as Activity;
}

/**
 * The realtime side: while the room is open, the agent thinks in the report thread (and says what it does) and in the
 * question's, refreshed before the typing entries expire. Returns a stop function.
 */
export function startSettleSignals(
  now: () => Date,
  emit: (topic: string, event: RealtimeEvent) => void,
  every: (fn: () => void, ms: number) => () => void,
): () => void {
  const pulse = () => {
    const t = now();
    const expiresAt = new Date(t.getTime() + 8000).toISOString();
    const topic = `conv:${SETTLE_ROOM}`;
    emit(topic, { type: 'activity.updated', activity: agentActivity(t) } as RealtimeEvent);
    emit(topic, {
      type: 'typing',
      conversationId: SETTLE_ROOM,
      threadRootId: REPORT_ROOT,
      principalId: AGENT.id,
      active: true,
      mode: 'thinking',
      expiresAt,
    } as RealtimeEvent);
    emit(topic, {
      type: 'typing',
      conversationId: SETTLE_ROOM,
      threadRootId: QUESTION_ROOT,
      principalId: AGENT.id,
      active: true,
      mode: 'thinking',
      expiresAt,
    } as RealtimeEvent);
  };
  pulse();
  return every(pulse, 4000);
}
