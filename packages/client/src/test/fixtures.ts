/**
 * Schema-valid builders for client tests (a small slice of the mock world). `fixtures.test.ts` parses
 * every builder with its contract schema so the tests exercise realistic data.
 */
import type {
  Activity,
  Agent,
  Approval,
  AuditEvent,
  Bootstrap,
  Burrow,
  Canvas,
  CanvasComment,
  Conversation,
  ConversationSummary,
  InboxItem,
  Message,
  Person,
  Plan,
  PullRequest,
  Run,
  SearchAnswer,
  WorkItem,
  WorkOverview,
} from '@whombat/core';
import { DEFAULT_AGENT_RUNTIME } from '@whombat/core';

export const BURROW_ID = 'bur_burrow-hq';
export const BURROW = 'burrow-hq';
/** 11:22 in Amsterdam on the seed day. */
export const NOW = '2026-09-23T09:22:00.000Z';

/** ISO time `minutes` after 11:00 local (09:00Z) on the seed day. */
export function t(minutes: number): string {
  return new Date(Date.UTC(2026, 8, 23, 9, 0) + minutes * 60_000).toISOString();
}

const HEX64 = 'ab'.repeat(32);
const HEX128 = 'cd'.repeat(64);

export const burrow = (o: Partial<Burrow> = {}): Burrow => ({
  id: BURROW_ID,
  name: 'Burrow HQ',
  slug: BURROW,
  timeZone: 'Europe/Amsterdam',
  localModel: null,
  webSearch: null,
  // The time zone's guess (`placeFromTimeZone('Europe/Amsterdam')`).
  place: { name: 'Amsterdam', lat: 52.37, lon: 4.9, country: 'NL', guessed: true },
  createdAt: '2026-01-05T09:00:00.000Z',
  ...o,
});

export const person = (handle = 'mara', o: Partial<Person> = {}): Person => ({
  id: `prn_${handle}`,
  burrowId: BURROW_ID,
  kind: 'person',
  name: 'Mara Okafor',
  handle,
  publicKey: HEX64,
  fingerprint: '3e47 96d7',
  createdAt: '2026-01-05T09:00:00.000Z',
  initials: 'MO',
  tone: '#bfd0bf',
  title: 'Engineering lead',
  email: `${handle}@burrowhq.example`,
  ...o,
});

export const agent = (handle = 'dusty', o: Partial<Agent> = {}): Agent => ({
  id: `prn_${handle}`,
  burrowId: BURROW_ID,
  kind: 'agent',
  name: handle[0]?.toUpperCase() + handle.slice(1),
  handle,
  publicKey: HEX64,
  fingerprint: '3bc7 859b',
  createdAt: '2026-01-05T09:00:00.000Z',
  face: 'dusty',
  status: 'working',
  doing: 'Rounding VAT before formatting on feat/invoice-pdf.',
  runtime: { ...DEFAULT_AGENT_RUNTIME },
  ...o,
});

export const message = (id: string, o: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'cnv_chat',
  authorId: 'prn_mara',
  createdAt: t(0),
  editedAt: null,
  suggestions: [],
  more: null,
  text: 'Hello',
  mentions: [],
  card: null,
  attachments: [],
  reactions: [],
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  threadParticipantIds: [],
  clientId: null,
  ...o,
});

export const run = (o: Partial<Run> = {}): Run => ({
  id: 'run_1907',
  number: 1907,
  burrowId: BURROW_ID,
  agentId: 'prn_dusty',
  title: 'Invoice PDF export',
  branch: 'feat/invoice-pdf',
  repoId: 'rep_billing',
  prNumber: 482,
  status: 'live',
  askedById: 'prn_joris',
  conversationId: 'cnv_chat',
  messageId: 'msg_run',
  startedAt: t(3),
  finishedAt: null,
  progress: 60,
  activity: 'Editing billing/pdf/format.ts',
  summary: null,
  steps: [],
  tests: { passed: 38, total: 41 },
  files: [],
  diff: { add: 214, del: 12, files: 6 },
  keysUsed: ['tests.run'],
  logCount: 8,
  pausedById: null,
  takenOverById: null,
  ...o,
});

