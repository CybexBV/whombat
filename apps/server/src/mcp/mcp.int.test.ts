/**
 * The Whombat MCP server end to end over streamable HTTP (SDK client, agent tokens): every tool is
 * advertised, tool calls run the commit pipeline as the agent (allow / ask / blocked with signed events),
 * runs stream, and calls are rate-limited per agent and per dispatch.
 */
import { MCP_PATH } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import { approvals, dispatches, events, grants, messages, notifications, runs } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { makeRoom } from '../test/rooms';
import { agentTokenFor } from '../test/tokens';
import { McpRateLimiter } from './rate-limit';
import { onBehalfOf } from './tools';

const t = useTestServer({ seed: true, listen: true, env: signInsEnv() });
// Runs need a checkout: agents' git runs on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));

// The deploy ask is about the keys engine: its executor is a stand-in the suite asks for (EA-02).
beforeAll(() => simulateExecutors(t.services, 'deploy'));
const clients: TestMcp[] = [];

async function as(agentId: string, conversationId: string = IDS.billing) {
  const { token, dispatchId } = await agentTokenFor(t.services, t.burrowId, agentId, conversationId);
  const mcp = await mcpClient(t.baseUrl, token);
  clients.push(mcp);
  return Object.assign(mcp, { dispatchId });
}

async function event(id: string) {
  const [row] = await t.services.db.select().from(events).where(eq(events.id, id));
  return row;
}

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

