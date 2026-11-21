/**
 * Contracts 0.55.0 (Whombat improvement review, CT-295…CT-307): stop a turn, deployments, thread paging, thumbnails,
 * read state across devices, the needs-you count, canvas content and the runner protocol's optional fields.
 */
import { describe, expect, it } from 'vitest';
import { dusty, mara } from '../__fixtures__/world.js';
import { describeActivity } from '../domain/activity.js';
import { EVENT_TYPES } from '../domain/audit.js';
import { CARD_KINDS, MessageCard, PostableCard, StoredCard } from '../domain/cards.js';
import {
  DeployCard,
  Deployment,
  deployCardText,
  deployGroupKey,
  deployLine,
  normalizeDeployName,
} from '../domain/deployment.js';
import { DEPLOYS_SECTION, linkPath } from '../domain/links.js';
import { Attachment, Message } from '../domain/message.js';
import { canStopTurn, type DispatchSummary, WorkAction } from '../domain/work.js';
import { newId } from '../ids.js';
import {
  ALL_ENDPOINTS,
  api,
  attachmentThumbnailUrl,
  CancelDispatchResponse,
  CanvasContentResponse,
  DeployEnvironmentsResponse,
  DeploymentsPage,
  DispatchContext,
  deployEnvironmentsFrom,
  inputJsonSchema,
  MCP_POSTING_TOOLS,
  MCP_TOOLS,
  NeedsYouResponse,
  NOTIFICATION_READ_IDS_MAX,
  ProgressBody,
  ProgressResponse,
  pageThreadReplies,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  RecordDeployInput,
  RecordDeployOutput,
  ThreadView,
  TURN_INJECT_MAX,
  WHOMBAT_TOOL_NAMES,
} from './index.js';

const T = '2026-10-07T10:00:00.000Z';
const SHA = '3f9c2a17b0e4d2c1a9f8e7d6c5b4a3f2e1d0c9b8';

const deployment = (over: Record<string, unknown> = {}) =>
  Deployment.parse({
    id: 'dpl_api00000001',
    environment: 'production',
    service: 'api',
    status: 'succeeded',
    how: 'github_actions',
    summary: 'Invoice PDFs render server-side now.',
    byId: dusty.id,
    createdAt: T,
    ...over,
  });

const message = (over: Record<string, unknown> = {}) =>
  Message.parse({
    id: 'msg_followup01',
    conversationId: 'cnv_billing-v2',
    authorId: mara.id,
    createdAt: T,
    editedAt: null,
    text: 'Also check the totals.',
    mentions: [],
    card: null,
    attachments: [],
    reactions: [],
    threadRootId: 'msg_root0001',
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...over,
  });

const endpoint = (id: string) => ALL_ENDPOINTS.find((e) => e.id === id);

describe('stop a turn (CT-295)', () => {
  it('has dispatches.cancel, answering the turn as it is now', () => {
    const ep = endpoint('dispatches.cancel');
    expect(ep).toMatchObject({ method: 'POST', path: '/burrows/:burrow/dispatches/:dispatchId/cancel' });
    expect(api.dispatches.cancel.id).toBe('dispatches.cancel');
    const dispatch: DispatchSummary = {
      id: 'dsp_turn0001',
      agentId: dusty.id,
      conversationId: 'cnv_billing-v2',
      threadRootId: null,
      trigger: 'mention',
      state: 'cancelled',
      runId: null,
      createdAt: T,
      claimedAt: T,
      heartbeatAt: T,
      finishedAt: T,
      reason: 'Stopped by Mara',
    };
    expect(CancelDispatchResponse.parse({ dispatch }).dispatch.state).toBe('cancelled');
  });

  it('typing names the thinking turn, optionally', () => {
    const base = {
      type: 'typing',
      conversationId: 'cnv_billing-v2',
      threadRootId: null,
      principalId: dusty.id,
      active: true,
      expiresAt: T,
    };
    expect(RealtimeEvent.parse(base)).not.toHaveProperty('dispatchId');
    expect(RealtimeEvent.parse({ ...base, dispatchId: 'dsp_turn0001' })).toMatchObject({
      dispatchId: 'dsp_turn0001',
    });
    expect(RealtimeEvent.parse({ ...base, dispatchId: null })).toMatchObject({ dispatchId: null });
  });

  it('offers Stop to the person, never to the agent or on a run’s turn', () => {
    expect(WorkAction.options).toContain('stop_turn');
    const live = { state: 'running' as const, runId: null };
    expect(canStopTurn(live, mara)).toBe(true);
    expect(canStopTurn(live, dusty)).toBe(false);
    expect(canStopTurn(live, undefined)).toBe(false);
    expect(canStopTurn({ state: 'queued', runId: null }, mara)).toBe(true);
    expect(canStopTurn({ state: 'claimed', runId: null }, mara)).toBe(true);
    expect(canStopTurn({ state: 'done', runId: null }, mara)).toBe(false);
    expect(canStopTurn({ state: 'running', runId: 'run_1907' }, mara)).toBe(false);
    expect(EVENT_TYPES['dispatch.cancelled']).toBe('System');
  });
});

