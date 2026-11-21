/**
 * Recorded deploys (docs/decisions/review-features.md RF-02; contracts CT-296, CT-297): an agent's `record_deploy` (no
 * key, the turn's agent, the `deploy` card in the turn's thread, `previousId` the deploy that succeeded before, a signed
 * `deploy.recorded` without the summary or URL, `deployment.recorded` on the burrow); the history and the environments
 * board, with the card's place, in reads and frames alike.
 */
import {
  api,
  buildPath,
  DeployEnvironmentsResponse,
  type Deployment,
  DeploymentsPage,
  MCP_TOOLS,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import { deployments, events, messages } from '../db/schema/index';
import { callTool, mcpToolList } from '../mcp/server';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const frames: BusFrame[] = [];
let threadRoot = '';
let mara = '';

beforeAll(async () => {
  t.services.bus.onFrame((f) => {
    if (f.event.type === 'deployment.recorded') frames.push(f);
  });
  mara = await accountOf(t.services, IDS.mara);
  const root = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.billing,
    text: 'Ship the invoice API please',
  });
  if (root.status !== 'ok') throw new Error('no root');
  threadRoot = root.result.id;
});

type Out = Record<string, unknown> & {
  status?: string;
  deploymentId?: string;
  previousId?: string | null;
  messageId?: string | null;
  error?: { code: string; message: string };
};

/** A turn of `agentId` in #billing-v2's thread for Mara, and `record_deploy` in it. */
async function turn(agentId: string = IDS.dusty) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, agentId, IDS.billing, {
    onBehalfOfAccountId: mara,
    threadRootId: threadRoot,
  });
  const auth: AgentAuth = { dispatchId, agentId, burrowId: t.burrowId };
  return {
    dispatchId,
    record: async (args: Record<string, unknown>) => {
      const res = await callTool(t.services, auth, 'record_deploy', args);
      return (res.structuredContent ?? {}) as Out;
    },
  };
}

const base = { how: 'ssh', summary: 'New invoice totals; watch the PDF cache.' } as const;

