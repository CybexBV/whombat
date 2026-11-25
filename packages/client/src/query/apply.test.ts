/**
 * Table-driven tests for `applyRealtimeEvent`: one case per RealtimeEvent type. Every case is run
 * three ways and must end in the same cache:
 *   1. in order (and the case's own assertions hold),
 *   2. every event delivered twice (duplicates),
 *   3. in reverse order (out-of-order delivery: newer `at` wins, tombstones and append-once hold).
 */

import { QueryClient, type QueryKey, QueryObserver } from '@tanstack/query-core';
import {
  type Activity,
  type AgentProfile,
  type ApprovalResponse,
  type AuditPage,
  type Automation,
  type AutomationRun,
  api,
  type Bootstrap,
  type CanvasDetail,
  type ConversationDetail,
  type DispatchSummary,
  type InboxResponse,
  type Message,
  type MessagePage,
  type Plan,
  type PullRequestDetail,
  REALTIME_EVENT_TOPICS,
  type RealtimeEvent,
  type RealtimeEventType,
  type RunDetail,
  type SearchResponse,
  type SubscriptionUsage,
  type ThreadView,
  type WorkOverview,
} from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { DESK_QUERY_KEY } from '../desk/react';
import {
  activity,
  agent,
  answer,
  approval,
  auditEvent,
  BURROW,
  BURROW_ID,
  bootstrap,
  burrow,
  canvas,
  comment,
  conversation,
  inboxItem,
  message,
  person,
  plan,
  pr,
  run,
  summary,
  t,
  workOverview,
} from '../test/fixtures';
import { applyRealtimeEvent, createCacheSyncState, invalidateNeedsYouCount } from './apply';
import { endpointKey, infiniteEndpointKey, QUERY_ROOT, queryKeys } from './keys';

const NOW = Date.parse(t(30));
const B = { burrow: BURROW };
const CONV = { ...B, conversationId: 'cnv_chat' };

type Step = [RealtimeEvent, number];

interface Case {
  type: RealtimeEventType;
  name: string;
  seed: (qc: QueryClient) => void;
  events: Step[];
  check: (qc: QueryClient) => void;
}

const get = <T>(qc: QueryClient, key: QueryKey) => qc.getQueryData(key) as T;

const k = {
  bootstrap: endpointKey(api.conversations.bootstrap, { params: B }),
  messages: endpointKey(api.messages.list, { params: CONV }),
  thread: endpointKey(api.messages.thread, { params: { ...B, messageId: 'msg_1' } }),
  message2: endpointKey(api.messages.get, { params: { ...B, messageId: 'msg_2' } }),
  run: endpointKey(api.runs.get, { params: { ...B, number: 1907 } }),
  runs: endpointKey(api.runs.list, { params: B }),
  runsLive: endpointKey(api.runs.list, { params: B, query: { status: 'live' } }),
  runLog: endpointKey(api.runs.log, { params: { ...B, number: 1907 }, query: { after: 1 } }),
  approval: endpointKey(api.approvals.get, { params: { ...B, number: 12 } }),
  pending: endpointKey(api.approvals.list, { params: B, query: { state: 'pending' } }),
  approvals: endpointKey(api.approvals.list, { params: B }),
  pr: endpointKey(api.prs.get, { params: { ...B, number: 482 } }),
  openPrs: endpointKey(api.prs.list, { params: B, query: { state: 'open' } }),
  inbox: endpointKey(api.notifications.inbox, { params: B }),
  mentions: endpointKey(api.notifications.inbox, { params: B, query: { filter: 'mentions' } }),
  audit: endpointKey(api.audit.list, { params: B }),
  auditKeys: endpointKey(api.audit.list, { params: B, query: { kind: 'keys' } }),
  auditAgent: infiniteEndpointKey(api.audit.list, { params: B, query: { who: 'dusty' } }),
  plan: endpointKey(api.plans.get, { params: { ...B, planId: 'pln_billing' } }),
  canvas: endpointKey(api.canvases.get, { params: { ...B, slug: 'billing-v2-plan' } }),
  canvases: endpointKey(api.canvases.list, { params: B }),
  agent: endpointKey(api.agent.get, { params: B }),
  services: endpointKey(api.services.list, { params: B }),
  conv: endpointKey(api.conversations.get, { params: CONV }),
  convs: endpointKey(api.conversations.list, { params: B }),
  search: endpointKey(api.search.query, { params: B, query: { q: 'vat rounding' } }),
  answer: endpointKey(api.search.getAnswer, { params: { ...B, answerId: 'ans_1' } }),
  burrow: endpointKey(api.burrows.get, { params: B }),
  me: endpointKey(api.me.get),
  automations: endpointKey(api.automations.list, { params: B }),
  automation: endpointKey(api.automations.get, { params: { ...B, id: 'aut_1' } }),
  automationRuns: endpointKey(api.automations.runs, { params: B, query: { automation: 'aut_1' } }),
  automationRun: endpointKey(api.automations.run, { params: { ...B, number: 1 } }),
  plans: endpointKey(api.plans.list, { params: B, query: { conversationId: 'cnv_chat' } }),
  activityRun: endpointKey(api.activity.list, { params: B, query: { runNumber: 1907 } }),
  activityConv: endpointKey(api.activity.list, { params: B, query: { conversationId: 'cnv_chat' } }),
  activityOther: endpointKey(api.activity.list, { params: B, query: { dispatchId: 'dsp_other' } }),
  work: endpointKey(api.work.overview, { params: B }),
  vault: endpointKey(api.vault.list, { params: B }),
  vaultHa: endpointKey(api.vault.get, { params: { ...B, entryId: 'vlt_homeassistant' } }),
  vaultGrafana: endpointKey(api.vault.get, { params: { ...B, entryId: 'vlt_grafana' } }),
  vaultNetworks: endpointKey(api.vaultNetworks.list),
  filesSummary: endpointKey(api.files.summary, { params: B }),
  filesBilling: endpointKey(api.files.list, { params: { ...B, conversationId: 'cnv_chat' } }),
  filesGeneral: endpointKey(api.files.list, { params: { ...B, conversationId: 'cnv_feedback' } }),
  usage: endpointKey(api.usage.list, { params: B }),
  backups: endpointKey(api.backups.list, { params: B }),
  home: endpointKey(api.home.overview, { params: B }),
  watch: endpointKey(api.watch.list, { params: B }),
  widgets: endpointKey(api.widgets.list, { params: B }),
  hostsFleet: endpointKey(api.hosts.fleet, { params: B }),
  hostsGuests: endpointKey(api.hosts.listGuests, { params: B }),
  hostsAlerts: endpointKey(api.hosts.listAlerts, { params: B }),
  hostsEnrollments: endpointKey(api.hosts.listEnrollments, { params: B }),
  hostsAddressChange: endpointKey(api.hosts.addressChange, { params: B }),
  hostsRepoint: endpointKey(api.hosts.getRepoint, { params: { ...B, repointId: 'rpt_1' } }),
  chatRuntime: endpointKey(api.chats.runtime, { params: B, query: { thread: 'msg_1' } }),
  chatRuntimeTop: endpointKey(api.chats.runtime, { params: B }),
  handoffs: endpointKey(api.conversations.handoffs, { params: CONV }),
  chatThreadsPaged: infiniteEndpointKey(api.chats.threads, { params: B }),
  chatThreadsOpen: infiniteEndpointKey(api.chats.threads, { params: B, query: { state: 'open' } }),
  chatThreadsSettled: infiniteEndpointKey(api.chats.threads, { params: B, query: { state: 'settled' } }),
  backupFile: endpointKey(api.backups.get, { params: { ...B, backupFileId: 'bkf_aaaaaaaaaaaa' } }),
  otherBackupFile: endpointKey(api.backups.get, { params: { ...B, backupFileId: 'bkf_bbbbbbbbbbbb' } }),
  backupRestore: endpointKey(api.backups.getRestore, { params: { ...B, restoreId: 'bkr_aaaaaaaaaaaa' } }),
  deployments: endpointKey(api.deployments.list, { params: B }),
  deployBoard: endpointKey(api.deployments.environments, { params: B }),
};

const usageSnapshot: SubscriptionUsage = {
  provider: 'claude',
  kind: 'subscription',
  connected: true,
  plan: 'max',
  windows: [{ kind: 'five_hour', label: '5-hour', usedPct: 85, resetsAt: t(9), status: 'warning' }],
  observedAt: t(1),
  source: 'probe',
  error: null,
};

/** A turn as `dispatch.updated` carries it (WS-19). */
function dispatchSummary(over: Partial<DispatchSummary> = {}): DispatchSummary {
  return {
    id: 'dsp_1',
    agentId: 'prn_banjo',
    conversationId: 'cnv_chat',
    threadRootId: null,
    trigger: 'mention',
    state: 'queued',
    runId: null,
    createdAt: t(1),
    claimedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    reason: null,
    ...over,
  };
}

