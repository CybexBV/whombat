/**
 * Whombat's own tools as activity rows from the calls the server ran (`runtime/activity-mcp.ts`; work-supervision.md
 * WS-12…WS-15): an agent's MCP call over HTTP is its dispatch's row, running then finished, with the outcome the tool
 * gave — done, waiting on the approval it made, blocked by a key, failed with its reason, bare in an assessment — and
 * nothing for a dispatch that isn't live.
 *
 * Needs Postgres: the outcome is the keys engine's through the commit pipeline (an approval row, a signed Blocked
 * event), and the row is written in the server's own transaction, checked against the dispatch's state and the
 * approvals table, and framed from the outbox.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activities, dispatches } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { agentTokenFor, type TestDispatchOptions } from '../test/tokens';
import { withToolActivity } from './activity-mcp';

const t = useTestServer({ seed: true, listen: true });
const clients: TestMcp[] = [];
const frames: BusFrame[] = [];

beforeAll(() => {
  // The deploy ask is about the keys engine: its executor is a stand-in (EA-02).
  simulateExecutors(t.services, 'deploy');
  t.services.bus.onFrame((f) => frames.push(f));
});
beforeEach(() => {
  frames.length = 0;
});
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

async function turn(options: TestDispatchOptions = {}) {
  const { token, dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, options);
  const mcp = await mcpClient(t.baseUrl, token);
  clients.push(mcp);
  return Object.assign(mcp, { dispatchId });
}

const rowsOf = (dispatchId: string) =>
  t.services.db.select().from(activities).where(eq(activities.dispatchId, dispatchId));

describe('a Whombat tool call is its dispatch’s activity row', () => {
  it('post_message: running, then done, keyed per call, framed to the conversation', async () => {
    const dusty = await turn();
    const posted = await dusty.call('post_message', {
      conversationId: IDS.billing,
      text: 'Checked the totals.',
    });
    expect(posted.body.status).toBe('ok');
    const rows = await rowsOf(dusty.dispatchId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      attempt: 1,
      seq: 2,
      kind: 'whombat',
      tool: 'whombat.post_message',
      status: 'done',
      object: null,
      evidence: null,
      conversationId: IDS.billing,
    });
    expect(row?.key).toMatch(/^1:mcp-[A-Za-z0-9_-]+$/);
    expect(row?.finishedAt).not.toBeNull();
    const seen = frames.flatMap((f) =>
      f.event.type === 'activity.updated' && f.event.activity.key === row?.key
        ? [[f.topic, f.event.activity.status]]
        : [],
    );
    expect(seen).toEqual([
      [`conv:${IDS.billing}`, 'running'],
      [`conv:${IDS.billing}`, 'done'],
    ]);
    // A second call is a row of its own.
    await dusty.call('set_status', { doing: 'Reviewing the totals' });
    expect(new Set((await rowsOf(dusty.dispatchId)).map((r) => r.key)).size).toBe(2);
  });

  it('pending_approval: the row waits, linked to the approval the call made', async () => {
    const dusty = await turn();
    const res = await dusty.call('perform_action', {
      conversationId: IDS.billing,
      reason: 'Hotfix for the rounding bug',
      action: {
        type: 'deploy',
        params: { environment: 'production', service: 'billing-api', ref: 'main', sha: null },
      },
    });
    expect(res.body.status).toBe('pending_approval');
    const [row] = await rowsOf(dusty.dispatchId);
    expect(row).toMatchObject({
      tool: 'whombat.perform_action',
      status: 'waiting',
      approvalId: res.body.approvalId,
      finishedAt: null,
    });
  });

  it('blocked: the row fails with the key it needed', async () => {
    const dusty = await turn();
    const merge = await dusty.call('merge_pull_request', { prNumber: 482 });
    expect(merge.body.status).toBe('blocked');
    const [row] = await rowsOf(dusty.dispatchId);
    expect(row).toMatchObject({ tool: 'whombat.merge_pull_request', status: 'failed', failure: 'blocked' });
    expect(row?.keyNeeded).toBe((merge.body.keyNeeded as { label: string }).label);
  });

  it('an MCP error: the row fails with why, in the words the agent got (RA-DS49)', async () => {
    const dusty = await turn();
    const res = await dusty.call('plan_create', {
      conversationId: IDS.billing,
      title: 'x'.repeat(161),
      steps: [{ title: 'Check' }],
    });
    expect(res.isError).toBe(true);
    const [row] = await rowsOf(dusty.dispatchId);
    expect(row).toMatchObject({ tool: 'whombat.plan_create', status: 'failed', failure: 'error' });
    expect(row?.detail).toContain('title');
    expect(row?.evidence?.output).toContain('title');
  });

  it('a Feedback assessment’s row is bare: kind and state only (WS-14)', async () => {
    const assessor = await turn({ trigger: 'feedback' });
    const res = await assessor.call('post_message', { conversationId: IDS.billing, text: 'Hello' });
    expect(res.isError).toBe(true);
    const [row] = await rowsOf(assessor.dispatchId);
    expect(row).toMatchObject({
      kind: 'whombat',
      status: 'failed',
      failure: 'error',
      object: null,
      keyNeeded: null,
      evidence: null,
    });
  });

  it('a dispatch that isn’t live gets no row, and the call’s answer is unchanged', async () => {
    const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, dispatchId));
    const answer: CallToolResult = {
      content: [{ type: 'text', text: '{"status":"ok"}' }],
      structuredContent: {},
    };
    const out = await withToolActivity(t.services, { dispatchId }, 'post_message', {}, async () => answer);
    expect(out).toBe(answer);
    expect(await rowsOf(dispatchId)).toEqual([]);
  });
});