describe('MCP server', () => {
  it('refuses requests without a live agent token', async () => {
    const res = await fetch(new URL(MCP_PATH, t.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const bad = await fetch(new URL(MCP_PATH, t.baseUrl), {
      method: 'POST',
      headers: { authorization: 'Bearer wat_nope', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
  });
});

describe('tool calls run commands as the agent', () => {
  it('says which arguments are wrong and why, in the text the agent reads', async () => {
    const banjo = await as(IDS.dusty);
    const res = await banjo.client.callTool({
      name: 'plan_create',
      arguments: { conversationId: IDS.billing, title: 'x'.repeat(161), steps: [{ title: 'Check' }] },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toMatch(/^validation_failed: Some arguments are not valid\.\n- title: .*160/);
  });

  it('posts a digest card and indexes its items (RM-08)', async () => {
    const banjo = await as(IDS.dusty);
    const card = {
      kind: 'digest',
      title: 'Checks',
      summary: '2 failing',
      sections: [
        {
          label: 'Failing',
          items: [
            {
              time: '16:08',
              title: 'CI / check',
              source: 'GitHub',
              note: '4 annotations',
              url: 'https://github.com/x/y',
            },
            { title: 'pdf-snapshot' },
          ],
        },
      ],
    };
    const posted = await banjo.call('post_card', {
      conversationId: IDS.billing,
      text: 'Two checks fail.',
      card,
    });
    expect(posted).toMatchObject({ isError: false, body: { status: 'ok' } });
    const [row] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, posted.body.messageId as string));
    expect(row?.card).toEqual({
      ...card,
      sections: [
        {
          label: 'Failing',
          collapsed: false,
          items: [
            card.sections[0]?.items[0],
            { time: null, title: 'pdf-snapshot', source: null, note: null, url: null },
          ],
        },
      ],
    });
  });

  it('notifies with plain text, not Markdown (RM-03)', async () => {
    const banjo = await as(IDS.dusty);
    const posted = await banjo.call('post_message', {
      conversationId: IDS.billing,
      text: '**Heads up** @Mara, `CI / check` failed',
    });
    const messageId = posted.body.messageId as string;
    await vi.waitFor(async () => {
      const rows = await t.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.principalId, IDS.mara));
      const note = rows.find((n) => (n.link as { messageId?: string }).messageId === messageId);
      expect(note?.text).toBe('Heads up @Mara, CI / check failed');
    });
  });

  it('the agent mentioning itself wakes nobody (one-agent.md OA-S44)', async () => {
    const dusty = await as(IDS.dusty);
    const posted = await dusty.call('post_message', {
      conversationId: IDS.billing,
      text: '@Dusty, please review this.',
    });
    expect(posted).toMatchObject({ isError: false, body: { status: 'ok' } });
    const messageId = posted.body.messageId as string;
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row?.mentions).not.toContain(IDS.dusty);
    expect(await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId))).toEqual(
      [],
    );
  });

  it('posts in any room of the burrow, and nowhere else', async () => {
    const quiet = await makeRoom(t.services, t.burrowId, 'quiet-room');
    const dusty = await as(IDS.dusty);
    const there = await dusty.call('post_message', { conversationId: quiet, text: 'Hi' });
    expect(there.body).toMatchObject({ status: 'ok' });
    const nowhere = await dusty.call('post_message', { conversationId: 'cnv_nowhere', text: 'Hi' });
    expect(nowhere.isError).toBe(true);
    expect(nowhere.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('search without the key covers every conversation of the burrow (AS-01)', async () => {
    const word = 'wombatledger';
    const without = await makeRoom(t.services, t.burrowId, 'without-dusty');
    for (const conversationId of [IDS.billing, IDS.general, without])
      await t.services.pipeline.commit(
        sendMessage,
        { conversationId, text: `The ${word} export ran twice.` },
        { burrowId: t.burrowId, actorId: IDS.mara },
      );
    await new Promise((r) => setTimeout(r, 300));
    // Without “Search messages, canvases and runs”: still every room, all of them the person's.
    const searchKey = and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'messages.search'));
    const [held] = await t.services.db.select().from(grants).where(searchKey);
    await t.services.db.delete(grants).where(searchKey);
    try {
      const dusty = await as(IDS.dusty);
      const res = await dusty.call('search', { query: word, limit: 20 });
      expect(res.body.status).toBe('ok');
      const hits = (res.body.results as { snippet: string; where: string }[]).filter((r) =>
        r.snippet.includes(word),
      );
      expect(hits.map((r) => r.where.split(' · ')[0]).sort()).toEqual([
        'billing-v2',
        'general',
        'without-dusty',
      ]);
      expect(res.body).not.toHaveProperty('eventId');
    } finally {
      if (held) await t.services.db.insert(grants).values(held);
    }
  });

  it('blocked: merge into main is signed as Blocked', async () => {
    const banjo = await as(IDS.dusty);
    const merge = await banjo.call('merge_pull_request', { prNumber: 482 });
    expect(merge.body).toMatchObject({ status: 'blocked', keyNeeded: { id: 'merge.main' } });
    expect(await event(merge.body.eventId as string)).toMatchObject({
      text: 'Tried to merge PR #482 into main. Blocked.',
      kind: 'Blocked',
    });
  });

  it('finds what the agent may read wherever the person’s turn works (one-person.md OP-S71)', async () => {
    const word = 'quokkaforecast';
    await t.services.pipeline.commit(
      sendMessage,
      { conversationId: IDS.incidents, text: `The ${word} job paged again at 03:10.` },
      { burrowId: t.burrowId, actorId: IDS.mara },
    );
    await new Promise((r) => setTimeout(r, 300));
    const found = async (conversationId: string) => {
      const dusty = await as(IDS.dusty, conversationId);
      const res = await dusty.call('search', { query: word, limit: 20 });
      expect(res.body.status).toBe('ok');
      return (res.body.results as { snippet: string }[]).filter((r) => r.snippet.includes(word)).length;
    };
    expect(await found(IDS.incidents)).toBe(1);
    expect(await found(IDS.billing)).toBe(1);
  });

  it('ask: a keyed action the agent may only do after approval becomes a pending approval', async () => {
    const neo = await as(IDS.dusty);
    const res = await neo.call('perform_action', {
      conversationId: IDS.billing,
      reason: 'Hotfix for the rounding bug',
      action: {
        type: 'deploy',
        params: { environment: 'production', service: 'billing-api', ref: 'main', sha: null },
      },
    });
    expect(res.body).toMatchObject({ status: 'pending_approval' });
    const [approval] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, res.body.approvalId as string));
    expect(approval).toMatchObject({ requesterId: IDS.dusty, keyId: 'deploy.production', state: 'pending' });
    // A yes runs the deploy's own executor, not perform_action again (essentials-agents.md EA-02).
    expect(approval?.command).toBeNull();
    expect(approval?.action).toMatchObject({
      type: 'deploy',
      params: { ref: 'main', environment: 'production' },
    });
    expect(await event(res.body.eventId as string)).toMatchObject({
      kind: 'Asks',
      text: 'Asked to deploy main to production',
    });
  });

  it('start_run: who asked comes from the dispatch, never from the agent', async () => {
    // Mara asks Dusty in #billing-v2; Dusty's turn claims Dusty asked.
    const sent = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: '@Dusty can you add credit notes to the PDF export?',
    });
    if (sent.status !== 'ok') throw new Error('send failed');
    const [dispatch] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, sent.result.id), eq(dispatches.agentId, IDS.dusty)));
    if (!dispatch) throw new Error('no dispatch');
    const banjo = await mcpClient(t.baseUrl, (await issueDispatchToken(t.services, dispatch.id)).token);
    clients.push(banjo);
    const input = {
      conversationId: IDS.billing,
      repo: 'whombat/billing',
      askedById: IDS.dusty,
      steps: [{ title: 'Write credit notes', detail: '' }],
    };
    const started = await banjo.call('start_run', {
      ...input,
      title: 'Add credit notes',
      branch: 'feat/credit-note-export',
    });
    expect(started.body).toMatchObject({ status: 'ok' });
    const [run] = await t.services.db
      .select()
      .from(runs)
      .where(eq(runs.number, started.body.number as number));
    expect(run?.askedById).toBe(IDS.mara);
    // Everything its run-control turns sign is ON BEHALF OF Mara, where she asked.
    expect(await onBehalfOf(t.services, { ...dispatch, runId: run?.id ?? null })).toEqual({
      text: 'Mara in billing-v2',
      principalId: IDS.mara,
    });

    // Nobody asked (no trigger message): the agent asked itself, whoever it names.
    const solo = await as(IDS.dusty);
    const own = await solo.call('start_run', {
      ...input,
      askedById: IDS.mara,
      title: 'Tidy PDFs',
      branch: 'feat/tidy-pdf',
    });
    const [ownRun] = await t.services.db
      .select()
      .from(runs)
      .where(eq(runs.number, own.body.number as number));
    expect(ownRun?.askedById).toBe(IDS.dusty);
  });

  it('a run on main is blocked', async () => {
    const dusty = await as(IDS.dusty);
    const main = await dusty.call('start_run', {
      conversationId: IDS.billing,
      title: 'Hotfix on main',
      repo: 'whombat/billing',
      branch: 'main',
      steps: [{ title: 'Patch', detail: '' }],
    });
    expect(main.body).toMatchObject({ status: 'blocked', keyNeeded: { id: 'branch.main.push' } });
  });
});