/** An automation as the server sends it (docs/decisions/bp-automations.md). */
function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'aut_1',
    burrowId: BURROW_ID,
    name: 'Suspected bug',
    description: '',
    status: 'published',
    currentVersion: 1,
    draft: null,
    draftJson: null,
    draftProblems: [],
    draftHash: null,
    definition: null,
    principalId: 'prn_auto',
    createdById: 'prn_mara',
    createdAt: t(0),
    updatedAt: t(0),
    publishedById: 'prn_mara',
    triggerSummary: 'Message in #billing-v2',
    summary: '',
    deletedAt: null,
    grants: [],
    webhook: { enabled: false, hasSecret: false, path: '/webhooks/automations/aut_1' },
    nextRunAt: null,
    lastRun: null,
    recentRuns: [],
    glance: null,
    waitingPlanId: null,
    talk: null,
    ...over,
  };
}

function automationRun(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'arn_1',
    number: 1,
    burrowId: BURROW_ID,
    automationId: 'aut_1',
    automationName: 'Suspected bug',
    version: 1,
    status: 'running',
    trigger: {
      kind: 'manual',
      summary: 'Run by Mara',
      actorId: 'prn_mara',
      eventId: null,
      messageId: null,
      scheduledFor: null,
    },
    conversationId: 'cnv_chat',
    threadRootId: null,
    causalDepth: 0,
    startedById: 'prn_mara',
    test: false,
    createdAt: t(0),
    startedAt: t(0),
    finishedAt: null,
    error: null,
    tokens: null,
    steps: [],
    ...over,
  };
}

const page = (messages: ReturnType<typeof message>[], hasMore = false): MessagePage => ({
  messages,
  before: hasMore ? 'cur' : null,
  hasMore,
});

const runDetail = (r = run()): RunDetail => ({ run: r, log: [], grants: [], conversation: summary() });
const agentProfile = (): AgentProfile => ({
  agent: agent('dusty'),
  grants: [],
  keys: { keys: 3, askFirst: 0 },
  recent: [],
  currentRun: { number: 1907, status: 'live', title: 'Invoice PDF export' },
  modelFallback: null,
});
const emptyAudit = (): AuditPage => ({
  events: [],
  counts: { all: 0, code: 0, asks: 0, keys: 0, vault: 0, messages: 0, blocked: 0 },
  before: null,
  hasMore: false,
});
const emptyInbox = (): InboxResponse => ({
  sections: [],
  counts: { all: 0, needs_you: 0, mentions: 0, agents: 0 },
  unread: 0,
});
const convDetail = (): ConversationDetail => ({
  conversation: conversation(),
  summary: summary(),
  pr: null,
  lastReadMessageId: null,
});