export const approval = (o: Partial<Approval> = {}): Approval => ({
  id: 'apr_12',
  number: 12,
  burrowId: BURROW_ID,
  requesterId: 'prn_dusty',
  keyId: 'deploy.staging',
  action: {
    type: 'deploy',
    params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
  },
  title: 'Deploy feat/invoice-pdf to staging',
  question: 'Deploy feat/invoice-pdf to staging?',
  target: 'staging · billing-api',
  whatHappens: ['Build the branch'],
  explainer: '',
  summary: '',
  conditions: [
    {
      id: 'person',
      kind: 'person_approves',
      label: 'A person says yes',
      met: false,
      approverIds: ['prn_mara'],
    },
  ],
  state: 'pending',
  decidedById: null,
  decidedAt: null,
  execution: {
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    resultUrl: null,
    error: null,
  },
  executedAt: null,
  conversationId: 'cnv_chat',
  messageId: 'msg_apr',
  involvedIds: [],
  eventId: null,
  createdAt: t(10),
  ...o,
});

export const plan = (o: Partial<Plan> = {}): Plan => ({
  id: 'pln_billing',
  burrowId: BURROW_ID,
  title: 'Billing v2',
  due: '2026-10-01',
  conversationId: 'cnv_chat',
  canvasId: 'cvs_plan',
  canvasSlug: 'billing-v2-plan',
  steps: [
    {
      id: 'stp_1',
      title: 'PDF export',
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
  ],
  updatedAt: t(0),
  createdById: null,
  createdAt: null,
  source: null,
  messageId: null,
  ...o,
});

export const pr = (o: Partial<PullRequest> = {}): PullRequest => ({
  id: 'pr_482',
  number: 482,
  repoId: 'rep_billing',
  repoFullName: 'whombat/billing',
  branch: 'feat/invoice-pdf',
  baseBranch: 'main',
  title: 'Invoice PDF export',
  state: 'open',
  headSha: '7be20f1',
  authorId: 'prn_dusty',
  checks: [
    { name: 'unit · billing', state: 'failed', note: '38/41', durationMs: null, tests: null, url: null },
  ],
  reviewers: [{ principalId: 'prn_joris', state: 'changes_requested', at: t(5) }],
  files: [],
  diff: { add: 214, del: 12, files: 6 },
  commits: [],
  conversationId: 'cnv_pr482',
  openedAt: t(0),
  mergedAt: null,
  mergedById: null,
  url: null,
  ...o,
});

export const conversation = (o: Partial<Conversation> = {}): Conversation => ({
  id: 'cnv_chat',
  burrowId: BURROW_ID,
  kind: 'dm',
  slug: 'chat-mara',
  title: 'Chat',
  topic: '',
  actions: [],
  prNumber: null,
  repoId: null,
  createdAt: '2026-01-05T09:00:00.000Z',
  lastMessageAt: t(0),
  ...o,
});

export const summary = (o: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'cnv_chat',
  kind: 'dm',
  slug: 'chat-mara',
  title: 'Chat',
  link: { type: 'dm', room: 'chat' },
  unread: 3,
  mentions: 1,
  prNumber: null,
  lastMessageAt: t(0),
  ...o,
});

export const bootstrap = (o: Partial<Bootstrap> = {}): Bootstrap => ({
  burrow: burrow(),
  me: person('mara'),
  principals: [person('mara'), agent('dusty')],
  sidebar: {
    branchRooms: [
      {
        ...summary({
          id: 'cnv_pr482',
          kind: 'branch',
          slug: 'pr482',
          title: 'feat/invoice-pdf',
          link: { type: 'pr', number: 482 },
          prNumber: 482,
        }),
        branch: 'feat/invoice-pdf',
        prNumber: 482,
        prStatus: 'changes_requested',
        dot: 'warn',
      },
    ],
    dms: [
      summary(),
      summary({
        id: 'cnv_feedback',
        slug: 'feedback-mara',
        title: 'Feedback',
        link: { type: 'dm', room: 'feedback' },
        unread: 0,
        mentions: 0,
      }),
    ],
    counts: { canvases: 1, needsYou: 1 },
  },
  preferences: { theme: 'system', timeZone: null },
  serverTime: NOW,
  realtime: { path: '/ws', topics: [`burrow:${BURROW_ID}`, 'me:prn_mara'] },
  ...o,
});

export const auditEvent = (id: string, o: Partial<AuditEvent> = {}): AuditEvent => ({
  v: 1,
  id,
  burrowId: BURROW_ID,
  seq: 1,
  prevHash: HEX64,
  actorId: 'prn_dusty',
  type: 'run.started',
  kind: 'Code',
  text: 'Started run #1907',
  where: 'Run #1907',
  payload: {},
  createdAt: t(0),
  hash: HEX64,
  sig: HEX128,
  signer: HEX64,
  fingerprint: '3bc7 859b',
  verified: true,
  approval: null,
  ...o,
});