describe('deployments (CT-296, CT-297)', () => {
  it('fills what the deployer didn’t say with null', () => {
    const d = deployment();
    expect(d).toMatchObject({
      repo: null,
      ref: null,
      sha: null,
      url: null,
      runId: null,
      conversationId: null,
      messageId: null,
      previousId: null,
    });
    expect(Deployment.safeParse({ ...d, environment: 'x'.repeat(61) }).success).toBe(false);
    expect(Deployment.safeParse({ ...d, service: 'x'.repeat(81) }).success).toBe(false);
    expect(Deployment.safeParse({ ...d, summary: 'x'.repeat(501) }).success).toBe(false);
    expect(Deployment.safeParse({ ...d, url: 'ftp://example.com' }).success).toBe(false);
    expect(Deployment.safeParse({ ...d, sha: 'abc' }).success).toBe(false);
    expect(Deployment.safeParse({ ...d, environment: 'prod\nuction' }).success).toBe(false);
    expect(newId('deployment')).toMatch(/^dpl_/);
  });

  it('lists and boards them', () => {
    expect(endpoint('deployments.list')).toMatchObject({
      method: 'GET',
      path: '/burrows/:burrow/deployments',
    });
    expect(endpoint('deployments.environments')).toMatchObject({
      method: 'GET',
      path: '/burrows/:burrow/deployments/environments',
    });
    expect(api.deployments.list.query?.parse({})).toEqual({ limit: 50 });
    const current = deployment({ id: 'dpl_api00000002', sha: SHA, previousId: 'dpl_api00000001' });
    const failed = deployment({
      id: 'dpl_api00000003',
      status: 'failed',
      createdAt: '2026-10-07T11:00:00.000Z',
    });
    expect(DeploymentsPage.parse({ deployments: [failed, current], before: null }).deployments).toHaveLength(
      2,
    );
    const board = DeployEnvironmentsResponse.parse({
      environments: [
        {
          environment: 'production',
          lastAt: failed.createdAt,
          services: [{ service: 'api', current, failed, previous: deployment() }],
        },
      ],
    });
    expect(board.environments[0]?.services[0]?.current?.id).toBe('dpl_api00000002');
  });

  it('builds the board: what runs now, a newer failure, the one before', () => {
    const at = (h: number) => `2026-10-0${h < 10 ? 6 : 7}T${String(h % 10).padStart(2, '0')}:00:00.000Z`;
    const board = deployEnvironmentsFrom([
      deployment({ id: 'dpl_a1', createdAt: at(1) }),
      deployment({ id: 'dpl_a2', createdAt: at(11), service: 'API' }),
      deployment({ id: 'dpl_a3', createdAt: at(12), status: 'failed' }),
      deployment({ id: 'dpl_w1', createdAt: at(2), service: 'web', status: 'failed' }),
      deployment({ id: 'dpl_s1', createdAt: at(13), environment: 'Staging' }),
    ]);
    expect(board.environments.map((e) => e.environment)).toEqual(['Staging', 'production']);
    const prod = board.environments[1];
    expect(prod?.lastAt).toBe(at(12));
    expect(prod?.services.map((s) => [s.service, s.current?.id, s.failed?.id, s.previous?.id])).toEqual([
      ['api', 'dpl_a2', 'dpl_a3', 'dpl_a1'],
      ['web', undefined, 'dpl_w1', undefined],
    ]);
    expect(DeployEnvironmentsResponse.parse(board)).toEqual(board);
    expect(deployEnvironmentsFrom([])).toEqual({ environments: [] });
  });

  it('publishes deployment.recorded on the burrow', () => {
    const e = RealtimeEvent.parse({ type: 'deployment.recorded', deployment: deployment() });
    expect(e.type).toBe('deployment.recorded');
    expect(REALTIME_EVENT_TOPICS['deployment.recorded']).toEqual(['burrow']);
    expect(EVENT_TYPES['deploy.recorded']).toBe('Code');
  });

  it('posts a server-made deploy card that settles into one line', () => {
    const card = DeployCard.parse({
      kind: 'deploy',
      deploymentId: 'dpl_api00000002',
      environment: 'production',
      service: 'api',
      status: 'succeeded',
      sha: SHA,
    });
    expect(card).toMatchObject({ url: null });
    expect(MessageCard.parse(card)).toEqual(card);
    expect(StoredCard.parse(card)).toEqual(card);
    expect(PostableCard.safeParse(card).success).toBe(false);
    expect(CARD_KINDS).toContain('deploy');
    expect(MessageCard.options).toHaveLength(CARD_KINDS.length);
    expect(deployLine(card)).toBe('Deployed api to production · 3f9c2a');
    expect(deployLine({ ...card, status: 'failed', sha: null })).toBe('Deploy of api to production failed');
    expect(deployCardText(card)).toBe('[deploy: api to production, succeeded]');
    expect(normalizeDeployName('  web   app ')).toBe('web app');
    expect(deployGroupKey(' Production ')).toBe(deployGroupKey('production'));
    expect(linkPath('acme', { type: 'work', section: DEPLOYS_SECTION })).toBe('/acme/work/deploys');
    expect(linkPath('acme', { type: 'work', section: 'failed' })).toBe('/acme/work?section=failed');
  });

  it('gives agents record_deploy, with no key and not as a posting tool', () => {
    const t = MCP_TOOLS.record_deploy;
    expect(t.requiredKey).toBeNull();
    expect(t.readOnly).toBe(false);
    expect(t.description).toContain('after every deploy you do');
    expect(t.description).toContain('keep secrets out of it');
    expect(WHOMBAT_TOOL_NAMES).toContain('record_deploy');
    expect(MCP_POSTING_TOOLS.has('record_deploy')).toBe(false);
    const input = RecordDeployInput.parse({
      environment: ' production ',
      service: 'api',
      status: 'succeeded',
      how: 'ssh',
      summary: 'Copied the build to the VPS.',
      url: 'https://app.example.com',
    });
    expect(input.environment).toBe('production');
    expect(RecordDeployInput.safeParse({ ...input, how: 'ftp' }).success).toBe(false);
    expect(
      RecordDeployOutput.parse({
        status: 'ok',
        deploymentId: 'dpl_api00000002',
        previousId: null,
        messageId: 'msg_card0001',
      }).status,
    ).toBe('ok');
    const schema = inputJsonSchema('record_deploy') as { required?: string[] };
    expect(schema.required).toEqual(['environment', 'service', 'status', 'how', 'summary']);
    expect(
      describeActivity({
        kind: 'whombat',
        tool: 'whombat.record_deploy',
        status: 'done',
        object: null,
        exitCode: null,
        failure: null,
        keyNeeded: null,
      }).title,
    ).toBe('Recorded a deploy');
  });
});