const cases: Case[] = [
  {
    type: 'message.created',
    name: 'appends messages and thread replies, edits win over the create',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.messages, page([message('msg_1')]));
      qc.setQueryData(k.thread, {
        root: message('msg_1'),
        replies: [],
        more: null,
        conversationId: 'cnv_chat',
        where: 'Chat',
        topic: null,
      });
    },
    events: [
      [{ type: 'message.created', message: message('msg_2', { createdAt: t(1), text: 'first' }) }, 1],
      [
        { type: 'message.created', message: message('msg_r1', { createdAt: t(2), threadRootId: 'msg_1' }) },
        2,
      ],
      [{ type: 'message.updated', message: message('msg_2', { createdAt: t(1), text: 'edited' }) }, 3],
    ],
    check: (qc) => {
      expect(get<MessagePage>(qc, k.messages).messages.map((m) => [m.id, m.text])).toEqual([
        ['msg_1', 'Hello'],
        ['msg_2', 'edited'],
      ]);
      expect(get<ThreadView>(qc, k.thread).replies.map((m) => m.id)).toEqual(['msg_r1']);
      expect(get<Bootstrap>(qc, k.bootstrap).sidebar.dms[0]?.lastMessageAt).toBe(t(2));
    },
  },
  {
    type: 'message.created',
    name: 'infinite pages: new messages go to the newest page, history outside the window is skipped',
    seed: (qc) => {
      const key = infiniteEndpointKey(api.messages.list, { params: CONV });
      qc.setQueryData(key, {
        pages: [
          page([message('msg_5', { createdAt: t(5) })], true),
          page([message('msg_3', { createdAt: t(3) })], true),
        ],
        pageParams: [undefined, 'c1'],
      });
    },
    events: [
      [{ type: 'message.created', message: message('msg_6', { createdAt: t(6) }) }, 6],
      [{ type: 'message.created', message: message('msg_4', { createdAt: t(4) }) }, 7],
      [{ type: 'message.created', message: message('msg_1', { createdAt: t(1) }) }, 8],
    ],
    check: (qc) => {
      const data = get<{ pages: MessagePage[] }>(
        qc,
        infiniteEndpointKey(api.messages.list, { params: CONV }),
      );
      expect(data.pages.map((p) => p.messages.map((m) => m.id))).toEqual([
        ['msg_5', 'msg_6'],
        ['msg_3', 'msg_4'],
      ]);
    },
  },
  {
    type: 'message.updated',
    name: 'reactions and replies counts replace the message everywhere',
    seed: (qc) => {
      qc.setQueryData(k.messages, page([message('msg_1'), message('msg_2', { createdAt: t(1) })]));
      qc.setQueryData(k.message2, { message: message('msg_2', { createdAt: t(1) }) });
    },
    events: [
      [
        {
          type: 'message.updated',
          message: message('msg_2', {
            createdAt: t(1),
            reactions: [{ value: '+1', count: 1, mine: false, principalIds: ['prn_banjo'] }],
          }),
        },
        2,
      ],
      [
        {
          type: 'message.updated',
          message: message('msg_2', {
            createdAt: t(1),
            replyCount: 2,
            reactions: [{ value: '+1', count: 2, mine: true, principalIds: ['prn_banjo', 'prn_mara'] }],
          }),
        },
        3,
      ],
    ],
    check: (qc) => {
      const m = get<MessagePage>(qc, k.messages).messages[1];
      expect(m?.reactions[0]?.count).toBe(2);
      expect(m?.replyCount).toBe(2);
      expect(get<{ message: { replyCount: number } }>(qc, k.message2).message.replyCount).toBe(2);
    },
  },
  {
    type: 'message.deleted',
    name: 'removes the message and keeps it gone',
    seed: (qc) => {
      qc.setQueryData(k.messages, page([message('msg_1'), message('msg_2', { createdAt: t(1) })]));
      qc.setQueryData(k.message2, { message: message('msg_2', { createdAt: t(1) }) });
    },
    events: [
      [{ type: 'message.updated', message: message('msg_2', { createdAt: t(1), text: 'oops' }) }, 1],
      [{ type: 'message.deleted', conversationId: 'cnv_chat', messageId: 'msg_2' }, 2],
    ],
    check: (qc) => {
      expect(get<MessagePage>(qc, k.messages).messages.map((m) => m.id)).toEqual(['msg_1']);
      expect(qc.getQueryData(k.message2)).toBeUndefined();
    },
  },
  {
    type: 'typing',
    name: 'tracks the agent thinking per thread, clears on active false',
    seed: () => {},
    events: [
      [
        {
          type: 'typing',
          conversationId: 'cnv_chat',
          threadRootId: null,
          principalId: 'prn_banjo',
          active: true,
          expiresAt: t(26),
          // The turn that thinks (contracts 0.55, CT-295): what Stop cancels.
          dispatchId: 'dsp_banjo',
        },
        25,
      ],
      [
        {
          type: 'typing',
          conversationId: 'cnv_chat',
          threadRootId: 'msg_1',
          principalId: 'prn_banjo',
          active: true,
          expiresAt: t(26),
        },
        25,
      ],
      [
        {
          type: 'typing',
          conversationId: 'cnv_chat',
          threadRootId: 'msg_1',
          principalId: 'prn_banjo',
          active: false,
          expiresAt: t(26),
        },
        26,
      ],
    ],
    check: (qc) => {
      expect(qc.getQueryData(queryKeys.typing('cnv_chat'))).toEqual([
        {
          principalId: 'prn_banjo',
          threadRootId: null,
          expiresAt: NOW + 6000,
          dispatchId: 'dsp_banjo',
        },
      ]);
    },
  },
  {
    type: 'run.updated',
    name: 'run page, run list, run card and the roster follow the run',
    seed: (qc) => {
      qc.setQueryData(k.run, runDetail());
      qc.setQueryData(k.runs, { runs: [run({ id: 'run_1', number: 1, startedAt: t(-60) })] });
      qc.setQueryData(k.runsLive, { runs: [run()] });
      qc.setQueryData(k.messages, page([message('msg_run', { card: { kind: 'run', run: run() } })]));
      qc.setQueryData(k.agent, agentProfile());
    },
    events: [
      [{ type: 'run.updated', run: run({ progress: 80 }) }, 1],
      [{ type: 'run.updated', run: run({ progress: 100, status: 'done', summary: 'Pushed 7be20f.' }) }, 2],
    ],
    check: (qc) => {
      expect(get<RunDetail>(qc, k.run).run.status).toBe('done');
      expect(get<{ runs: { id: string }[] }>(qc, k.runs).runs.map((r) => r.id)).toEqual([
        'run_1907',
        'run_1',
      ]);
      expect(get<{ runs: unknown[] }>(qc, k.runsLive).runs).toEqual([]);
      const card = get<MessagePage>(qc, k.messages).messages[0]?.card;
      expect(card?.kind === 'run' && card.run.progress).toBe(100);
      expect(get<AgentProfile>(qc, k.agent).currentRun).toBeNull();
    },
  },
  {
    type: 'run.log',
    name: 'merges log lines by seq',
    seed: (qc) => {
      qc.setQueryData(k.run, {
        ...runDetail(run({ logCount: 2 })),
        log: [
          { seq: 0, at: t(0), text: '$ git checkout -b feat/invoice-pdf' },
          { seq: 1, at: t(1), text: 'Reading billing/pdf' },
        ],
      });
      qc.setQueryData(k.runLog, { lines: [], hasMore: false });
    },
    events: [
      [
        {
          type: 'run.log',
          runId: 'run_1907',
          runNumber: 1907,
          lines: [
            { seq: 2, at: t(2), text: 'a' },
            { seq: 3, at: t(3), text: 'b' },
          ],
        },
        3,
      ],
      [
        {
          type: 'run.log',
          runId: 'run_1907',
          runNumber: 1907,
          lines: [
            { seq: 3, at: t(3), text: 'b' },
            { seq: 4, at: t(4), text: 'c' },
          ],
        },
        4,
      ],
    ],
    check: (qc) => {
      const d = get<RunDetail>(qc, k.run);
      expect(d.log.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(d.run.logCount).toBe(5);
      expect(get<{ lines: { seq: number }[] }>(qc, k.runLog).lines.map((l) => l.seq)).toEqual([2, 3, 4]);
    },
  },
  {
    type: 'approval.updated',
    name: 'modal, lists, card, branch pane, inbox and audit follow the approval',
    seed: (qc) => {
      qc.setQueryData(k.approval, { approval: approval(), eventId: null });
      qc.setQueryData(k.pending, { approvals: [approval()], before: null });
      qc.setQueryData(k.approvals, { approvals: [], before: null });
      qc.setQueryData(
        k.messages,
        page([message('msg_apr', { card: { kind: 'approval', approval: approval() } })]),
      );
      qc.setQueryData(k.pr, {
        pr: pr(),
        status: 'changes_requested',
        mergeBlock: 'review',
        staging: approval(),
      });
      qc.setQueryData(k.inbox, {
        ...emptyInbox(),
        sections: [
          {
            kind: 'needs_you',
            title: 'NEEDS YOU',
            items: [inboxItem('ntf_1', { approvalId: 'apr_12', approval: approval() })],
          },
        ],
      });
      qc.setQueryData(k.audit, {
        ...emptyAudit(),
        events: [
          auditEvent('evt_ask', {
            type: 'approval.requested',
            kind: 'Asks',
            approvalId: 'apr_12',
            approval: { number: 12, state: 'pending', decidedById: null, decidedAt: null, executedAt: null },
          }),
        ],
      });
    },
    events: [
      [
        {
          type: 'approval.updated',
          approval: approval({ state: 'approved', decidedById: 'prn_mara', decidedAt: t(20) }),
        },
        20,
      ],
      [
        {
          type: 'approval.updated',
          approval: approval({
            state: 'approved',
            decidedById: 'prn_mara',
            decidedAt: t(20),
            executedAt: t(22),
          }),
        },
        22,
      ],
    ],
    check: (qc) => {
      expect(get<ApprovalResponse>(qc, k.approval).approval.executedAt).toBe(t(22));
      expect(get<{ approvals: unknown[] }>(qc, k.pending).approvals).toEqual([]);
      expect(get<{ approvals: { id: string }[] }>(qc, k.approvals).approvals.map((a) => a.id)).toEqual([
        'apr_12',
      ]);
      const card = get<MessagePage>(qc, k.messages).messages[0]?.card;
      expect(card?.kind === 'approval' && card.approval.state).toBe('approved');
      expect(get<PullRequestDetail>(qc, k.pr).staging?.executedAt).toBe(t(22));
      expect(get<InboxResponse>(qc, k.inbox).sections[0]?.items[0]?.approval?.state).toBe('approved');
      expect(get<AuditPage>(qc, k.audit).events[0]?.approval).toEqual({
        number: 12,
        state: 'approved',
        decidedById: 'prn_mara',
        decidedAt: t(20),
        executedAt: t(22),
      });
    },
  },
  {
    type: 'plan.updated',
    name: 'plan, plan card and canvas plan block',
    seed: (qc) => {
      qc.setQueryData(k.plan, { plan: plan() });
      qc.setQueryData(k.plans, { plans: [plan()] });
      qc.setQueryData(k.messages, page([message('msg_plan', { card: { kind: 'plan', plan: plan() } })]));
      qc.setQueryData(k.canvas, {
        canvas: canvas(),
        conversationTitle: 'Chat',
        plan: plan(),
        comments: [],
        presentIds: [],
        documentName: 'cvs_plan',
      });
    },
    events: [
      [{ type: 'plan.updated', plan: plan({ title: 'Billing v2 (draft)', updatedAt: t(1) }) }, 1],
      [{ type: 'plan.updated', plan: plan({ title: 'Billing v2 · final', updatedAt: t(2) }) }, 2],
    ],
    check: (qc) => {
      expect(get<{ plan: { title: string } }>(qc, k.plan).plan.title).toBe('Billing v2 · final');
      const card = get<MessagePage>(qc, k.messages).messages[0]?.card;
      expect(card?.kind === 'plan' && card.plan.title).toBe('Billing v2 · final');
      expect(get<CanvasDetail>(qc, k.canvas).plan?.title).toBe('Billing v2 · final');
      expect(get<{ plans: Plan[] }>(qc, k.plans).plans.map((p) => p.title)).toEqual(['Billing v2 · final']);
    },
  },
  {
    type: 'activity.updated',
    name: 'activity feeds by run and conversation, the Work item’s latest row',
    seed: (qc) => {
      qc.setQueryData(k.run, { run: run(), log: [], grants: [], conversation: summary() });
      const empty = { activities: [], cursor: null, hasMore: false };
      qc.setQueryData(k.activityRun, empty);
      qc.setQueryData(k.activityConv, empty);
      qc.setQueryData(k.activityOther, empty);
      qc.setQueryData(k.work, workOverview());
    },
    events: [
      [{ type: 'activity.updated', activity: activity() }, 1],
      [
        {
          type: 'activity.updated',
          activity: activity({
            seq: 2,
            status: 'failed',
            title: 'Command failed',
            detail: 'exit 1',
            updatedAt: t(2),
            finishedAt: t(2),
          }),
        },
        2,
      ],
      [
        {
          type: 'activity.updated',
          activity: activity({
            id: 'act_2',
            key: '1:toolu_2',
            seq: 3,
            kind: 'read',
            tool: 'Read',
            status: 'done',
            title: 'Read invoice.ts',
            object: 'billing/pdf/invoice.ts',
            important: false,
            startedAt: t(3),
            updatedAt: t(3),
          }),
        },
        3,
      ],
    ],
    check: (qc) => {
      for (const key of [k.activityRun, k.activityConv]) {
        const d = get<{ activities: Activity[] }>(qc, key);
        expect(d.activities.map((a) => [a.id, a.status])).toEqual([
          ['act_1', 'failed'],
          ['act_2', 'done'],
        ]);
      }
      expect(get<{ activities: Activity[] }>(qc, k.activityOther).activities).toEqual([]);
      const item = get<WorkOverview>(qc, k.work).sections.find((s) => s.section === 'running')?.items[0];
      // Only important rows become the item's latest activity.
      expect(item?.activity?.title).toBe('Command failed');
      // Beside “Banjo is thinking”: the newest action, the turn's clock from its first (AP-734).
      const now = qc.getQueryData(queryKeys.agentNow('cnv_chat')) ?? [];
      expect(now.map((e) => [e.title, e.status, e.seq])).toEqual([['Read invoice.ts', 'done', 3]]);
      expect(now[0]?.since).toBeLessThan(Date.parse(t(3)));
    },
  },
  {
    type: 'dispatch.updated',
    name: 'the Work view refetches when a turn moves',
    seed: (qc) => {
      qc.setQueryData(k.work, workOverview());
    },
    events: [
      [{ type: 'dispatch.updated', dispatch: dispatchSummary() }, 1],
      [{ type: 'dispatch.updated', dispatch: dispatchSummary({ state: 'running', claimedAt: t(2) }) }, 2],
    ],
    check: (qc) => {
      expect(qc.getQueryState(k.work)?.isInvalidated).toBe(true);
      expect(get<WorkOverview>(qc, k.work).counts.running).toBe(1);
    },
  },
  {
    type: 'vault.updated',
    name: 'the Vault refetches the changed entry, the list and the profile pane’s keys',
    seed: (qc) => {
      qc.setQueryData(k.vault, { entries: [], canAdd: true });
      // Only whether they refetch matters here, not what an entry holds.
      qc.setQueryData(k.vaultHa, { entry: {}, eligibleAgentIds: [] } as never);
      qc.setQueryData(k.vaultGrafana, { entry: {}, eligibleAgentIds: [] } as never);
      qc.setQueryData(k.vaultNetworks, { networks: [], max: 32 });
    },
    events: [[{ type: 'vault.updated', entryId: 'vlt_homeassistant' }, 1]],
    check: (qc) => {
      for (const key of [k.vault, k.vaultHa]) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.vaultGrafana)?.isInvalidated).toBe(false);
      expect(qc.getQueryState(k.vaultNetworks)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'usage.updated',
    name: 'the usage list refetches (CT-155)',
    seed: (qc) => {
      qc.setQueryData(k.usage, { mine: [] });
    },
    events: [[{ type: 'usage.updated', usage: usageSnapshot }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.usage)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'backups.changed',
    name: 'the backup list and that file’s view refetch (CT-335, backup-file.md)',
    seed: (qc) => {
      qc.setQueryData(k.backups, { files: [], uploads: [], restores: [] });
      // Only whether they refetch matters here, not what a view holds.
      qc.setQueryData(k.backupFile, { file: {} } as never);
      qc.setQueryData(k.otherBackupFile, { file: {} } as never);
      qc.setQueryData(k.backupRestore, { restore: {} } as never);
    },
    events: [[{ type: 'backups.changed', kind: 'file', id: 'bkf_aaaaaaaaaaaa' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.backups)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.backupFile)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.otherBackupFile)?.isInvalidated).toBe(false);
      expect(qc.getQueryState(k.backupRestore)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'home.changed',
    name: 'Home refetches, and Watch when it changed (contracts 0.80, CT-336)',
    seed: (qc) => {
      qc.setQueryData(k.home, {} as never);
      qc.setQueryData(k.watch, { items: [] });
      qc.setQueryData(k.widgets, { widgets: [] });
    },
    events: [[{ type: 'home.changed', parts: ['needsYou', 'watch'] }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.home)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.watch)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.widgets)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'desk.changed',
    name: 'the desk screen’s read refetches (contracts 0.100, CT-517…CT-534)',
    seed: (qc) => {
      qc.setQueryData(DESK_QUERY_KEY, {} as never);
      qc.setQueryData(k.home, {} as never);
    },
    events: [[{ type: 'desk.changed' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(DESK_QUERY_KEY)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.home)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'voice.changed',
    name: 'voice typing’s read refetches (contracts 3.1)',
    seed: (qc) => {
      qc.setQueryData([QUERY_ROOT, 'voice.get'], {} as never);
      qc.setQueryData(DESK_QUERY_KEY, {} as never);
    },
    events: [[{ type: 'voice.changed' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState([QUERY_ROOT, 'voice.get'])?.isInvalidated).toBe(true);
      expect(qc.getQueryState(DESK_QUERY_KEY)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'widget.updated',
    name: 'the widgets and Home refetch when a widget Home shows got points (CT-336)',
    seed: (qc) => {
      qc.setQueryData(k.widgets, { widgets: [] });
      qc.setQueryData(k.home, { widgets: [{ id: 'wdg_aaaaaaaaaaaa' }] } as never);
    },
    events: [[{ type: 'widget.updated', widgetId: 'wdg_aaaaaaaaaaaa' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.widgets)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.home)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.server',
    name: 'the fleet refetches when a server changes (CT-339)',
    seed: (qc) => {
      qc.setQueryData(k.hostsFleet, {} as never);
    },
    events: [[{ type: 'hosts.server', serverId: 'pve-02', server: null }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsFleet)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.guest',
    name: 'the guests refetch when a guest’s state changes (CT-339)',
    seed: (qc) => {
      qc.setQueryData(k.hostsGuests, {} as never);
    },
    events: [[{ type: 'hosts.guest', serverId: 'pve-02', guestId: 'pve:101', state: 'running' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsGuests)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.alert',
    name: 'the alerts and Watch refetch when an alert changes (CT-339)',
    seed: (qc) => {
      qc.setQueryData(k.hostsAlerts, { alerts: [] });
      qc.setQueryData(k.watch, { items: [] });
    },
    events: [
      [
        {
          type: 'hosts.alert',
          alert: {
            id: 'al_1',
            serverId: 'pve-02',
            severity: 'warning',
            title: '/srv 91% full',
            detail: '910 GB of 1 TB used',
            openedAt: '2026-10-17T09:00:00.000Z',
            rule: 'disk.space_high',
            state: 'open',
            attention: true,
          },
        },
        1,
      ],
    ],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsAlerts)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.watch)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.task',
    name: 'the guests refetch when an action finished (CT-339)',
    seed: (qc) => {
      qc.setQueryData(k.hostsGuests, {} as never);
    },
    events: [
      [
        {
          type: 'hosts.task',
          serverId: 'pve-02',
          guestId: 'pve:101',
          actionId: 'act_1',
          op: 'reboot',
          result: 'ok',
        },
        1,
      ],
    ],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsGuests)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.enrollment',
    name: 'waiting servers refetch (CT-339)',
    seed: (qc) => {
      qc.setQueryData(k.hostsEnrollments, { items: [] });
    },
    events: [[{ type: 'hosts.enrollment', enrollmentId: 'en_1', hostname: 'basalt' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsEnrollments)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.install',
    name: 'a sign-in-once job and the fleet refetch (CT-376)',
    seed: (qc) => {
      qc.setQueryData(k.hostsFleet, {} as never);
      qc.setQueryData(k.hostsEnrollments, { items: [] });
    },
    events: [[{ type: 'hosts.install', installId: 'in_1', state: 'ready' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsFleet)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.hostsEnrollments)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'hosts.repoint',
    name: 'a repoint job, the address change’s waiting servers and the fleet refetch (CT-911, AP-4415)',
    seed: (qc) => {
      qc.setQueryData(k.hostsFleet, {} as never);
      qc.setQueryData(k.hostsAddressChange, null);
      qc.setQueryData(k.hostsRepoint, {} as never);
    },
    events: [[{ type: 'hosts.repoint', repointId: 'rpt_1', state: 'done' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsRepoint)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.hostsAddressChange)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.hostsFleet)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'chat.thread_runtime',
    name: 'a thread’s choice changes in place in the popover’s read and the threads (CT-462, AP-2682)',
    seed: (qc) => {
      qc.setQueryData(k.chatRuntime, { default: { provider: 'claude' }, thread: null } as never);
      qc.setQueryData(k.chatRuntimeTop, { default: { provider: 'claude' } } as never);
      qc.setQueryData(k.chatThreadsPaged, {
        pages: [
          {
            threads: [
              { rootId: 'msg_1', runtime: null },
              { rootId: 'msg_2', runtime: null },
            ],
            next: null,
          },
        ],
        pageParams: [undefined],
      } as never);
    },
    events: [
      [
        {
          type: 'chat.thread_runtime',
          conversationId: 'cnv_chat',
          rootId: 'msg_1',
          runtime: { provider: 'codex', fast: true },
        },
        1,
      ],
    ],
    check: (qc) => {
      const choice = { provider: 'codex', fast: true };
      expect(qc.getQueryData<{ thread: unknown }>(k.chatRuntime)?.thread).toEqual(choice);
      expect(qc.getQueryData<{ thread?: unknown }>(k.chatRuntimeTop)?.thread).toBeUndefined();
      const pages = qc.getQueryData<{ pages: { threads: { rootId: string; runtime: unknown }[] }[] }>(
        k.chatThreadsPaged,
      )?.pages;
      expect(pages?.[0]?.threads.map((t) => t.runtime)).toEqual([choice, null]);
      expect(qc.getQueryState(k.chatRuntime)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'conversation.handoffs',
    name: 'the conversation’s hand-overs to T3 Code are replaced by the newest list (Whombat t3code.md T3-25, AP-6610)',
    seed: (qc) => {
      qc.setQueryData(k.handoffs, { conversationId: 'cnv_chat', handoffs: [] } as never);
    },
    events: [
      [
        {
          type: 'conversation.handoffs',
          conversationId: 'cnv_chat',
          handoffs: [{ id: 'mcp:t', state: 'working' }],
        } as never,
        1,
      ],
      [
        {
          type: 'conversation.handoffs',
          conversationId: 'cnv_chat',
          handoffs: [{ id: 'mcp:t', state: 'ended' }],
        } as never,
        2,
      ],
    ],
    check: (qc) => {
      expect(qc.getQueryData<{ handoffs: { state: string }[] }>(k.handoffs)?.handoffs).toEqual([
        { id: 'mcp:t', state: 'ended' },
      ]);
    },
  },
  {
    type: 'chat.cleared',
    name: 'a cleared room’s timeline is read again from the start; its threads stay (CT-991, AP-4504)',
    seed: (qc) => {
      qc.setQueryData(k.messages, { messages: [message('msg_1')], before: null, hasMore: false });
      qc.setQueryData(k.thread, { root: message('msg_1'), replies: [] } as never);
    },
    events: [
      [
        {
          type: 'chat.cleared',
          conversationId: 'cnv_chat',
          room: 'chat',
          clearedAt: t(20),
        },
        1,
      ],
    ],
    check: (qc) => {
      expect(qc.getQueryData(k.messages)).toBeUndefined();
      expect(qc.getQueryData<ThreadView>(k.thread)?.root.id).toBe('msg_1');
    },
  },
  {
    type: 'chat.placed',
    name: 'a box from before one Chat moved a thread: the lists read again, nothing else changes (Whombat one-chat.md)',
    seed: (qc) => {
      qc.setQueryData(k.messages, { messages: [message('msg_1')], before: null, hasMore: false });
      const row = { conversationId: 'cnv_chat', room: 'chat', rootId: 'msg_1', lastAt: t(0), settled: null };
      qc.setQueryData(k.chatThreadsPaged, {
        pages: [{ threads: [row], next: null, settledCount: 0 }],
        pageParams: [undefined],
      } as never);
    },
    events: [[{ type: 'chat.placed', conversationId: 'cnv_chat', rootId: 'msg_1', place: 'code' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.chatThreadsPaged)?.isInvalidated).toBe(true);
      expect(qc.getQueryData<{ messages: unknown[] }>(k.messages)?.messages).toHaveLength(1);
    },
  },
  {
    type: 'chat.settled',
    name: 'a settled thread folds its first message and moves from the open list to the shelf, counted once (3.8, AP-6158)',
    seed: (qc) => {
      qc.setQueryData(k.messages, { messages: [message('msg_1')], before: null, hasMore: false });
      qc.setQueryData(k.thread, { root: message('msg_1'), replies: [] } as never);
      const row = { conversationId: 'cnv_chat', room: 'chat', rootId: 'msg_1', lastAt: t(0), settled: null };
      qc.setQueryData(k.chatThreadsPaged, {
        pages: [{ threads: [row], next: null, settledCount: 1 }],
        pageParams: [undefined],
      } as never);
      qc.setQueryData(k.chatThreadsOpen, {
        pages: [{ threads: [row], next: null, settledCount: 1 }],
        pageParams: [undefined],
      } as never);
      qc.setQueryData(k.chatThreadsSettled, {
        pages: [
          {
            threads: [{ ...row, rootId: 'msg_9', settled: { at: t(-60), how: 'quiet' } }],
            next: null,
            settledCount: 1,
          },
        ],
        pageParams: [undefined],
      } as never);
    },
    events: [
      // Opened again by a reply, then settled by the person on another device: the later frame wins either way.
      [{ type: 'chat.settled', conversationId: 'cnv_chat', room: 'chat', rootId: 'msg_1', settled: null }, 1],
      [
        {
          type: 'chat.settled',
          conversationId: 'cnv_chat',
          room: 'chat',
          rootId: 'msg_1',
          settled: { at: t(2), how: 'person' },
        },
        2,
      ],
    ],
    check: (qc) => {
      const settled = { at: t(2), how: 'person' };
      expect(qc.getQueryData<{ messages: Message[] }>(k.messages)?.messages[0]?.settled).toEqual(settled);
      expect(qc.getQueryData<ThreadView>(k.thread)?.root.settled).toEqual(settled);
      type Paged = { pages: { threads: { rootId: string; settled: unknown }[]; settledCount?: number }[] };
      const all = qc.getQueryData<Paged>(k.chatThreadsPaged)?.pages[0];
      const open = qc.getQueryData<Paged>(k.chatThreadsOpen)?.pages[0];
      const shelf = qc.getQueryData<Paged>(k.chatThreadsSettled)?.pages[0];
      expect(all?.threads.map((x) => x.settled)).toEqual([settled]);
      expect(open?.threads).toEqual([]);
      expect(shelf?.threads.map((x) => x.rootId)).toEqual(['msg_1', 'msg_9']);
      expect([all?.settledCount, open?.settledCount, shelf?.settledCount]).toEqual([2, 2, 2]);
    },
  },
  {
    type: 'hosts.resync',
    name: 'every servers read refetches after a resync (CT-339)',
    seed: (qc) => {
      qc.setQueryData(k.hostsFleet, {} as never);
      qc.setQueryData(k.hostsAlerts, { alerts: [] });
    },
    events: [[{ type: 'hosts.resync' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.hostsFleet)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.hostsAlerts)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'services.changed',
    name: 'the agent’s services refetch (CT-1536, AP-5655)',
    seed: (qc) => {
      qc.setQueryData(k.services, { available: true, reason: null, services: [] });
    },
    events: [[{ type: 'services.changed' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.services)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'usage.gateway_updated',
    name: 'the usage list refetches when the AI gateway’s pool changes (CT-332, AP-1122)',
    seed: (qc) => {
      qc.setQueryData(k.usage, { mine: [], gateway: null });
    },
    events: [[{ type: 'usage.gateway_updated', connectionId: 'con_fusebox' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.usage)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'deployment.recorded',
    name: 'Work · Deploys refetches (contracts CT-296; placeholder until WE-17/MQ-07)',
    seed: (qc) => {
      qc.setQueryData(k.deployments, { deployments: [], before: null });
      qc.setQueryData(k.deployBoard, { environments: [] });
    },
    events: [
      [
        {
          type: 'deployment.recorded',
          deployment: {
            id: 'dpl_api1',
            environment: 'production',
            service: 'api',
            status: 'succeeded',
            how: 'github_actions',
            repo: null,
            ref: null,
            sha: null,
            url: null,
            summary: 'Invoice PDFs render on the server.',
            byId: 'prn_banjo',
            runId: null,
            conversationId: null,
            messageId: null,
            previousId: null,
            createdAt: t(1),
          },
        },
        1,
      ],
    ],
    check: (qc) => {
      expect(qc.getQueryState(k.deployments)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.deployBoard)?.isInvalidated).toBe(true);
    },
  },
  {
    type: 'notification.read',
    name: 'rows read on another device: by id, or everything up to a time; the server’s unread count (CT-300, WE-11)',
    seed: (qc) => {
      qc.setQueryData(k.inbox, {
        sections: [
          {
            kind: 'needs_you',
            title: 'NEEDS YOU',
            items: [inboxItem('ntf_1', { createdAt: t(1) }), inboxItem('ntf_4', { createdAt: t(4) })],
          },
          {
            kind: 'mention',
            title: 'MENTIONS',
            items: [
              inboxItem('ntf_2', { kind: 'mention', createdAt: t(2) }),
              inboxItem('ntf_3', { kind: 'mention', createdAt: t(3) }),
            ],
          },
        ],
        counts: { all: 4, needs_you: 2, mentions: 2, agents: 0 },
        unread: 4,
      });
    },
    events: [
      [{ type: 'notification.read', ids: ['ntf_2'], unread: 3 }, 5],
      [{ type: 'notification.read', ids: null, before: t(3) }, 6],
    ],
    check: (qc) => {
      const inbox = get<InboxResponse>(qc, k.inbox);
      const readAt = Object.fromEntries(inbox.sections.flatMap((s) => s.items.map((i) => [i.id, i.readAt])));
      // Read at the earliest event that read it, whatever the order; ntf_4 is after `before`.
      expect(readAt).toEqual({ ntf_1: t(6), ntf_2: t(5), ntf_3: t(6), ntf_4: null });
      expect(inbox.unread).toBe(1);
    },
  },
  {
    type: 'files.changed',
    name: 'the Files summary and that conversation’s list refetch (CT-275, AP-776)',
    seed: (qc) => {
      qc.setQueryData(k.filesSummary, { conversations: [] });
      qc.setQueryData(k.filesBilling, { files: [], truncated: false } as never);
      qc.setQueryData(k.filesGeneral, { files: [], truncated: false } as never);
    },
    events: [[{ type: 'files.changed', conversationId: 'cnv_chat' }, 1]],
    check: (qc) => {
      expect(qc.getQueryState(k.filesSummary)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.filesBilling)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(k.filesGeneral)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'conversation.notify',
    name: 'the viewer’s level shows in the sidebar, lists and the header at once (CT-182, AP-469)',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.conv, convDetail());
      qc.setQueryData(k.convs, { conversations: [summary()] });
    },
    events: [
      [{ type: 'conversation.notify', conversationId: 'cnv_chat', notify: 'all' }, 1],
      [{ type: 'conversation.notify', conversationId: 'cnv_chat', notify: 'none' }, 2],
    ],
    check: (qc) => {
      const row = get<Bootstrap>(qc, k.bootstrap).sidebar.dms.find((c) => c.id === 'cnv_chat');
      expect(row?.notify).toBe('none');
      expect(get<ConversationDetail>(qc, k.conv).notify).toBe('none');
      expect(get<ConversationDetail>(qc, k.conv).summary.notify).toBe('none');
      expect(get<{ conversations: { notify?: string }[] }>(qc, k.convs).conversations[0]?.notify).toBe(
        'none',
      );
      // Nothing else is touched.
      expect(get<Bootstrap>(qc, k.bootstrap).sidebar.dms[1]?.notify).toBeUndefined();
      expect(qc.getQueryState(k.bootstrap)?.isInvalidated).toBe(false);
    },
  },
  {
    type: 'agent.updated',
    name: 'status dot, name and face, and Settings → Agent',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.agent, agentProfile());
    },
    events: [
      [{ type: 'agent.updated', agent: agent('dusty', { status: 'waiting' }) }, 1],
      [
        {
          type: 'agent.updated',
          agent: agent('dusty', { status: 'idle', doing: '', name: 'Rex', face: 'neo' }),
        },
        2,
      ],
    ],
    check: (qc) => {
      const b = get<Bootstrap>(qc, k.bootstrap).principals.find((p) => p.id === 'prn_dusty');
      expect(b?.kind === 'agent' && [b.status, b.name, b.face]).toEqual(['idle', 'Rex', 'neo']);
      expect(get<AgentProfile>(qc, k.agent).agent).toMatchObject({ status: 'idle', name: 'Rex' });
    },
  },
  {
    type: 'grants.updated',
    name: 'keys rows and summaries',
    seed: (qc) => {
      qc.setQueryData(k.agent, agentProfile());
      qc.setQueryData(k.run, runDetail(run({ agentId: 'prn_dusty' })));
    },
    events: [
      [
        {
          type: 'grants.updated',
          agentId: 'prn_dusty',
          grants: [{ agentId: 'prn_dusty', keyId: 'tests.run', tier: 'can' }],
        },
        1,
      ],
      [
        {
          type: 'grants.updated',
          agentId: 'prn_dusty',
          grants: [
            { agentId: 'prn_dusty', keyId: 'tests.run', tier: 'can' },
            { agentId: 'prn_dusty', keyId: 'deploy.staging', tier: 'ask' },
          ],
        },
        2,
      ],
    ],
    check: (qc) => {
      expect(get<AgentProfile>(qc, k.agent).keys).toEqual({ keys: 1, askFirst: 1 });
      expect(get<AgentProfile>(qc, k.agent).grants).toHaveLength(2);
      expect(get<RunDetail>(qc, k.run).grants).toHaveLength(2);
    },
  },
  {
    type: 'person.updated',
    name: 'a renamed person updates the sidebar footer and avatars, newest wins',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
    },
    events: [
      [
        {
          type: 'person.updated',
          person: person('mara', { name: 'Mara Okafor-Smit', initials: 'MO', title: 'CTO' }),
        },
        2,
      ],
      // An older version arriving late changes nothing.
      [{ type: 'person.updated', person: person('mara', { name: 'Mara O.' }) }, 1],
    ],
    check: (qc) => {
      const boot = get<Bootstrap>(qc, k.bootstrap);
      expect(boot.me.name).toBe('Mara Okafor-Smit');
      expect(boot.me.kind === 'person' && boot.me.title).toBe('CTO');
      expect(boot.principals.find((p) => p.id === 'prn_mara')?.name).toBe('Mara Okafor-Smit');
    },
  },
  {
    type: 'principal.created',
    name: 'a new principal shows up once, in the bootstrap',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
    },
    events: [
      [
        {
          type: 'principal.created',
          principal: agent('neo', { createdAt: t(2) }),
        },
        2,
      ],
      [{ type: 'principal.created', principal: agent('neo', { createdAt: t(2) }) }, 3],
    ],
    check: (qc) => {
      const boot = get<Bootstrap>(qc, k.bootstrap);
      expect(boot.principals.map((p) => p.id)).toEqual(['prn_mara', 'prn_dusty', 'prn_neo']);
    },
  },
  {
    type: 'conversation.updated',
    name: 'header, sidebar and lists: every conversation is the person’s (CT-1514)',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.conv, convDetail());
      qc.setQueryData(k.convs, {
        conversations: [summary(), summary({ id: 'cnv_feedback', slug: 'feedback-mara', title: 'Feedback' })],
      });
    },
    events: [
      [
        {
          type: 'conversation.updated',
          conversation: conversation({ topic: 'PDFs first' }),
        },
        1,
      ],
      [
        {
          type: 'conversation.updated',
          conversation: conversation({
            id: 'cnv_feedback',
            slug: 'feedback-mara',
            title: 'Feedback',
          }),
        },
        2,
      ],
      [
        {
          type: 'conversation.updated',
          conversation: conversation({
            id: 'cnv_feedback-2',
            slug: 'feedback-mara-2',
            title: 'Feedback',
          }),
        },
        3,
      ],
    ],
    check: (qc) => {
      const d = get<ConversationDetail>(qc, k.conv);
      expect(d.conversation.topic).toBe('PDFs first');
      const dms = get<Bootstrap>(qc, k.bootstrap).sidebar.dms;
      expect(dms.map((c) => c.id)).toEqual(['cnv_chat', 'cnv_feedback', 'cnv_feedback-2']);
      expect(dms[2]?.link.type).toBe('dm');
      expect(get<{ conversations: { id: string }[] }>(qc, k.convs).conversations.map((c) => c.id)).toEqual([
        'cnv_chat',
        'cnv_feedback',
        'cnv_feedback-2',
      ]);
    },
  },
  {
    type: 'conversation.unread',
    name: 'sidebar badges, lists and header summary; read to the end, its top level’s inbox rows are read',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.conv, convDetail());
      qc.setQueryData(k.convs, { conversations: [summary()] });
      const at = { type: 'dm', room: 'chat' } as const;
      qc.setQueryData(k.inbox, {
        ...emptyInbox(),
        sections: [
          {
            kind: 'mention',
            title: 'MENTIONS',
            items: [
              inboxItem('ntf_m', { kind: 'mention', link: { type: 'message', in: at, messageId: 'msg_1' } }),
            ],
          },
          {
            kind: 'reply',
            title: 'REPLIES',
            items: [
              inboxItem('ntf_r', {
                kind: 'reply',
                link: { type: 'message', in: at, messageId: 'msg_2', threadRootId: 'msg_1' },
              }),
            ],
          },
        ],
        unread: 2,
      });
    },
    events: [
      [{ type: 'conversation.unread', conversationId: 'cnv_chat', unread: 5, mentions: 2 }, 1],
      [{ type: 'conversation.unread', conversationId: 'cnv_chat', unread: 0, mentions: 0 }, 2],
    ],
    check: (qc) => {
      expect(get<Bootstrap>(qc, k.bootstrap).sidebar.dms[0]).toMatchObject({ unread: 0, mentions: 0 });
      expect(get<ConversationDetail>(qc, k.conv).summary).toMatchObject({ unread: 0, mentions: 0 });
      expect(get<{ conversations: unknown[] }>(qc, k.convs).conversations[0]).toMatchObject({ unread: 0 });
      // The thread's reply stays until the thread is opened (AP-704).
      const inbox = get<InboxResponse>(qc, k.inbox);
      expect(inbox.sections.flatMap((s) => s.items).map((i) => [i.id, i.readAt !== null])).toEqual([
        ['ntf_m', true],
        ['ntf_r', false],
      ]);
      expect(inbox.unread).toBe(1);
    },
  },
  {
    type: 'audit.appended',
    name: 'rows under matching filters, chip counts over the base',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.audit, emptyAudit());
      qc.setQueryData(k.auditKeys, emptyAudit());
      qc.setQueryData(k.auditAgent, { pages: [emptyAudit()], pageParams: [undefined] });
    },
    events: [
      [{ type: 'audit.appended', event: auditEvent('evt_code', { createdAt: t(1) }) }, 1],
      [
        {
          type: 'audit.appended',
          event: auditEvent('evt_keys', {
            type: 'keys.granted',
            kind: 'Keys',
            actorId: 'prn_mara',
            aboutId: 'prn_dusty',
            text: 'Gave Dusty a new key: Run CI',
            createdAt: t(2),
          }),
        },
        2,
      ],
      [
        {
          type: 'audit.appended',
          event: auditEvent('evt_hidden', { type: 'run.log', text: null, createdAt: t(3) }),
        },
        3,
      ],
      [
        {
          type: 'audit.appended',
          event: auditEvent('evt_vault', {
            type: 'vault.used',
            kind: 'Vault',
            actorId: 'prn_dusty',
            text: 'Used a private Vault entry',
            createdAt: t(4),
          }),
        },
        4,
      ],
    ],
    check: (qc) => {
      const all = get<AuditPage>(qc, k.audit);
      expect(all.events.map((e) => e.id)).toEqual(['evt_vault', 'evt_keys', 'evt_code']);
      expect(all.counts).toEqual({ all: 3, code: 1, asks: 0, keys: 1, vault: 1, messages: 0, blocked: 0 });
      const keys = get<AuditPage>(qc, k.auditKeys);
      expect(keys.events.map((e) => e.id)).toEqual(['evt_keys']);
      expect(keys.counts.all).toBe(3);
      const agent = get<{ pages: AuditPage[] }>(qc, k.auditAgent).pages[0];
      expect(agent?.events.map((e) => e.id)).toEqual(['evt_vault', 'evt_keys', 'evt_code']);
      expect(agent?.counts.all).toBe(3);
    },
  },
  {
    type: 'pr.updated',
    name: 'branch pane, PR list, sidebar dot and room header',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.pr, { pr: pr(), status: 'changes_requested', mergeBlock: 'checks', staging: null });
      qc.setQueryData(k.openPrs, { prs: [pr()] });
      qc.setQueryData(endpointKey(api.conversations.get, { params: { ...B, conversationId: 'cnv_pr482' } }), {
        ...convDetail(),
        pr: pr(),
      });
    },
    events: [
      [
        {
          type: 'pr.updated',
          pr: pr({
            checks: [
              {
                name: 'unit · billing',
                state: 'passed',
                note: '41/41',
                durationMs: 1,
                tests: null,
                url: null,
              },
            ],
            reviewers: [{ principalId: 'prn_waffle', state: 'approved', at: t(38) }],
          }),
        },
        1,
      ],
      [{ type: 'pr.updated', pr: pr({ state: 'merged', mergedAt: t(40), mergedById: 'prn_mara' }) }, 2],
    ],
    check: (qc) => {
      const d = get<PullRequestDetail>(qc, k.pr);
      expect([d.status, d.mergeBlock]).toEqual(['merged', 'not_open']);
      expect(get<{ prs: unknown[] }>(qc, k.openPrs).prs).toEqual([]);
      expect(get<Bootstrap>(qc, k.bootstrap).sidebar.branchRooms[0]).toMatchObject({
        prStatus: 'merged',
        dot: 'ok',
      });
      const room = get<ConversationDetail>(
        qc,
        endpointKey(api.conversations.get, { params: { ...B, conversationId: 'cnv_pr482' } }),
      );
      expect(room.pr?.state).toBe('merged');
    },
  },
  {
    type: 'notification.created',
    name: 'inbox sections by filter, counts always',
    seed: (qc) => {
      qc.setQueryData(k.inbox, emptyInbox());
      qc.setQueryData(k.mentions, emptyInbox());
    },
    events: [
      [{ type: 'notification.created', item: inboxItem('ntf_1', { createdAt: t(1) }) }, 1],
      [{ type: 'notification.created', item: inboxItem('ntf_2', { kind: 'mention', createdAt: t(2) }) }, 2],
      [
        {
          type: 'notification.created',
          item: inboxItem('ntf_3', { kind: 'mention', createdAt: t(3), readAt: t(3) }),
        },
        3,
      ],
    ],
    check: (qc) => {
      const all = get<InboxResponse>(qc, k.inbox);
      expect(all.sections.map((s) => [s.kind, s.items.map((i) => i.id)])).toEqual([
        ['needs_you', ['ntf_1']],
        ['mention', ['ntf_3', 'ntf_2']],
      ]);
      expect(all.counts).toEqual({ all: 3, needs_you: 1, mentions: 2, agents: 0 });
      expect(all.unread).toBe(2);
      const mentions = get<InboxResponse>(qc, k.mentions);
      expect(mentions.sections.map((s) => s.kind)).toEqual(['mention']);
      expect(mentions.counts.all).toBe(3);
    },
  },
  {
    type: 'search.answer',
    name: 'answer card on the search screen and the poll fallback',
    seed: (qc) => {
      const empty: SearchResponse = {
        query: 'vat rounding',
        results: [],
        counts: {
          all: 0,
          threads: 0,
          patches: 0,
          runs: 0,
          canvases: 0,
          plans: 0,
          decisions: 0,
          automations: 0,
        },
        answer: null,
      };
      qc.setQueryData(k.search, empty);
      qc.setQueryData(k.answer, { answer: answer({ status: 'pending', text: '' }) });
    },
    events: [
      [{ type: 'search.answer', answer: answer({ status: 'pending', text: '' }) }, 1],
      [{ type: 'search.answer', answer: answer() }, 2],
    ],
    check: (qc) => {
      expect(get<SearchResponse>(qc, k.search).answer?.status).toBe('ready');
      expect(get<{ answer: { status: string } }>(qc, k.answer).answer.status).toBe('ready');
    },
  },
  {
    type: 'canvas.updated',
    name: 'canvas header and index',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.canvas, {
        canvas: canvas(),
        conversationTitle: 'Chat',
        plan: null,
        comments: [],
        presentIds: [],
        documentName: 'cvs_plan',
      });
      qc.setQueryData(k.canvases, { canvases: [] });
    },
    events: [
      [{ type: 'canvas.updated', canvas: canvas({ title: 'Plan v2', updatedAt: t(1) }) }, 1],
      [{ type: 'canvas.updated', canvas: canvas({ title: 'Plan v3', updatedAt: t(2) }) }, 2],
    ],
    check: (qc) => {
      expect(get<CanvasDetail>(qc, k.canvas).canvas.title).toBe('Plan v3');
      expect(get<{ canvases: unknown[] }>(qc, k.canvases).canvases).toEqual([
        { ...canvas({ title: 'Plan v3', updatedAt: t(2) }), conversationTitle: 'Chat' },
      ]);
    },
  },
  {
    type: 'canvas.comment',
    name: 'side comments regroup into threads',
    seed: (qc) => {
      qc.setQueryData(k.canvas, {
        canvas: canvas(),
        conversationTitle: 'Chat',
        plan: null,
        comments: [
          {
            id: 'cmt_1',
            anchor: { relativePosition: 'AAE=', quote: 'PDF export' },
            resolved: false,
            comments: [comment('cmt_1')],
          },
        ],
        presentIds: [],
        documentName: 'cvs_plan',
      });
    },
    events: [
      [
        {
          type: 'canvas.comment',
          comment: comment('cmt_2', { anchor: null, parentId: 'cmt_1', createdAt: t(1), text: 'Agreed' }),
        },
        1,
      ],
      [{ type: 'canvas.comment', comment: comment('cmt_1', { resolved: true }) }, 2],
    ],
    check: (qc) => {
      const threads = get<CanvasDetail>(qc, k.canvas).comments;
      expect(threads).toHaveLength(1);
      expect(threads[0]?.resolved).toBe(true);
      expect(threads[0]?.comments.map((c) => c.id)).toEqual(['cmt_1', 'cmt_2']);
    },
  },
  {
    type: 'burrow.updated',
    name: 'renames show in the shell and the burrow switcher',
    seed: (qc) => {
      qc.setQueryData(k.bootstrap, bootstrap());
      qc.setQueryData(k.burrow, { burrow: burrow() });
      qc.setQueryData(k.me, {
        account: {
          id: 'acc_mara',
          email: 'mara@burrowhq.example',
          name: 'Mara Okafor',
          title: '',
          createdAt: t(0),
        },
        memberships: [
          {
            burrowId: BURROW_ID,
            burrowSlug: BURROW,
            burrowName: 'Burrow HQ',
            principalId: 'prn_mara',
          },
        ],
        preferences: { theme: 'system', timeZone: null },
      });
    },
    events: [
      [{ type: 'burrow.updated', burrow: burrow({ name: 'Burrow' }) }, 1],
      [{ type: 'burrow.updated', burrow: burrow({ name: 'Burrow HQ Amsterdam' }) }, 2],
    ],
    check: (qc) => {
      expect(get<Bootstrap>(qc, k.bootstrap).burrow.name).toBe('Burrow HQ Amsterdam');
      expect(get<{ burrow: { name: string } }>(qc, k.burrow).burrow.name).toBe('Burrow HQ Amsterdam');
      expect(get<{ memberships: { burrowName: string }[] }>(qc, k.me).memberships[0]?.burrowName).toBe(
        'Burrow HQ Amsterdam',
      );
    },
  },
];

