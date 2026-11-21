import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  at,
  BURROW_ID,
  deployApproval,
  dusty,
  GRANTS,
  mara,
  NOW,
  PRINCIPALS,
  plan,
  pr,
  run,
} from '../__fixtures__/world.js';
import type { Message } from '../domain/message.js';
import { decide } from '../keys/engine.js';
import {
  ALL_ENDPOINTS,
  type AnyEndpoint,
  API_ENDPOINTS,
  ApprovalRequiredBody,
  api,
  BlockedBody,
  Bootstrap,
  buildPath,
  commitOutcome,
  DispatchContext,
  endpointUrl,
  inputJsonSchema,
  MCP_TOOLS,
  matchPath,
  mcpRequiredKey,
  parseTopic,
  RealtimeEvent,
  runnerApi,
  topics,
  toQueryString,
} from './index.js';

const _isZod = (s: unknown) => s instanceof z.ZodType;

describe('endpoint registry', () => {
  it('has unique ids and unique method + path', () => {
    const ids = ALL_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = ALL_ENDPOINTS.map((e) => `${e.method} ${e.base}${e.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    expect(API_ENDPOINTS.length).toBeGreaterThan(70);
  });

  it('declares every path param in the params schema, and nothing else', () => {
    for (const ep of ALL_ENDPOINTS) {
      const names = [...ep.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const shape = (ep.params as z.ZodObject).shape;
      expect(Object.keys(shape).sort(), ep.id).toEqual([...names].sort());
    }
  });

  it('builds and matches URLs', () => {
    expect(buildPath(api.runs.get.path, { burrow: 'burrow-hq', number: 1907 })).toBe(
      '/burrows/burrow-hq/runs/1907',
    );
    expect(() => buildPath(api.runs.get.path, { burrow: 'burrow-hq' })).toThrow(/number/);
    expect(
      endpointUrl(api.audit.list, { burrow: 'burrow-hq' }, { actor: 'agents', kind: 'code', who: 'dusty' }),
    ).toBe('/api/v1/burrows/burrow-hq/audit?actor=agents&kind=code&who=dusty');
    expect(endpointUrl(runnerApi.claim)).toBe('/internal/runner/claim');
    expect(matchPath(api.messages.thread.path, '/burrows/burrow-hq/messages/msg_1/thread')).toEqual({
      burrow: 'burrow-hq',
      messageId: 'msg_1',
    });
    expect(matchPath(api.messages.thread.path, '/burrows/burrow-hq/messages/msg_1')).toBeNull();
    expect(toQueryString({ a: 1, b: undefined, c: ['x', 'y'], d: null })).toBe('?a=1&c=x&c=y');
    expect(toQueryString({})).toBe('');
  });
});

/** Every screen and its data / actions, to keep the contract complete. */
const _SCREENS: Record<string, AnyEndpoint[]> = {
  'desktop: app shell + sidebar': [
    api.conversations.bootstrap,
    api.me.updatePreferences,
    api.conversations.markRead,
  ],
  'desktop 1: chat': [
    api.conversations.get,
    api.messages.list,
    api.messages.send,
    api.messages.react,
    api.uploads.create,
    api.approvals.decide,
    api.approvals.undo,
  ],
  'desktop 3: branch room': [api.prs.get, api.prs.merge, api.messages.list, api.approvals.get],
  'desktop 4: thread pane': [api.messages.thread, api.messages.send],
  'desktop 5: agent run': [
    api.runs.get,
    api.runs.log,
    api.runs.pause,
    api.runs.resume,
    api.runs.retry,
    api.runs.takeOver,
  ],
  'desktop 7: agent profile': [api.agent.get, api.runs.list],
  'desktop 8b: configure agent': [api.agent.update, api.agent.setKeys],
  'desktop 9: approval modal': [api.approvals.get, api.approvals.decide],
  'desktop 10: audit log': [api.audit.list, api.audit.get, api.audit.export],
  'desktop 11: search': [api.search.query, api.search.ask, api.search.getAnswer, api.search.postAnswer],
  'desktop 12: plan canvas': [
    api.canvases.get,
    api.canvases.collabToken,
    api.canvases.addComment,
    api.canvases.resolveComment,
    api.plans.get,
    api.plans.updateStep,
  ],
  'desktop 12b: canvases index': [api.canvases.list, api.canvases.create],
  'desktop 13: onboarding': [
    api.burrows.slugCheck,
    api.burrows.create,
    api.onboarding.get,
    api.onboarding.update,
    api.repos.list,
    api.repos.update,
    api.onboarding.complete,
  ],
  'mobile: inbox': [api.notifications.inbox, api.notifications.markRead, api.approvals.decide],
  'mobile: approval detail': [api.approvals.get, api.approvals.decide, api.approvals.undo],
  'mobile: chat': [api.chats.list, api.messages.list, api.messages.send],
  'web: sign-up name step + settings profile': [api.me.updateProfile, api.conversations.bootstrap],
  'push + live activities': [api.devices.register, api.devices.registerLiveActivity, api.devices.vapidKey],
};

describe('profile', () => {
  it('takes a name and / or a title, trimmed, and nothing else', () => {
    const body = api.me.updateProfile.body;
    expect(body.parse({ name: '  Mara Okafor ', title: ' Engineering lead ' })).toEqual({
      name: 'Mara Okafor',
      title: 'Engineering lead',
    });
    expect(body.parse({ title: '' })).toEqual({ title: '' });
    expect(body.safeParse({}).success).toBe(false);
    expect(body.safeParse({ name: '  ' }).success).toBe(false);
    expect(body.safeParse({ title: 'x'.repeat(81) }).success).toBe(false);
  });
});

/* Round trips ------------------------------------------------------------------------------------ */

function roundTrip<S extends z.ZodType>(schema: S, value: z.input<S>) {
  const parsed = schema.parse(value);
  const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(again).toEqual(parsed);
  return parsed;
}

const msg = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg_1',
  conversationId: 'cnv_billing-v2',
  authorId: dusty.id,
  createdAt: at('11:22'),
  editedAt: null,
  text: 'Fixing both now. Watch along if you like.',
  mentions: [],
  suggestions: [],
  more: null,
  card: { kind: 'run', run },
  attachments: [],
  reactions: [],
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  threadParticipantIds: [],
  clientId: null,
  ...overrides,
});

const burrow = {
  id: BURROW_ID,
  name: 'Burrow HQ',
  slug: 'burrow-hq',
  timeZone: 'Europe/Amsterdam',
  localModel: null,
  webSearch: null,
  createdAt: '2026-01-05T09:00:00.000Z',
};

const summary = (id: string, title: string, unread = 0) => ({
  id,
  kind: 'dm' as const,
  slug: title,
  title,
  link: { type: 'dm' as const },
  unread,
  mentions: 0,
  memberCount: 2,
  prNumber: null,
  lastMessageAt: at('11:25'),
});

describe('contract round trips', () => {
  it('bootstrap (sidebar with unread counts)', () => {
    const b = roundTrip(Bootstrap, {
      burrow,
      me: mara,
      principals: PRINCIPALS,
      sidebar: {
        branchRooms: [
          {
            ...summary('cnv_pr482', 'feat/invoice-pdf'),
            kind: 'branch',
            link: { type: 'pr', number: 482 },
            prNumber: 482,
            branch: 'feat/invoice-pdf',
            prStatus: 'changes_requested',
            dot: 'warn',
          },
        ],
        dms: [
          summary('cnv_dm-dusty', 'Chat'),
          { ...summary('cnv_feedback-dusty', 'Feedback', 2), link: { type: 'dm', room: 'feedback' } },
        ],
        counts: { canvases: 4, needsYou: 2 },
      },
      preferences: { theme: 'system', timeZone: null },
      serverTime: NOW,
      realtime: { path: '/ws', topics: [topics.burrow(BURROW_ID), topics.me(mara.id)] },
    });
    expect(b.sidebar.dms[1]?.unread).toBe(2);
    expect(b.sidebar.dms[1]?.link).toEqual({ type: 'dm', room: 'feedback' });
  });

  it('keys-engine error bodies and commit outcomes', () => {
    roundTrip(BlockedBody, {
      error: { code: 'blocked', message: '“Merge into main” is for people.' },
      blocked: true,
      keyNeeded: { id: 'merge.main', label: 'Merge into main' },
      eventId: 'evt_9d31',
    });
    roundTrip(ApprovalRequiredBody, {
      approvalRequired: true,
      approvalId: 'apr_1',
      approvalNumber: 12,
      eventId: 'evt_9f18',
    });
    const outcome = commitOutcome({ messageId: z.string() });
    expect(outcome.parse({ status: 'ok', messageId: 'msg_1' }).status).toBe('ok');
    expect(
      outcome.safeParse({
        status: 'blocked',
        keyNeeded: { id: 'merge.main', label: 'x' },
        eventId: 'evt_1',
        message: 'no',
      }).success,
    ).toBe(true);
    expect(outcome.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

describe('realtime', () => {
  const samples: RealtimeEvent[] = [
    { type: 'message.created', message: msg() },
    {
      type: 'message.updated',
      message: msg({ reactions: [{ value: '+1', count: 1, mine: true, principalIds: [mara.id] }] }),
    },
    { type: 'message.deleted', conversationId: 'cnv_billing-v2', messageId: 'msg_1' },
    {
      type: 'typing',
      conversationId: 'cnv_billing-v2',
      threadRootId: null,
      principalId: dusty.id,
      active: true,
      expiresAt: NOW,
    },
    { type: 'run.updated', run },
    {
      type: 'run.log',
      runId: run.id,
      runNumber: 1907,
      lines: [{ seq: 8, at: at('11:24'), text: 'Editing billing/pdf/format.ts' }],
    },
    { type: 'approval.updated', approval: deployApproval() },
    { type: 'plan.updated', plan },
    { type: 'agent.updated', agent: dusty },
    { type: 'grants.updated', agentId: dusty.id, grants: GRANTS },
    { type: 'principal.created', principal: mara },
    { type: 'conversation.unread', conversationId: 'cnv_incidents', unread: 2, mentions: 0 },
    { type: 'pr.updated', pr },
    { type: 'services.changed' },
    { type: 'burrow.updated', burrow },
  ];

  it('parses every kind of event a session carries', () => {
    for (const e of samples) expect(RealtimeEvent.safeParse(e).success, e.type).toBe(true);
  });

  it('builds and parses topics', () => {
    expect(topics.run('run_1907')).toBe('run:run_1907');
    expect(parseTopic('me:prn_mara')).toEqual({ kind: 'me', id: 'prn_mara' });
    expect(parseTopic('you:prn_mara')).toBeNull();
  });
});

describe('runner protocol', () => {
  it('carries the runner’s lease on progress, complete and git credentials (optional for old runners)', () => {
    const lease = { runnerId: 'rnr_local', attempt: 2 };
    expect(runnerApi.progress.body.parse({ state: 'running', ...lease })).toMatchObject(lease);
    expect(runnerApi.progress.body.parse({ state: 'running' })).not.toHaveProperty('runnerId');
    expect(runnerApi.complete.body.parse({ outcome: 'done', ...lease })).toMatchObject(lease);
    expect(
      runnerApi.gitCredentials.body.parse({
        repo: 'whombat/billing',
        branch: 'feat/x',
        operation: 'push',
        ...lease,
      }),
    ).toMatchObject(lease);
    // A push says which commit it sends: a full sha, nothing else.
    const sha = 'a'.repeat(40);
    expect(
      runnerApi.gitCredentials.body.parse({
        repo: 'whombat/billing',
        branch: 'feat/x',
        operation: 'push',
        sha,
      }),
    ).toMatchObject({ sha });
    expect(() =>
      runnerApi.gitCredentials.body.parse({
        repo: 'whombat/billing',
        branch: 'feat/x',
        operation: 'push',
        sha: '7be20f7',
      }),
    ).toThrow();
    expect(
      runnerApi.complete.body.safeParse({ outcome: 'done', runnerId: 'rnr_local', attempt: 0 }).success,
    ).toBe(false);
    expect(runnerApi.progress.body.safeParse({ state: 'running', runnerId: 'nope' }).success).toBe(false);
  });

  it('carries the cache split (0.44.1, PE-04)', () => {
    const usage = {
      inputTokens: 51_400,
      outputTokens: 600,
      cacheReadTokens: 45_000,
      cacheWriteTokens: 6_000,
      largestCallInputTokens: 26_000,
    };
    const done = runnerApi.complete.body.parse({ outcome: 'done', providerSessionId: 'sess-1', usage });
    expect(done).toMatchObject({ providerSessionId: 'sess-1', usage });
    expect(
      runnerApi.complete.body.parse({ outcome: 'done', usage: { inputTokens: 1, outputTokens: 2 } }),
    ).toEqual({
      outcome: 'done',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('has no prompt hashes, forks or earlier runs (Whombat HE-34, CT-1151)', () => {
    const shape = DispatchContext.shape as Record<string, unknown>;
    for (const gone of ['resumePromptHash', 'forkFrom', 'earlierRuns']) expect(shape[gone]).toBeUndefined();
    expect(runnerApi.complete.body.parse({ outcome: 'done', promptHash: 'a'.repeat(64) })).not.toHaveProperty(
      'promptHash',
    );
    expect(runnerApi.progress.body.parse({ state: 'running', providerSessionId: 's', forked: true })).toEqual(
      { state: 'running', thinking: true, providerSessionId: 's' },
    );
  });
});

describe('MCP tools', () => {
  it('start_run takes no asker from the agent (the server knows who asked)', () => {
    const properties = (inputJsonSchema('start_run') as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).not.toContain('askedById');
    const parsed = MCP_TOOLS.start_run.input.parse({
      conversationId: 'cnv_billing-v2',
      title: 'Address review',
      repo: 'whombat/billing',
      branch: 'feat/invoice-pdf',
      askedById: 'prn_mara',
      steps: [{ title: 'Read', detail: '' }],
    });
    expect(parsed).not.toHaveProperty('askedById');
  });

  it('start_run says the branch the run works on (0.44.2, AE-05), absent from older servers', () => {
    const properties = (
      inputJsonSchema('start_run') as { properties: Record<string, { description?: string }> }
    ).properties;
    expect(properties.prNumber?.description).toMatch(/open pull request.*its branch/);
    const ok = { status: 'ok', runId: 'run_1', number: 3, messageId: 'msg_run3' };
    expect(MCP_TOOLS.start_run.output.parse({ ...ok, branch: 'fix/header' })).toMatchObject({
      branch: 'fix/header',
    });
    expect(MCP_TOOLS.start_run.output.parse(ok)).toEqual(ok);
    expect(MCP_TOOLS.start_run.output.safeParse({ ...ok, branch: '' }).success).toBe(false);
  });

  it('computes the key each call needs and feeds the keys engine', () => {
    expect(mcpRequiredKey('post_message', { conversationId: 'cnv_billing-v2', text: 'hi' })).toBeNull();
    expect(mcpRequiredKey('search', { query: 'x' })).toBeNull();
    const start = {
      conversationId: 'cnv_billing-v2',
      title: 'Address review',
      repo: 'whombat/billing',
      branch: 'feat/invoice-pdf',
      steps: [{ title: 'Read', detail: '' }],
    };
    const need = mcpRequiredKey('start_run', start);
    expect(need).toEqual({
      keyId: 'branch.feature.readwrite',
      scope: { branch: 'feat/invoice-pdf', repo: 'whombat/billing' },
    });
    if (!need) throw new Error('expected a key');
    expect(decide({ id: dusty.id, kind: 'agent' }, GRANTS, need.keyId, need.scope).outcome).toBe('allow');
    // Working on main directly is people only (CT-211); merging into main is the Merge key's.
    expect(mcpRequiredKey('start_run', { ...start, branch: 'main' })?.keyId).toBe('branch.main.push');

    const merge = mcpRequiredKey('merge_pull_request', { prNumber: 479 });
    expect(merge?.keyId).toBe('merge.main');
    // The agent asks before merging by default (a risk row at Ask); without that grant it can't.
    expect(
      decide({ id: dusty.id, kind: 'agent' }, GRANTS, merge?.keyId ?? 'merge', merge?.scope).outcome,
    ).toBe('ask');
    expect(decide({ id: dusty.id, kind: 'agent' }, [], merge?.keyId ?? 'merge', merge?.scope).outcome).toBe(
      'deny',
    );

    const deploy = mcpRequiredKey('perform_action', {
      conversationId: 'cnv_billing-v2',
      reason: 'staging',
      action: {
        type: 'deploy',
        params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
      },
    });
    expect(deploy?.keyId).toBe('deploy.staging');
    expect(
      decide({ id: dusty.id, kind: 'agent' }, GRANTS, deploy?.keyId ?? 'deploy', deploy?.scope).outcome,
    ).toBe('ask');

    expect(
      mcpRequiredKey('review_pull_request', {
        prNumber: 482,
        decision: 'request_changes',
        body: 'Two changes.',
      })?.keyId,
    ).toBe('pr.request_changes');
    expect(
      mcpRequiredKey('canvas_edit', { canvas: 'x', edits: [{ op: 'append', markdown: 'x' }] })?.keyId,
    ).toBe('canvas.write');
    expect(() => mcpRequiredKey('start_run', { branch: 'x' })).toThrow();
  });
});
