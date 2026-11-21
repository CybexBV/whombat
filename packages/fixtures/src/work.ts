/**
 * The invoice-PDF storyline: plan, run, PR and staging-deploy approval, all Dusty's work. The mock's `pln`, run card,
 * PR #482 and the staging approval at 11:22 — checks 38/41 fixing, Mara requested changes. Mara asked for the plan in
 * her Chat; the run and the approval are in the PR's branch room.
 */
import type { Approval, Plan, PullRequest, Run } from '@whombat/core/domain';
import { IDLE_EXECUTION } from '@whombat/core/domain';
import { BURROW_ID } from './burrow.js';
import { dusty, mara } from './principals.js';
import { at } from './time.js';

export const plan: Plan = {
  id: 'pln_invoice-pdf',
  burrowId: BURROW_ID,
  title: 'Invoice PDF export',
  due: '2026-10-14',
  conversationId: 'cnv_dm-dusty',
  canvasId: 'cvs_invoice-pdf-plan',
  canvasSlug: 'invoice-pdf-export-plan',
  steps: [
    {
      id: 'stp_pdf-1',
      title: 'Pick a PDF library',
      state: 'done',
      stateLabel: 'Done',
      runId: null,
      approvalId: null,
      automationRunId: null,
      dispatchId: null,
      note: null,
      updatedAt: null,
      refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    },
    {
      id: 'stp_pdf-2',
      title: 'Build the export endpoint',
      state: 'active',
      stateLabel: 'In progress',
      runId: 'run_1907',
      approvalId: null,
      automationRunId: null,
      dispatchId: null,
      note: null,
      updatedAt: null,
      refs: { runNumber: 1907, approvalNumber: null, automationRunNumber: null },
    },
    {
      id: 'stp_pdf-3',
      title: 'Review against the brief',
      state: 'active',
      stateLabel: 'Reviewing',
      runId: null,
      approvalId: null,
      automationRunId: null,
      dispatchId: null,
      note: null,
      updatedAt: null,
      refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    },
    {
      id: 'stp_pdf-4',
      title: 'Deploy to staging',
      state: 'gate',
      stateLabel: 'Needs you',
      runId: null,
      approvalId: 'apr_staging-482',
      automationRunId: null,
      dispatchId: null,
      note: null,
      updatedAt: null,
      refs: { runNumber: null, approvalNumber: 12, automationRunNumber: null },
    },
  ],
  updatedAt: at('11:22'),
  createdById: null,
  createdAt: null,
  source: null,
  messageId: null,
};

export const run: Run = {
  id: 'run_1907',
  number: 1907,
  burrowId: BURROW_ID,
  agentId: dusty.id,
  title: 'Address review on PR #482',
  branch: 'feat/invoice-pdf',
  repoId: 'rep_billing',
  prNumber: 482,
  status: 'live',
  askedById: mara.id,
  conversationId: 'cnv_pr482',
  messageId: 'msg_pr482-dusty-1122',
  startedAt: at('11:22'),
  finishedAt: null,
  progress: 55,
  activity: 'Reading Mara’s review on PR #482',
  summary: null,
  // All five of the storyline's steps (RSTEPS in the mock), first active and the rest queued — matches
  // the reference run page at 11:22 (tick 0). See RUN_STEPS_TIMELINE in live.ts for titles/details/times.
  steps: [
    {
      title: 'Read Mara’s review',
      detail: 'Two changes requested on billing/pdf/format.ts',
      at: at('11:22'),
      state: 'active',
    },
    {
      title: 'Round VAT before formatting',
      detail: 'Move roundVat() ahead of formatAmount()',
      at: null,
      state: 'queued',
    },
    {
      title: 'Rename formatEuro to formatAmount',
      detail: 'It takes a locale now',
      at: null,
      state: 'queued',
    },
    {
      title: 'Run the billing test suite',
      detail: '41 tests, including a new €0,005 case',
      at: null,
      state: 'queued',
    },
    {
      title: 'Push and ask Mara to re-review',
      detail: 'Posts back to the branch room',
      at: null,
      state: 'queued',
    },
  ],
  tests: { passed: 38, total: 41 },
  // All six files the run touches (FILES in the mock) — matches the PR's file list below.
  files: [
    { path: 'billing/pdf/render.ts', add: 128, del: 0 },
    { path: 'billing/pdf/format.ts', add: 34, del: 9 },
    { path: 'billing/api/invoices.ts', add: 22, del: 1 },
    { path: 'billing/pdf/cache.ts', add: 18, del: 0 },
    { path: 'billing/pdf/format.test.ts', add: 41, del: 2 },
    { path: 'billing/flags.ts', add: 3, del: 0 },
  ],
  diff: { add: 214, del: 12, files: 6 },
  keysUsed: ['branch.feature.readwrite', 'tests.run'],
  logCount: 8,
  pausedById: null,
  takenOverById: null,
};