cases.push(
  {
    type: 'automation.updated',
    name: 'the list, the editor and run pages follow an automation',
    seed: (qc) => {
      qc.setQueryData(k.automations, { automations: [automation()] });
      qc.setQueryData(k.automation, {
        automation: automation(),
        versions: [],
        webhookUrl: null,
      });
    },
    events: [
      [{ type: 'automation.updated', automation: automation({ status: 'disabled' }) }, 1],
      [{ type: 'automation.updated', automation: automation({ id: 'aut_2', name: 'Check' }) }, 2],
      [{ type: 'automation.updated', automation: automation({ status: 'published', name: 'Bugs' }) }, 3],
    ],
    check: (qc) => {
      const list = get<{ automations: Automation[] }>(qc, k.automations).automations;
      expect(list.map((a) => [a.id, a.name, a.status])).toEqual([
        ['aut_2', 'Check', 'published'],
        ['aut_1', 'Bugs', 'published'],
      ]);
      expect(get<{ automation: Automation }>(qc, k.automation).automation.name).toBe('Bugs');
    },
  },
  {
    type: 'automation.deleted',
    name: 'a deleted automation leaves the list, its pages say so, and a late update can’t bring it back',
    seed: (qc) => {
      qc.setQueryData(k.automations, {
        automations: [automation(), automation({ id: 'aut_2', name: 'Check' })],
      });
      qc.setQueryData(k.automation, {
        automation: automation(),
        versions: [],
        webhookUrl: null,
      });
      qc.setQueryData(k.automationRun, { run: automationRun(), automation: automation() });
    },
    events: [
      [{ type: 'automation.updated', automation: automation({ status: 'disabled' }) }, 1],
      [{ type: 'automation.deleted', automationId: 'aut_1' }, 2],
    ],
    check: (qc) => {
      expect(get<{ automations: Automation[] }>(qc, k.automations).automations.map((a) => a.id)).toEqual([
        'aut_2',
      ]);
      expect(get<{ automation: Automation }>(qc, k.automation).automation.deletedAt).toBe(t(2));
      expect(get<{ automation: Automation }>(qc, k.automationRun).automation.deletedAt).toBe(t(2));
    },
  },
  {
    type: 'automation.run.updated',
    name: 'runs appear and move on the automation’s run list and page',
    seed: (qc) => {
      qc.setQueryData(k.automationRuns, { runs: [] });
      qc.setQueryData(k.automationRun, { run: automationRun(), automation: automation() });
    },
    events: [
      [{ type: 'automation.run.updated', run: automationRun({ status: 'waiting' }) }, 1],
      [
        {
          type: 'automation.run.updated',
          run: automationRun({ id: 'arn_x', number: 2, automationId: 'aut_9' }),
        },
        2,
      ],
      [{ type: 'automation.run.updated', run: automationRun({ status: 'succeeded' }) }, 3],
    ],
    check: (qc) => {
      expect(get<{ runs: AutomationRun[] }>(qc, k.automationRuns).runs.map((r) => [r.id, r.status])).toEqual([
        ['arn_1', 'succeeded'],
      ]);
      expect(get<{ run: AutomationRun }>(qc, k.automationRun).run.status).toBe('succeeded');
    },
  },
);

