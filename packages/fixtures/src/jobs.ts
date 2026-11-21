/**
 * Sample progress of a job handed to T3 Code (Whombat t3code.md T3-30…T3-41), one per state the job view draws: T3
 * Code's plan, its latest steps, the pull request with its changes and checks, a question, and the receipt with its
 * answer. Web's and the phone's fixture modes spread one into a `Handoff`, so every state is visible without a box.
 */
import type {
  Handoff,
  HandoffChanges,
  HandoffCheck,
  HandoffPlanStep,
  HandoffStageTime,
  HandoffStep,
  HandoffTrackStage,
} from '@whombat/core';

export const JOB_FIXTURE_STATES = [
  'reading',
  'plan',
  'editing',
  'tests',
  'fixing',
  'question',
  'needs_ok',
  'checks',
  'merged',
] as const;
export type JobFixtureState = (typeof JOB_FIXTURE_STATES)[number];

/** The parts of a `Handoff` a job fixture sets. */
export type JobFixture = Pick<
  Handoff,
  | 'state'
  | 'since'
  | 'endedAt'
  | 'outcome'
  | 'asks'
  | 'pullRequests'
  | 'stage'
  | 'stages'
  | 'plan'
  | 'changes'
  | 'checks'
  | 'question'
  | 'pullRequest'
  | 'receipt'
  | 'answer'
>;

const PR_URL = 'https://github.com/burrow-hq/whombat/pull/48';

const PLAN = [
  'Find where the backup list is read',
  'Show the backups when the list is empty',
  'Add a test for an empty list',
  'Open a pull request',
];

const CHANGES: HandoffChanges = {
  files: [
    { path: 'apps/web/src/features/backups/BackupList.tsx', additions: 142, deletions: 31 },
    { path: 'apps/server/src/backups/list.ts', additions: 88, deletions: 12 },
    { path: 'apps/server/src/backups/list.test.ts', additions: 64, deletions: 0 },
    { path: 'packages/client/src/backups.ts', additions: 21, deletions: 9 },
    { path: 'apps/mobile/src/screens/Backups.tsx', additions: 25, deletions: 6 },
  ],
  fileCount: 12,
  additions: 340,
  deletions: 58,
  summary: 'Show the backups again when the list is empty',
  url: `${PR_URL}/files`,
};

/** What T3 Code answered when the merged job ended: its first sentence is the receipt's line. */
const ANSWER = [
  'The backup list shows every backup again, also when the newest one is still running.',
  '',
  '**What was wrong**',
  '',
  'The list was read from the newest finished backup only. While a backup ran there was none, so the list came back empty.',
  '',
  '**What changed**',
  '',
  '- `apps/server/src/backups/list.ts` reads every backup and marks the running one.',
  '- `BackupList.tsx` shows the running backup first, with “Running now”.',
  '- A test covers a list with only a running backup.',
  '',
  '**Checked**',
  '',
  'The server and web tests pass, and I opened the page while a backup ran.',
].join('\n');

const ORDER: HandoffTrackStage[] = [
  'reading',
  'plan',
  'editing',
  'tests',
  'review',
  'pull_request',
  'checks',
  'merged',
];

/**
 * The stages up to `stage`, each a few minutes long (shortened to fit a job younger than they add up to), the last
 * still going (unless `closed`).
 */
function track(stage: HandoffTrackStage, startMs: number, nowMs: number, closed = false): HandoffStageTime[] {
  const minutes = [2, 1, 6, 3, 2, 1, 5, 0];
  const upTo = ORDER.indexOf(stage);
  const total = minutes.slice(0, upTo + (closed ? 1 : 0)).reduce((a, b) => a + b, 0) * 60_000;
  // The stage it is on gets a fifth of the job at least.
  const room = (nowMs - startMs) * (closed ? 1 : 0.8);
  const scale = total > room ? room / total : 1;
  const out: HandoffStageTime[] = [];
  let t = startMs;
  for (const [i, s] of ORDER.entries()) {
    const end = t + (minutes[i] ?? 1) * 60_000 * scale;
    const last = s === stage;
    out.push({
      stage: s,
      startedAt: new Date(t).toISOString(),
      endedAt: last && !closed && s !== 'merged' ? null : new Date(s === 'merged' ? t : end).toISOString(),
    });
    if (last) break;
    t = end;
  }
  return out;
}

const plan = (now: number): HandoffPlanStep[] =>
  PLAN.map((text, i) => ({ text, state: i < now ? 'done' : i === now ? 'now' : 'next' }));