describe('thread paging (CT-299)', () => {
  it('asks for every reply without a limit, a page with one', () => {
    const q = api.messages.thread.query;
    expect(q?.parse({})).toEqual({});
    expect(q?.parse({ limit: '50', before: 'msg_reply0040' })).toEqual({
      limit: 50,
      before: 'msg_reply0040',
    });
    expect(q?.safeParse({ limit: '201' }).success).toBe(false);
    expect(q?.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('pages from the newest reply back', () => {
    const replies = Array.from({ length: 5 }, (_, i) => ({ id: `msg_r${i + 1}` }));
    expect(pageThreadReplies(replies, {})).toEqual({ replies, more: null });
    const newest = pageThreadReplies(replies, { limit: 2 });
    expect(newest).toEqual({ replies: [{ id: 'msg_r4' }, { id: 'msg_r5' }], more: { before: 'msg_r4' } });
    const earlier = pageThreadReplies(replies, { limit: 2, before: 'msg_r4' });
    expect(earlier).toEqual({ replies: [{ id: 'msg_r2' }, { id: 'msg_r3' }], more: { before: 'msg_r2' } });
    expect(pageThreadReplies(replies, { limit: 2, before: 'msg_r2' })).toEqual({
      replies: [{ id: 'msg_r1' }],
      more: null,
    });
    expect(pageThreadReplies(replies, { limit: 10 }).more).toBeNull();
  });

  it('says where earlier replies start, or null for the first page', () => {
    const root = message({ id: 'msg_root0001', threadRootId: null });
    const base = {
      root,
      replies: [message()],
      conversationId: 'cnv_billing-v2',
      where: '#billing-v2',
      topic: null,
    };
    expect(ThreadView.safeParse(base).success).toBe(false);
    expect(ThreadView.parse({ ...base, more: null }).more).toBeNull();
    expect(ThreadView.parse({ ...base, more: { before: 'msg_followup01' } }).more).toEqual({
      before: 'msg_followup01',
    });
  });
});

describe('thumbnails (CT-298)', () => {
  it('are optional on an attachment, with their route', () => {
    const base = {
      id: 'att_shot0001',
      name: 'shot.png',
      contentType: 'image/png',
      size: 1024,
      url: '/api/v1/burrows/acme/attachments/att_shot0001',
      kind: 'image',
      width: 2400,
      height: 1600,
    };
    expect(Attachment.parse(base)).not.toHaveProperty('thumbnailUrl');
    const thumbnailUrl = attachmentThumbnailUrl('acme', 'att_shot0001');
    expect(thumbnailUrl).toBe('/api/v1/burrows/acme/attachments/att_shot0001/thumbnail');
    expect(
      Attachment.parse({ ...base, thumbnailUrl, thumbnailWidth: 720, thumbnailHeight: 480 }),
    ).toMatchObject({
      thumbnailUrl,
      thumbnailWidth: 720,
    });
    expect(Attachment.parse({ ...base, thumbnailUrl: null }).thumbnailUrl).toBeNull();
  });
});

describe('read state across devices (CT-300)', () => {
  it('names the notifications read, or everything up to a time', () => {
    const some = RealtimeEvent.parse({ type: 'notification.read', ids: ['ntf_one00001'], unread: 3 });
    expect(some).toMatchObject({ ids: ['ntf_one00001'], unread: 3 });
    const all = RealtimeEvent.parse({ type: 'notification.read', ids: null, before: T });
    expect(all).toMatchObject({ ids: null, before: T });
    const many = Array.from({ length: NOTIFICATION_READ_IDS_MAX + 1 }, (_, i) => `ntf_n${i}`);
    expect(RealtimeEvent.safeParse({ type: 'notification.read', ids: many }).success).toBe(false);
    expect(REALTIME_EVENT_TOPICS['notification.read']).toEqual(['me']);
  });
});

describe('needs-you count and canvas content (CT-302, CT-303)', () => {
  it('has both reads', () => {
    expect(endpoint('work.needsYou')).toMatchObject({ method: 'GET', path: '/burrows/:burrow/needs-you' });
    expect(NeedsYouResponse.parse({ count: 2 })).toEqual({ count: 2 });
    expect(endpoint('canvases.content')).toMatchObject({
      method: 'GET',
      path: '/burrows/:burrow/canvases/:slug/content',
    });
    expect(CanvasContentResponse.shape.markdown.parse('# Plan')).toBe('# Plan');
  });
});

describe('runner protocol (CT-304…CT-306)', () => {
  it('skips a fetch the clone doesn’t need, optionally', () => {
    const workspace = DispatchContext.shape.workspace.unwrap();
    const w = {
      repo: 'acme/app',
      branch: 'feat/x',
      baseBranch: 'main',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/acme/app.git',
    };
    expect(workspace.parse(w)).not.toHaveProperty('headSha');
    expect(workspace.parse({ ...w, headSha: SHA }).headSha).toBe(SHA);
    expect(workspace.safeParse({ ...w, headSha: 'abc1234' }).success).toBe(false);
  });

  it('reports delivered follow-ups on a beat (no computer since 3.0)', () => {
    const beat = ProgressBody.parse({ state: 'running', injected: ['dsp_follow0001'] });
    expect(beat).toMatchObject({ injected: ['dsp_follow0001'] });
    expect(ProgressBody.parse({ state: 'running', computerBegun: true })).not.toHaveProperty('computerBegun');
    const tooMany = Array.from({ length: TURN_INJECT_MAX + 1 }, (_, i) => `dsp_f${i}`);
    expect(ProgressBody.safeParse({ state: 'running', injected: tooMany }).success).toBe(false);
  });

  it('hands follow-ups to the running turn', () => {
    const r = ProgressResponse.parse({
      cancel: false,
      reason: null,
      inject: [{ dispatchId: 'dsp_follow0001', messageId: 'msg_followup01', message: message() }],
    });
    expect(r.inject?.[0]).toMatchObject({ dispatchId: 'dsp_follow0001', attachments: [] });
    expect(ProgressResponse.parse({ cancel: true, reason: 'cancelled' }).inject).toBeUndefined();
  });

  it('serves no skill files: Hermes reads its own skills (CT-1216)', () => {
    expect(endpoint('runner.skillFiles')).toBeUndefined();
    expect(endpoint('runner.packSkills')).toBeUndefined();
  });
});
