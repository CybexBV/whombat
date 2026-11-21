/** Dispatch contexts from the mock world (Burrow HQ, 23 Sep 2026 11:22) for persona and smoke tests. */
import { DispatchContext } from '@whombat/core/contracts';
import type { Message } from '@whombat/core/domain';
import { KEY_CATALOG, type KeyId } from '@whombat/core/keys';

const TZ = 'Europe/Amsterdam';
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 8, 23, h - 2, m)).toISOString();
};
const key = (id: KeyId) => ({ id, label: KEY_CATALOG[id].label });

export function message(
  id: string,
  authorId: string,
  time: string,
  text: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    conversationId: 'cnv_billing-v2',
    authorId,
    createdAt: at(time),
    editedAt: null,
    text,
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...extra,
  };
}

const principals = [
  {
    id: 'prn_mara',
    kind: 'person',
    name: 'Mara Okafor',
    handle: 'mara',
    role: null,
    title: 'Engineering lead',
  },
  { id: 'prn_joris', kind: 'person', name: 'Joris de Vries', handle: 'joris', role: null, title: null },
  { id: 'prn_dusty', kind: 'agent', name: 'Dusty', handle: 'dusty', role: 'developer', title: null },
  { id: 'prn_priya', kind: 'person', name: 'Priya Raman', handle: 'priya', role: null, title: null },
] as const;

export function base(overrides: Record<string, unknown> = {}) {
  return {
    dispatch: {
      id: 'dsp_dusty1',
      burrowId: 'bur_burrow-hq',
      agentId: 'prn_dusty',
      trigger: 'mention',
      mode: 'reply',
      conversationId: 'cnv_billing-v2',
      messageId: 'msg_m7',
      threadRootId: null,
      runId: null,
      state: 'claimed',
      providerSessionId: null,
      runnerId: 'rnr_local',
      error: null,
      createdAt: at('11:22'),
      claimedAt: at('11:22'),
      finishedAt: null,
      postedAt: null,
    },
    burrow: { id: 'bur_burrow-hq', slug: 'burrow-hq', name: 'Burrow HQ', timeZone: TZ },
    agent: {
      id: 'prn_dusty',
      name: 'Dusty',
      face: 'dusty',
      handle: 'dusty',
      role: 'developer',
      roleLabel: 'Software Developer',
      job: 'Writes, refactors and tests code in connected repositories.',
      runtime: { provider: 'claude' },
      channels: [
        { id: 'cnv_billing-v2', title: 'billing-v2' },
        { id: 'cnv_incidents', title: 'incidents' },
      ],
      keys: {
        can: [key('repos.read'), key('branch.feature.readwrite'), key('tests.run')],
        ask: [key('deploy.staging')],
        cannot: [key('merge.main')],
      },
    },
    conversation: {
      id: 'cnv_billing-v2',
      kind: 'branch',
      title: 'billing-v2',
      topic: 'PDF invoices by the 14th',
      link: { type: 'pr', number: 482 },
    },
    trigger: message('msg_m7', 'prn_mara', '11:22', 'Typeset works for me. @Dusty go for it.', {
      mentions: ['prn_dusty'],
    }),
    window: [
      message(
        'msg_m1',
        'prn_mara',
        '09:14',
        'Morning. Finance wants PDF invoices by the 14th. @Dusty can you break this down?',
      ),
      message(
        'msg_m5',
        'prn_joris',
        '11:05',
        'Two changes on PR #482, one of them matters. Details are in the branch room.',
        {
          card: { kind: 'pill', text: '38 of 41 passed · 3 failing in invoice_format_test', tone: 'warn' },
          replyCount: 2,
        },
      ),
    ],
    thread: null,
    principals,
    run: null,
    planStep: null,
    search: null,
    workspace: null,
    commands: null,
    outside: false,
    gh: null,
    vault: null,
    files: null,
    gateway: null,
    localModel: null,
    webSearch: null,
    schedule: null,
    facts: [
      'Dutch tax rules need an unbroken invoice number sequence per year.',
      'Amounts are euros, formatted nl-NL.',
    ],
    // The person's turn (one-person.md OP-01): every turn but an outsiders' is theirs.
    onBehalfOf: { person: principals[0], accountId: 'acc_mara', connections: [] },
    attachments: [],
    memory: null,
    skills: null,
    agentToken: { token: 'tok_x', expiresAt: at('12:22') },
    mcpPath: '/mcp',
    now: at('11:22'),
    ...overrides,
  };
}

export const mention = DispatchContext.parse(base());