const checks = (test: HandoffCheck['state']): HandoffCheck[] => [
  { name: 'Biome', state: 'passed', url: `${PR_URL}/checks?check=biome` },
  { name: 'Typecheck', state: 'passed', url: `${PR_URL}/checks?check=typecheck` },
  { name: 'Unit tests', state: test, url: `${PR_URL}/checks?check=unit` },
  { name: 'Server tests', state: test === 'failed' ? 'passed' : test, url: `${PR_URL}/checks?check=server` },
];

const STEP_WORDS = [
  'Reading the code',
  'Planning the work',
  'Changing the code',
  'Running the tests',
  'Opening a pull request',
];
const STEP_AT: Record<JobFixtureState, number> = {
  reading: 0,
  plan: 1,
  editing: 2,
  tests: 3,
  fixing: 2,
  question: 2,
  needs_ok: 2,
  checks: STEP_WORDS.length,
  merged: STEP_WORDS.length,
};

/**
 * T3 Code's latest steps for a job in `state`, as the box words them: the one not done is what it does now. Apart from
 * `jobFixture`, so a fixture world's own steps aren't overwritten by its spread.
 */
export function jobSteps(state: JobFixtureState): HandoffStep[] {
  const at = STEP_AT[state];
  return STEP_WORDS.slice(0, at + 1).map((text, i) => ({ text, detail: null, done: i < at }));
}

/** A job in `state`, started `minutesAgo` before `nowMs`. */
export function jobFixture(state: JobFixtureState, nowMs: number, minutesAgo = 14): JobFixture {
  const start = nowMs - minutesAgo * 60_000;
  const since = new Date(start).toISOString();
  const pullRequest = { number: 48, url: PR_URL, state: 'open' as const };
  const base: JobFixture = {
    state: 'working',
    since,
    endedAt: null,
    outcome: null,
    asks: null,
    pullRequests: [],
    stage:
      state === 'fixing' || state === 'checks'
        ? 'checks'
        : state === 'question' || state === 'needs_ok'
          ? 'editing'
          : null,
    stages: [],
    plan: [],
    changes: null,
    checks: null,
    question: null,
    pullRequest: null,
    receipt: null,
    answer: null,
  };
  switch (state) {
    case 'reading':
      return { ...base, stage: 'reading', stages: track('reading', start, nowMs) };
    case 'plan':
      return {
        ...base,
        stage: 'plan',
        stages: track('plan', start, nowMs),
        plan: plan(0).map((s) => ({ ...s, state: 'next' })),
      };
    case 'editing':
      return { ...base, stage: 'editing', stages: track('editing', start, nowMs), plan: plan(1) };
    case 'tests':
      return { ...base, stage: 'tests', stages: track('tests', start, nowMs), plan: plan(2) };
    case 'question':
      return {
        ...base,
        state: 'asked',
        stages: track('editing', start, nowMs),
        plan: plan(1),
        asks: 'Keep the old list as a fallback?',
        question: {
          requestId: 'req-fixture-1',
          questionId: 'fallback',
          text: 'Keep the old list as a fallback?',
          options: [
            { label: 'Yes, keep it', description: 'Show the old list when the new one fails' },
            { label: 'No, remove it', description: null },
          ],
          multiSelect: false,
        },
      };
    case 'needs_ok':
      return {
        ...base,
        state: 'needs_ok',
        stages: track('editing', start, nowMs),
        plan: plan(1),
        asks: 'git push origin fix/backup-list',
      };
    case 'fixing':
      return {
        ...base,
        stages: track('checks', start, nowMs),
        plan: plan(4),
        changes: CHANGES,
        checks: { runs: checks('failed'), failing: 'Unit tests', attempts: 1 },
        pullRequest,
      };
    case 'checks':
      return {
        ...base,
        state: 'checks',
        endedAt: new Date(nowMs - 3 * 60_000).toISOString(),
        pullRequests: [PR_URL],
        stages: track('checks', start, nowMs),
        plan: plan(4),
        changes: CHANGES,
        checks: { runs: checks('running'), failing: null, attempts: 0 },
        pullRequest,
      };
    case 'merged':
      return {
        ...base,
        state: 'ended',
        outcome: 'completed',
        endedAt: new Date(nowMs - 60_000).toISOString(),
        stage: 'merged',
        stages: track('merged', start, nowMs, true),
        plan: plan(4),
        changes: CHANGES,
        checks: { runs: checks('passed'), failing: null, attempts: 1 },
        pullRequest: { ...pullRequest, state: 'merged' },
        receipt: {
          summary: 'The backup list shows every backup again, also when the newest one is still running.',
          tests: 'passed',
          durationMs: 20 * 60_000,
          screenshot: null,
        },
        answer: ANSWER,
      };
  }
}