/** The run once Dusty finishes (used by the approve-handler's terminal-state transition). */
export const runFinished: Run = {
  ...run,
  status: 'done',
  finishedAt: at('11:36'),
  progress: 100,
  activity: 'Pushed 7be20f · asked Mara to re-review',
  summary: 'Rounded VAT before formatting and renamed formatEuro to formatAmount. 41 of 41 tests passed.',
  // All five steps done once the run finishes (activeIdx runs past the end in the mock at the final tick).
  steps: [
    {
      title: 'Read Mara’s review',
      detail: 'Two changes requested on billing/pdf/format.ts',
      at: at('11:22'),
      state: 'done',
    },
    {
      title: 'Round VAT before formatting',
      detail: 'Move roundVat() ahead of formatAmount()',
      at: at('11:24'),
      state: 'done',
    },
    {
      title: 'Rename formatEuro to formatAmount',
      detail: 'It takes a locale now',
      at: at('11:29'),
      state: 'done',
    },
    {
      title: 'Run the billing test suite',
      detail: '41 tests, including a new €0,005 case',
      at: at('11:31'),
      state: 'done',
    },
    {
      title: 'Push and ask Mara to re-review',
      detail: 'Posts back to the branch room',
      at: at('11:36'),
      state: 'done',
    },
  ],
  tests: { passed: 41, total: 41 },
  logCount: 16,
};

export const pr: PullRequest = {
  id: 'pr_482',
  number: 482,
  repoId: 'rep_billing',
  repoFullName: 'whombat/billing',
  branch: 'feat/invoice-pdf',
  baseBranch: 'main',
  title: 'Invoice PDF export',
  state: 'open',
  headSha: 'e9f114',
  authorId: dusty.id,
  checks: [
    { name: 'lint', state: 'passed', note: '12s', durationMs: 12_000, tests: null, url: null },
    { name: 'typecheck', state: 'passed', note: '41s', durationMs: 41_000, tests: null, url: null },
    {
      name: 'unit · billing',
      state: 'failed',
      note: '38/41',
      durationMs: null,
      tests: { passed: 38, total: 41 },
      url: null,
    },
    { name: 'pdf-snapshot', state: 'queued', note: 'queued', durationMs: null, tests: null, url: null },
  ],
  reviewers: [{ principalId: mara.id, state: 'changes_requested', at: at('11:20') }],
  files: [
    { path: 'billing/pdf/render.ts', add: 128, del: 0 },
    { path: 'billing/pdf/format.ts', add: 34, del: 9 },
    { path: 'billing/api/invoices.ts', add: 22, del: 1 },
    { path: 'billing/pdf/cache.ts', add: 18, del: 0 },
    { path: 'billing/pdf/format.test.ts', add: 41, del: 2 },
    { path: 'billing/flags.ts', add: 3, del: 0 },
  ],
  diff: { add: 246, del: 12, files: 6 },
  commits: [
    { sha: 'a41c9e', message: 'Add PDF export endpoint', authorId: dusty.id, at: at('10:20') },
    { sha: 'c02b7d', message: 'Render invoice with Typeset', authorId: dusty.id, at: at('10:31') },
    { sha: 'e9f114', message: 'Cache PDFs for 24 hours', authorId: dusty.id, at: at('10:47') },
  ],
  conversationId: 'cnv_pr482',
  openedAt: at('10:48'),
  mergedAt: null,
  mergedById: null,
  url: 'https://github.com/whombat/billing/pull/482',
};