export const threadReply = DispatchContext.parse(
  base({
    dispatch: { ...base().dispatch, threadRootId: 'msg_m5', messageId: 'msg_r2' },
    trigger: message('msg_r2', 'prn_mara', '11:30', '@Dusty does this touch credit notes too?', {
      threadRootId: 'msg_m5',
      mentions: ['prn_dusty'],
    }),
    thread: {
      root: message('msg_m5', 'prn_joris', '11:05', 'Two changes on PR #482, one of them matters.', {
        replyCount: 2,
      }),
      replies: [
        message('msg_r1', 'prn_dusty', '11:06', 'Fixing both now.', { threadRootId: 'msg_m5' }),
        message('msg_r2', 'prn_mara', '11:30', '@Dusty does this touch credit notes too?', {
          threadRootId: 'msg_m5',
        }),
      ],
    },
  }),
);

export const coding = DispatchContext.parse(
  base({
    dispatch: { ...base().dispatch, mode: 'run', trigger: 'run_control', runId: 'run_1907' },
    conversation: {
      id: 'cnv_pr482',
      kind: 'branch',
      title: 'feat/invoice-pdf',
      topic: 'Invoice PDF export',
      link: { type: 'pr', number: 482 },
    },
    trigger: null,
    window: [],
    run: {
      id: 'run_1907',
      number: 1907,
      burrowId: 'bur_burrow-hq',
      agentId: 'prn_dusty',
      title: 'Round VAT before formatting',
      branch: 'feat/invoice-pdf',
      repoId: null,
      prNumber: 482,
      status: 'paused',
      askedById: 'prn_joris',
      conversationId: 'cnv_pr482',
      messageId: null,
      startedAt: at('11:07'),
      finishedAt: null,
      progress: 60,
      activity: 'Running invoice_format_test',
      summary: null,
      steps: [
        { title: 'Read the review', detail: '2 comments', at: at('11:07'), state: 'done' },
        { title: 'Fix rounding order', detail: 'format.ts', at: at('11:09'), state: 'active' },
        { title: 'Run the tests', detail: '', at: null, state: 'queued' },
      ],
      tests: null,
      files: [],
      diff: { add: 0, del: 0, files: 0 },
      keysUsed: [],
      logCount: 12,
      pausedById: 'prn_joris',
      takenOverById: null,
    },
    workspace: {
      repo: 'burrowhq/billing-api',
      branch: 'feat/invoice-pdf',
      baseBranch: 'main',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/burrowhq/billing-api.git',
    },
  }),
);

export const answer = DispatchContext.parse(
  base({
    dispatch: {
      ...base().dispatch,
      agentId: 'prn_dusty',
      trigger: 'search',
      mode: 'answer',
      messageId: null,
    },
    agent: {
      ...base().agent,
      id: 'prn_dusty',
      name: 'Dusty',
      face: 'dusty',
      handle: 'dusty',
      role: 'associate',
      roleLabel: 'Associate',
      focus: 'research',
      job: 'Digs through messages, docs, runs and the web, and answers with receipts.',
      keys: { can: [key('messages.search'), key('web.browse')], ask: [], cannot: [] },
    },
    trigger: null,
    window: [],
    search: {
      query: 'what did we decide about invoice numbering?',
      answerId: 'ans_q1',
      results: [
        {
          id: 'res_1',
          type: 'THREAD',
          where: '#billing-v2 · 12 Nov 2025',
          authorId: 'prn_priya',
          snippet: 'Yearly sequences with a prefix, like 2026-000142.',
          citedAs: null,
          link: { type: 'pr', number: 482 },
          createdAt: '2025-11-12T10:00:00.000Z',
        },
      ],
    },
  }),
);

/** A turn for Mara in her Chat with the agent (one-agent.md OA-10; connectors.md PA-10), with Google connected. */
export const personal = DispatchContext.parse(
  base({
    dispatch: {
      ...base().dispatch,
      id: 'dsp_chat1',
      agentId: 'prn_dusty',
      trigger: 'dm',
      conversationId: 'cnv_dm-dusty',
      messageId: 'msg_t1',
    },
    agent: {
      ...base().agent,
      id: 'prn_dusty',
      name: 'Dusty',
      face: 'dusty',
      handle: 'dusty',
      keys: {
        can: [key('messages.search'), key('mail.read'), key('calendar.read'), key('files.read')],
        ask: [key('mail.send'), key('calendar.invite'), key('files.share'), key('files.delete')],
        cannot: [],
      },
    },
    conversation: {
      id: 'cnv_dm-dusty',
      kind: 'dm',
      title: 'Chat',
      topic: '',
      link: { type: 'dm' },
    },
    trigger: message('msg_t1', 'prn_mara', '11:22', 'What’s on my calendar tomorrow?'),
    window: [],
    principals,
    outside: false,
    onBehalfOf: {
      person: principals[0],
      accountId: 'acc_mara',
      connections: [
        {
          provider: 'google',
          email: 'mara@gmail.com',
          services: ['mail', 'calendar', 'files', 'docs', 'sheets'],
        },
      ],
    },
  }),
);