function run_(c: Case, steps: Step[]) {
  const qc = new QueryClient();
  const state = createCacheSyncState(() => NOW);
  c.seed(qc);
  for (const [event, minutes] of steps)
    applyRealtimeEvent(qc, event, { at: t(minutes), burrowId: BURROW_ID }, state);
  return qc;
}

/** Cache contents by query hash; empty typing lists count as absent. */
function dump(qc: QueryClient) {
  return Object.fromEntries(
    qc
      .getQueryCache()
      .getAll()
      .filter((q) => !(Array.isArray(q.state.data) && q.state.data.length === 0))
      .map((q) => [q.queryHash, q.state.data]),
  );
}

describe('applyRealtimeEvent', () => {
  it('has a case for every realtime event type', () => {
    const covered = new Set(cases.map((c) => c.type));
    expect(
      Object.keys(REALTIME_EVENT_TOPICS).filter((type) => !covered.has(type as RealtimeEventType)),
    ).toEqual([]);
  });

  describe.each(cases)('$type: $name', (c) => {
    it('applies events in order', () => {
      c.check(run_(c, c.events));
    });

    it('is idempotent under duplicates', () => {
      const once = dump(run_(c, c.events));
      const twice = run_(c, [...c.events, ...c.events]);
      c.check(twice);
      expect(dump(twice)).toEqual(once);
      const stutter = run_(
        c,
        c.events.flatMap((s) => [s, s]),
      );
      expect(dump(stutter)).toEqual(once);
    });

    it('converges under out-of-order delivery', () => {
      const inOrder = dump(run_(c, c.events));
      const reversed = run_(c, [...c.events].reverse());
      c.check(reversed);
      expect(dump(reversed)).toEqual(inOrder);
    });
  });

  it('vault.updated without an entry refetches the whole Vault, the home network list and the kept websites', () => {
    const qc = new QueryClient();
    const kept = endpointKey(api.keptSites.list, { params: B });
    for (const key of [k.vault, k.vaultHa, k.vaultGrafana, k.vaultNetworks, kept])
      qc.setQueryData(key, {} as never);
    applyRealtimeEvent(qc, { type: 'vault.updated', entryId: 'vlt_homeassistant' }, { at: t(1) });
    expect(qc.getQueryState(kept)?.isInvalidated).toBe(false);
    applyRealtimeEvent(qc, { type: 'vault.updated', entryId: null }, { at: t(2) });
    for (const key of [k.vault, k.vaultHa, k.vaultGrafana, k.vaultNetworks, kept])
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it('widget.updated leaves the overview alone when it doesn’t show that widget', () => {
    const qc = new QueryClient();
    qc.setQueryData(k.widgets, { widgets: [] });
    qc.setQueryData(k.home, { widgets: [{ id: 'wdg_bbbbbbbbbbbb' }] } as never);
    applyRealtimeEvent(qc, { type: 'widget.updated', widgetId: 'wdg_aaaaaaaaaaaa' }, { at: t(1) });
    expect(qc.getQueryState(k.widgets)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(k.home)?.isInvalidated).toBe(false);
  });

  it('home.changed about things reads the thing pages and their history again, and only then', () => {
    const qc = new QueryClient();
    const params = { ...B, thing: 'connection:con_ha' };
    const page = endpointKey(api.things.page, { params });
    const history = endpointKey(api.things.history, { params, query: { days: 30 } });
    qc.setQueryData(page, {} as never);
    qc.setQueryData(history, {} as never);
    applyRealtimeEvent(qc, { type: 'home.changed', parts: ['needsYou', 'watch'] }, { at: t(1) });
    expect(qc.getQueryState(page)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(history)?.isInvalidated).toBe(false);
    applyRealtimeEvent(qc, { type: 'home.changed', parts: ['needsYou', 'things'] }, { at: t(2) });
    expect(qc.getQueryState(page)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(history)?.isInvalidated).toBe(true);
  });

  it('reports stale and duplicate events as not applied', () => {
    const qc = new QueryClient();
    const state = createCacheSyncState(() => NOW);
    const newer: RealtimeEvent = { type: 'run.updated', run: run({ progress: 90 }) };
    const older: RealtimeEvent = { type: 'run.updated', run: run({ progress: 10 }) };
    expect(applyRealtimeEvent(qc, newer, { at: t(2) }, state)).toBe(true);
    expect(applyRealtimeEvent(qc, older, { at: t(1) }, state)).toBe(false);
    const n: RealtimeEvent = { type: 'notification.created', item: inboxItem('ntf_1') };
    expect(applyRealtimeEvent(qc, n, { at: t(1) }, state)).toBe(true);
    expect(applyRealtimeEvent(qc, n, { at: t(1) }, state)).toBe(false);
  });

  it('a new message clears its author’s typing indicator; a late typing frame does not bring it back', () => {
    const qc = new QueryClient();
    const state = createCacheSyncState(() => NOW);
    const typing = (active: boolean, at: number): [RealtimeEvent, number] => [
      {
        type: 'typing',
        conversationId: 'cnv_chat',
        threadRootId: null,
        principalId: 'prn_banjo',
        active,
        expiresAt: t(at + 1),
      },
      at,
    ];
    const reply: [RealtimeEvent, number] = [
      { type: 'message.created', message: message('msg_9', { authorId: 'prn_banjo', createdAt: t(26) }) },
      26,
    ];
    for (const [e, at] of [typing(true, 25), reply, typing(true, 25)]) {
      applyRealtimeEvent(qc, e, { at: t(at) }, state);
    }
    expect(qc.getQueryData(queryKeys.typing('cnv_chat'))).toEqual([]);
  });

  it('does not insert list rows for another burrow', () => {
    const qc = new QueryClient();
    qc.setQueryData(k.bootstrap, bootstrap());
    qc.setQueryData(k.approvals, { approvals: [], before: null });
    applyRealtimeEvent(
      qc,
      { type: 'approval.updated', approval: approval({ burrowId: 'bur_other' }) },
      { at: t(1) },
    );
    expect(get<{ approvals: unknown[] }>(qc, k.approvals).approvals).toEqual([]);
  });

  it('does not let a search.answer from another burrow overwrite a cached search with the same query text', () => {
    const qc = new QueryClient();
    qc.setQueryData(k.bootstrap, bootstrap());
    const empty: SearchResponse = {
      query: 'vat rounding',
      results: [],
      counts: {
        all: 0,
        threads: 0,
        patches: 0,
        runs: 0,
        canvases: 0,
        plans: 0,
        decisions: 0,
        automations: 0,
      },
      answer: null,
    };
    qc.setQueryData(k.search, empty);
    applyRealtimeEvent(
      qc,
      { type: 'search.answer', answer: answer({ burrowId: 'bur_other' }) },
      { at: t(1) },
    );
    expect(get<SearchResponse>(qc, k.search).answer).toBeNull();
  });
});

describe('the AI side’s status on agent.updated (web-efficiency.md WE-06)', () => {
  it('refetches the shown, stale AI status read once an agent changes; a fresh one stays', async () => {
    const qc = new QueryClient();
    let fetches = 0;
    const observer = new QueryObserver(qc, {
      queryKey: queryKeys.host.agents({ params: { burrow: 'burrow-hq' } }),
      queryFn: async () => {
        fetches += 1;
        return { recheckPending: false } as never;
      },
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(fetches).toBe(1));
    // Fresh (fetched just now): an agent changing reads nothing.
    applyRealtimeEvent(qc, { type: 'agent.updated', agent: agent('banjo') }, { at: t(1) });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(1);
    // Stale: read again.
    const query = observer.getCurrentQuery();
    query.setState({ ...query.state, dataUpdatedAt: Date.now() - 60_000 });
    applyRealtimeEvent(
      qc,
      { type: 'agent.updated', agent: agent('banjo', { status: 'idle' }) },
      { at: t(2) },
    );
    await vi.waitFor(() => expect(fetches).toBe(2));
    unsubscribe();
  });
});

describe('the needs-you count reads alone (web-efficiency.md WE-07)', () => {
  const needsYouKey = queryKeys.work.needsYou({ params: { burrow: 'burrow-hq' } });
  const bootKey = queryKeys.conversations.bootstrap({ params: { burrow: 'burrow-hq' } });

  it('a decision refetches work.needsYou where it is read, the bootstrap only where it isn’t', () => {
    const qc = new QueryClient();
    qc.setQueryData(bootKey, bootstrap());
    qc.setQueryData(needsYouKey, { count: 1 });
    invalidateNeedsYouCount(qc);
    expect(qc.getQueryState(needsYouKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(bootKey)?.isInvalidated).toBe(false);

    const older = new QueryClient();
    older.setQueryData(bootKey, bootstrap());
    invalidateNeedsYouCount(older);
    expect(older.getQueryState(bootKey)?.isInvalidated).toBe(true);
  });

  it('an approval changing reads the count again, not the bootstrap', () => {
    const qc = new QueryClient();
    qc.setQueryData(bootKey, bootstrap());
    qc.setQueryData(needsYouKey, { count: 1 });
    applyRealtimeEvent(
      qc,
      { type: 'approval.updated', approval: approval({ state: 'approved' }) },
      { at: t(1) },
    );
    expect(qc.getQueryState(needsYouKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(bootKey)?.isInvalidated).toBe(false);
  });
});