describe('what a turn is served (prompt-efficiency.md PE-05)', () => {
  async function listed(conversationId: string, options: Parameters<typeof agentTokenFor>[4] = {}) {
    const { token } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, conversationId, options);
    const mcp = await mcpClient(t.baseUrl, token);
    clients.push(mcp);
    return (await mcp.client.listTools()).tools;
  }

  it('lists post_answer only in an answer and the run reports only on a run, with lean schemas', async () => {
    const chat = await listed(IDS.billing);
    const names = chat.map((x) => x.name);
    expect(names).toContain('start_run');
    expect(names).toContain('request_approval');
    for (const name of ['post_answer', 'run_step', 'run_log', 'run_tests', 'run_files', 'finish_run'])
      expect(names).not.toContain(name);
    const served = JSON.stringify(chat);
    expect(served).not.toContain('9007199254740991');
    expect(served).not.toContain('json-schema.org');
    const ask = JSON.stringify(chat.find((x) => x.name === 'request_approval')?.inputSchema);
    expect(ask).toContain('"grant_key"');

    const run = (await listed(IDS.billing, { mode: 'run' })).map((x) => x.name);
    expect(run).toEqual(
      expect.arrayContaining(['run_step', 'run_log', 'run_tests', 'run_files', 'finish_run']),
    );
    expect(run).not.toContain('post_answer');
    const answer = (await listed(IDS.billing, { mode: 'answer' })).map((x) => x.name);
    expect(answer).toContain('post_answer');
    expect(answer).not.toContain('run_step');
  });

  it('still validates every call with the full schema and says exactly what is wrong', async () => {
    const banjo = await as(IDS.dusty);
    const served = (await banjo.client.listTools()).tools.find((x) => x.name === 'canvas_read');
    // The lean schema leaves “not empty” out; the server still checks it.
    expect(JSON.stringify(served?.inputSchema)).not.toContain('minLength');
    const res = await banjo.client.callTool({ name: 'canvas_read', arguments: { canvas: '' } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toMatch(/^validation_failed: Some arguments are not valid\.\n- canvas: .*1/);
    // A tool this turn isn't served still answers when called: about the run, not “no such tool”.
    const other = await banjo.client.callTool({
      name: 'run_log',
      arguments: { run: 999_999, lines: ['$ ls'] },
    });
    const said = (other.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(said).not.toContain('There is no tool called');
    expect(said).toMatch(/run/i);
  });
});

describe('what a request reads about its turn', () => {
  /** The statements the server sends Postgres while `fn` runs (postgres.js's `debug` hook on the suite's pool). */
  async function statements(fn: () => Promise<unknown>): Promise<string[]> {
    const options = (t.services.sql as unknown as { options: { debug: unknown } }).options;
    const before = options.debug;
    const seen: string[] = [];
    options.debug = (_connection: number, query: string) => seen.push(query);
    try {
      await fn();
    } finally {
      options.debug = before;
    }
    return seen;
  }

  const byId = (table: string) => (query: string) =>
    query.includes(`from "${table}" where "${table}"."id" = $1`) && !query.includes('for share');

  it('lists the tools reading the dispatch and the agent once', async () => {
    const mcp = await as(IDS.dusty);
    await mcp.client.listTools();
    const seen = await statements(() => mcp.client.listTools());
    // Before reads were shared it took 33; the Vault and look checks still read the dispatch themselves.
    expect(seen.length).toBeLessThanOrEqual(22);
    expect(seen.filter(byId('principals')).length).toBeLessThanOrEqual(2);
  });

  it('checks a called tool without reading the whole list, and runs it on the same dispatch row', async () => {
    const mcp = await as(IDS.dusty);
    await mcp.call('plan_read', {});
    const seen = await statements(() => mcp.call('plan_read', {}));
    // Token, its slide and the call's two activity records are 16; the turn's shape is the rest (46 before).
    expect(seen.length).toBeLessThanOrEqual(24);
    // The token check reads the dispatch with its token; the served check and the tool share one more read.
    expect(seen.filter(byId('dispatches'))).toHaveLength(1);
    expect(seen.filter(byId('principals'))).toHaveLength(1);
    for (const table of ['grants', 'catalog_connections', 'connections', 'look_researches'])
      expect(
        seen.filter((q) => q.includes(`from "${table}"`)),
        table,
      ).toEqual([]);
  });
});

describe('rate limits', () => {
  it('limits tool calls per dispatch and per agent', async () => {
    const original = t.services.runtime.mcpLimiter;
    t.services.runtime.mcpLimiter = new McpRateLimiter({
      perAgent: { capacity: 4, perSecond: 0.001 },
      perDispatch: { capacity: 2, perSecond: 0.001 },
    });
    try {
      const first = await as(IDS.dusty);
      const ok1 = await first.call('set_status', { doing: 'One' });
      const ok2 = await first.call('set_status', { doing: 'Two' });
      const limited = await first.call('set_status', { doing: 'Three' });
      expect([ok1.isError, ok2.isError]).toEqual([false, false]);
      expect(limited).toMatchObject({
        isError: true,
        body: { error: { code: 'rate_limited', scope: 'dispatch' } },
      });

      const second = await as(IDS.dusty);
      await second.call('set_status', { doing: 'Four' });
      await second.call('set_status', { doing: 'Five' });
      const agentLimited = await second.call('set_status', { doing: 'Six' });
      expect(agentLimited).toMatchObject({ body: { error: { code: 'rate_limited', scope: 'agent' } } });
    } finally {
      t.services.runtime.mcpLimiter = original;
    }
  });
});