/** PR state once Mara re-reviews and approves (terminal state for the approve-handler). */
export const prApproved: PullRequest = {
  ...pr,
  checks: pr.checks.map((c) =>
    c.name === 'unit · billing'
      ? { ...c, state: 'passed' as const, note: '41/41', tests: { passed: 41, total: 41 } }
      : c.name === 'pdf-snapshot'
        ? { ...c, state: 'passed' as const, note: '9s', durationMs: 9_000 }
        : c,
  ),
  reviewers: [{ principalId: mara.id, state: 'approved', at: at('11:38') }],
  headSha: '7be20f7',
};

/** Dusty's staging deploy as the desktop mock shows it at 11:22 (checks 38/41 fixing, changes requested). */
export function deployApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'apr_staging-482',
    number: 12,
    burrowId: BURROW_ID,
    requesterId: dusty.id,
    keyId: 'deploy.staging',
    action: {
      type: 'deploy',
      params: {
        environment: 'staging',
        service: 'billing-api',
        ref: 'feat/invoice-pdf',
        sha: null,
        prNumber: 482,
      },
    },
    title: 'Deploy feat/invoice-pdf to staging',
    question: 'Deploy feat/invoice-pdf to staging?',
    target: 'staging · billing-api',
    whatHappens: [
      'Build 7be20f, the latest commit on feat/invoice-pdf',
      'Run migrations. There are none in this change.',
      'Roll billing-api to staging, 2 of 2 pods',
      'Roll back on its own if errors stay above 1% for 5 minutes',
    ],
    explainer:
      'Dusty holds a staging key that only turns when you approve. If you approve now, the deploy waits for the other two conditions and goes out on its own.',
    summary:
      'Dusty builds 7be20f and rolls billing-api to staging, 2 of 2 pods. It rolls back on its own if errors stay above 1% for 5 minutes.',
    conditions: [
      {
        id: 'checks',
        kind: 'checks_pass',
        label: 'Checks pass on the latest commit',
        met: false,
        prNumber: 482,
        headSha: 'e9f114',
        state: 'running',
        passed: 38,
        total: 41,
        fixing: true,
      },
      {
        id: 'review',
        kind: 'review_approved',
        label: 'Mara approves the PR',
        met: false,
        prNumber: 482,
        reviewerId: mara.id,
        reviewState: 'changes_requested',
        reviewedAt: at('11:20'),
      },
      {
        id: 'person',
        kind: 'person_approves',
        label: 'You say yes',
        met: false,
        approverIds: [mara.id],
      },
    ],
    state: 'pending',
    decidedById: null,
    decidedAt: null,
    execution: IDLE_EXECUTION,
    executedAt: null,
    conversationId: 'cnv_pr482',
    messageId: 'msg_pr482-dusty-1125',
    involvedIds: [],
    eventId: 'evt_9f18',
    createdAt: at('11:25'),
    ...overrides,
  };
}

export const approval: Approval = deployApproval();

/** Files `pr` adds rather than changes. */
const NEW_FILES = new Set(['billing/pdf/render.ts', 'billing/pdf/cache.ts']);

/**
 * The base and head versions of one of `pr`'s files, made up so the file view (CT-241) shows exactly the file's
 * `+add −del`: a few lines of context around the removed lines, then the added ones. `null` is a version that
 * doesn't exist (an added file).
 */
export function prFileVersions(file: { path: string; add: number; del: number }): {
  base: string | null;
  head: string;
} {
  const name =
    file.path
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? 'file';
  const fn = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''));
  const top = [
    `// ${file.path}`,
    "import { roundVat } from './vat';",
    '',
    `export function ${fn}(input: Input) {`,
  ];
  const bottom = ['  return result;', '}', ''];
  const removed = Array.from(
    { length: file.del },
    (_, i) => `  const old${i + 1} = legacy(input, ${i + 1});`,
  );
  const added = Array.from({ length: file.add }, (_, i) => `  const step${i + 1} = next(input, ${i + 1});`);
  const join = (lines: string[]) => `${lines.join('\n')}\n`;
  return {
    base: NEW_FILES.has(file.path) ? null : join([...top, ...removed, ...bottom]),
    head: join(NEW_FILES.has(file.path) ? added : [...top, ...added, ...bottom]),
  };
}
