/**
 * Minimal slice of the mock world for core's own tests. The full seed lives in `@whombat/fixtures`;
 * this file is not exported from the package.
 */
import { deriveSeedKeypair, fingerprintOf } from '../audit/crypto.js';
import { DEFAULT_AGENT_RUNTIME } from '../domain/agent.js';
import type { Approval } from '../domain/approval.js';
import { IDLE_EXECUTION } from '../domain/approval.js';
import type { Grant } from '../domain/grant.js';
import type { Plan } from '../domain/plan.js';
import type { Agent, Person, Principal } from '../domain/principal.js';
import type { PullRequest } from '../domain/repo.js';
import type { Run } from '../domain/run.js';
import { agentDefaultGrants } from '../keys/grants.js';

export const TZ = 'Europe/Amsterdam';
/** Wednesday 23 September 2026, 11:22 in Amsterdam. */
export const NOW = '2026-09-23T09:22:00.000Z';
/** 11:22 local on the seed day → ISO. `at('11:25')` */
export function at(hhmm: string, dayOffset = 0): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = new Date(Date.UTC(2026, 8, 23 + dayOffset, h - 2, m));
  return d.toISOString();
}

export const BURROW_ID = 'bur_burrow-hq';

function keys(id: string) {
  const kp = deriveSeedKeypair(id);
  return { publicKey: kp.publicKey, fingerprint: fingerprintOf(kp.publicKey), secretKey: kp.secretKey };
}

function person(
  handle: string,
  name: string,
  initials: string,
  tone: string,
  extra: Partial<Person> = {},
): Person {
  const id = `prn_${handle}`;
  const { publicKey, fingerprint } = keys(id);
  return {
    id,
    burrowId: BURROW_ID,
    kind: 'person',
    name,
    handle,
    publicKey,
    fingerprint,
    createdAt: '2026-01-05T09:00:00.000Z',
    initials,
    tone,
    email: `${handle}@burrowhq.example`,
    ...extra,
  };
}

function agent(handle: string, name: string, status: Agent['status'], doing: string): Agent {
  const id = `prn_${handle}`;
  const { publicKey, fingerprint } = keys(id);
  return {
    id,
    burrowId: BURROW_ID,
    kind: 'agent',
    name,
    handle,
    publicKey,
    fingerprint,
    createdAt: '2026-01-05T09:00:00.000Z',
    face: 'dusty',
    status,
    doing,
    runtime: { ...DEFAULT_AGENT_RUNTIME },
  };
}

/** The person whose Whombat it is (one-person.md OP-01): the world has nobody else. */
export const mara = person('mara', 'Mara Okafor', 'MO', '#d9c3a9', {
  shortName: 'Mara',
  title: 'Engineering lead',
});

/** The Whombat's one agent. */
export const dusty = agent(
  'dusty',
  'Dusty',
  'working',
  'Rounding VAT before formatting on feat/invoice-pdf.',
);

export const PEOPLE: Person[] = [mara];
export const PRINCIPALS: Principal[] = [...PEOPLE, dusty];

export function principal(id: string): Principal | undefined {
  return PRINCIPALS.find((p) => p.id === id);
}

export function secretKeyOf(id: string): string {
  return keys(id).secretKey;
}

export const GRANTS: Grant[] = agentDefaultGrants(dusty.id);

/** Name lookup for approval / audit display helpers. */
export function names(id: string) {
  const p = principal(id);
  if (!p) return undefined;
  return {
    name: p.name,
    shortName: p.kind === 'person' ? (p.shortName ?? p.name.split(' ')[0] ?? p.name) : p.name,
  };
}

export function auditPrincipal(id: string) {
  const p = principal(id);
  if (!p) return undefined;
  const short = names(id)?.shortName ?? p.name;
  return p.kind === 'person'
    ? { kind: 'person' as const, name: p.name, shortName: short }
    : { kind: 'agent' as const, name: p.name, shortName: short };
}

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
      'Dusty holds a staging key that only turns when a person approves. If you approve now, the deploy waits for the other two conditions and goes out on its own.',
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
        label: 'A person says yes',
        met: false,
        approverIds: [mara.id],
      },
    ],
    state: 'pending',
    decidedById: null,
    decidedAt: null,
    execution: IDLE_EXECUTION,
    executedAt: null,
    conversationId: 'cnv_dm-dusty',
    messageId: 'msg_dm-dusty-dusty-1125',
    involvedIds: [],
    eventId: 'evt_9f18',
    createdAt: at('11:25'),
    ...overrides,
  };
}

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
  conversationId: 'cnv_dm-dusty',
  messageId: 'msg_dm-dusty-dusty-1122',
  startedAt: at('11:22'),
  finishedAt: null,
  progress: 55,
  activity: 'Reading Mara’s review on PR #482',
  summary: null,
  // All five storyline steps and all six files (RSTEPS/FILES in the mock) — keep in sync with
  // @whombat/fixtures' `run` in packages/fixtures/src/work.ts.
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
      detail: 'Posts back to Chat and the branch room',
      at: null,
      state: 'queued',
    },
  ],
  tests: { passed: 38, total: 41 },
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