export const inboxItem = (id: string, o: Partial<InboxItem> = {}): InboxItem => ({
  id,
  burrowId: BURROW_ID,
  principalId: 'prn_mara',
  kind: 'needs_you',
  actorId: 'prn_dusty',
  where: 'Chat',
  text: 'Deploy feat/invoice-pdf to staging?',
  link: { type: 'approval', number: 12 },
  approvalId: null,
  createdAt: t(0),
  readAt: null,
  approval: null,
  ...o,
});

export const canvas = (o: Partial<Canvas> = {}): Canvas => ({
  id: 'cvs_plan',
  burrowId: BURROW_ID,
  slug: 'billing-v2-plan',
  title: 'Billing v2 plan',
  conversationId: 'cnv_chat',
  planId: 'pln_billing',
  provenance: { createdById: 'prn_dusty', requestedById: 'prn_priya', editorIds: [] },
  createdAt: t(0),
  updatedAt: t(0),
  ...o,
});

export const comment = (id: string, o: Partial<CanvasComment> = {}): CanvasComment => ({
  id,
  canvasId: 'cvs_plan',
  anchor: { relativePosition: 'AAE=', quote: 'PDF export' },
  parentId: null,
  authorId: 'prn_mara',
  text: 'Looks good',
  createdAt: t(0),
  resolved: false,
  ...o,
});

export const answer = (o: Partial<SearchAnswer> = {}): SearchAnswer => ({
  id: 'ans_1',
  burrowId: BURROW_ID,
  query: 'vat rounding',
  agentId: 'prn_dusty',
  status: 'ready',
  text: 'We round per line [1].',
  citations: [{ n: 1, resultId: 'r1' }],
  durationMs: 1800,
  actions: [],
  createdAt: t(0),
  ...o,
});

/** An observed activity row of Banjo's turn on Run #1907 (work-supervision WS-12). */
export const activity = (o: Partial<Activity> = {}): Activity => ({
  id: 'act_1',
  burrowId: BURROW_ID,
  dispatchId: 'dsp_1',
  runId: 'run_1907',
  agentId: 'prn_dusty',
  conversationId: 'cnv_chat',
  threadRootId: null,
  key: '1:toolu_1',
  attempt: 1,
  seq: 1,
  kind: 'command',
  tool: 'Bash',
  status: 'running',
  title: 'Running pnpm test',
  object: 'pnpm test',
  detail: null,
  important: true,
  approvalId: null,
  link: null,
  evidence: null,
  startedAt: t(1),
  updatedAt: t(1),
  finishedAt: null,
  ...o,
});

export const workItem = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: 'run:run_1907',
  kind: 'run',
  section: 'running',
  title: 'Run #1907 · Invoice PDF export',
  where: 'Chat',
  agentId: 'prn_dusty',
  ownerId: 'prn_mara',
  status: { text: 'LIVE', tone: 'ok' },
  detail: null,
  since: t(0),
  health: null,
  activity: null,
  link: { type: 'run', number: 1907 },
  actions: ['pause', 'take_over', 'open'],
  refs: {
    conversationId: 'cnv_chat',
    messageId: null,
    runNumber: 1907,
    runId: 'run_1907',
    approvalNumber: null,
    approvalId: null,
    planId: null,
    stepId: null,
    automationRunNumber: null,
    automationRunId: null,
    dispatchId: 'dsp_1',
  },
  ...o,
});

export const workOverview = (items: WorkItem[] = [workItem()]): WorkOverview => ({
  sections: (['needs_you', 'running', 'queued', 'blocked', 'failed', 'done'] as const).map((section) => ({
    section,
    title: section.toUpperCase(),
    items: items.filter((i) => i.section === section),
  })),
  counts: {
    needs_you: items.filter((i) => i.section === 'needs_you').length,
    running: items.filter((i) => i.section === 'running').length,
    queued: items.filter((i) => i.section === 'queued').length,
    blocked: items.filter((i) => i.section === 'blocked').length,
    failed: items.filter((i) => i.section === 'failed').length,
    done: items.filter((i) => i.section === 'done').length,
  },
  generatedAt: t(0),
});