async function rest<T>(who: string, path: string): Promise<{ status: number; body: T }> {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({ method: 'GET', url: `/api/v1${path}`, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const ids: Record<string, string> = {};

describe('record_deploy', () => {
  it('is listed to the agent’s turn, with no key', async () => {
    const { dispatchId } = await turn();
    const tools = await mcpToolList(t.services, IDS.dusty, dispatchId);
    expect(tools.map((tool) => tool.name)).toContain('record_deploy');
    expect(MCP_TOOLS.record_deploy.requiredKey).toBeNull();
  });

  it('records it, posts the card in the turn’s thread and signs it without the summary', async () => {
    const dusty = await turn();
    frames.length = 0;
    const out = await dusty.record({
      ...base,
      environment: ' Production ',
      service: 'api',
      status: 'succeeded',
      sha: '3F9C2A1B7D',
      url: 'https://api.example.com',
      ref: 'main',
      repo: 'whombat/billing',
    });
    expect(out).toMatchObject({ status: 'ok', previousId: null });
    ids.first = out.deploymentId as string;
    const [row] = await t.services.db.select().from(deployments).where(eq(deployments.id, ids.first));
    expect(row).toMatchObject({
      environment: 'Production',
      environmentKey: 'production',
      service: 'api',
      sha: '3f9c2a1b7d',
      byId: IDS.dusty,
      dispatchId: dusty.dispatchId,
      conversationId: IDS.billing,
      messageId: out.messageId,
    });
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, out.messageId as string));
    expect(card).toMatchObject({
      authorId: IDS.dusty,
      threadRootId: threadRoot,
      text: 'Deployed api to Production · 3f9c2a',
      mentions: [],
      card: {
        kind: 'deploy',
        deploymentId: ids.first,
        environment: 'Production',
        service: 'api',
        status: 'succeeded',
        sha: '3f9c2a1b7d',
        url: 'https://api.example.com',
      },
    });
    const [signed] = await t.services.db.select().from(events).where(eq(events.type, 'deploy.recorded'));
    expect(signed).toMatchObject({ kind: 'Code', actorId: IDS.dusty, text: 'Deployed api to Production' });
    const payload = JSON.stringify(signed?.payload);
    expect(payload).not.toContain('PDF cache');
    expect(payload).not.toContain('api.example.com');
    // Published with its place (one-person.md OP-S69).
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (!frame) throw new Error('no frame');
    expect(frame.topic).toBe(`burrow:${t.burrowId}`);
    expect(frame.event).toMatchObject({
      deployment: { id: ids.first, conversationId: IDS.billing, messageId: out.messageId },
    });
  });

  it('points at the deploy that succeeded before, whatever the spelling; a run that is here only', async () => {
    const dusty = await turn();
    const second = await dusty.record({
      ...base,
      environment: 'production',
      service: 'API',
      status: 'succeeded',
    });
    expect(second.previousId).toBe(ids.first);
    ids.second = second.deploymentId as string;
    const failed = await dusty.record({
      ...base,
      environment: 'production',
      service: 'api',
      status: 'failed',
      runId: 'run_1907',
    });
    expect(failed.previousId).toBe(ids.second);
    ids.failed = failed.deploymentId as string;
    const [row] = await t.services.db.select().from(deployments).where(eq(deployments.id, ids.failed));
    expect(row?.runId).toBe('run_1907');
    // A run that isn't here isn't one to name.
    const next = await turn();
    const refused = await callTool(
      t.services,
      { dispatchId: next.dispatchId, agentId: IDS.dusty, burrowId: t.burrowId },
      'record_deploy',
      { ...base, environment: 'staging', service: 'api', status: 'succeeded', runId: 'run_nope' },
    );
    expect(refused.isError).toBe(true);
    const staging = await next.record({
      ...base,
      environment: 'staging',
      service: 'api',
      status: 'succeeded',
    });
    ids.staging = staging.deploymentId as string;
  });
});

describe('Work · Deploys reads', () => {
  it('the history: newest first, filtered case-insensitively, in pages, with the card’s place', async () => {
    const path = buildPath(api.deployments.list.path, { burrow: 'burrow-hq' });
    const all = await rest<DeploymentsPage>(IDS.mara, path);
    expect(all.status).toBe(200);
    const page = DeploymentsPage.parse(all.body);
    expect(page.deployments.map((d) => d.id)).toEqual([ids.staging, ids.failed, ids.second, ids.first]);
    expect(page.before).toBeNull();
    expect(page.deployments[0]?.conversationId).toBe(IDS.billing);
    expect(page.deployments[0]?.summary).toBe(base.summary);
    const prod = DeploymentsPage.parse((await rest(IDS.mara, `${path}?environment=PRODUCTION&limit=2`)).body);
    expect(prod.deployments.map((d) => d.id)).toEqual([ids.failed, ids.second]);
    expect(prod.before).not.toBeNull();
    const more = DeploymentsPage.parse(
      (await rest(IDS.mara, `${path}?environment=production&limit=2&before=${prod.before}`)).body,
    );
    expect(more.deployments.map((d) => d.id)).toEqual([ids.first]);
    expect(more.before).toBeNull();
    const byService = DeploymentsPage.parse((await rest(IDS.mara, `${path}?service=Api`)).body);
    expect(byService.deployments).toHaveLength(4);
    expect((await rest(IDS.mara, `${path}?before=bm90LWEtY3Vyc29y`)).status).toBe(400);
  });

  it('the board: per environment and service what runs, the newer failure and the deploy before', async () => {
    const path = buildPath(api.deployments.environments.path, { burrow: 'burrow-hq' });
    const res = await rest<DeployEnvironmentsResponse>(IDS.mara, path);
    expect(res.status).toBe(200);
    const board = DeployEnvironmentsResponse.parse(res.body);
    expect(board.environments.map((e) => e.environment)).toEqual(['staging', 'production']);
    const prod = board.environments[1];
    expect(prod?.services).toHaveLength(1);
    const apiRow = prod?.services[0];
    // The newest spelling names it.
    expect(apiRow?.service).toBe('api');
    const id = (d: Deployment | null | undefined) => d?.id ?? null;
    expect([id(apiRow?.current), id(apiRow?.failed), id(apiRow?.previous)]).toEqual([
      ids.second,
      ids.failed,
      ids.first,
    ]);
    expect(apiRow?.current?.conversationId).toBe(IDS.billing);
  });
});
