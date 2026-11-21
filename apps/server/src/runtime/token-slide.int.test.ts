/**
 * Long turns keep their Whombat tools (docs/decisions/essentials-agents.md EA-04). An agent token lasts 30 minutes
 * and slides while its turn is alive — every lease-renewing beat (progress, heartbeat) and every authenticated MCP
 * call — up to the claim + the wall time + 15 minutes. A fake clock stands in for the hours.
 *
 *  A. the real runner: a turn that runs 80 (fake) minutes still posts its final text through MCP;
 *  B. the runner protocol: no beat → the token lapses after 30 minutes; beats keep it past an hour; an MCP call alone
 *     keeps it too; never past the cap; a finished dispatch's token stops at once, and a lapsed one is never revived.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { type AgentProvider, BASIC_CAPABILITIES, type TurnEvent } from '@whombat/agent-runtime';
import { DispatchContext, runnerApi } from '@whombat/core';
import { createRunnerApi, type ProviderRegistry, Runner, testPolicy } from '@whombat/runner';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TOKEN_TTL_MS, agentTokenCapMs, verifyAgentToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import { dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';

const t = useTestServer({ seed: true, listen: true, env: { ...SCRIPTED_ENV, ...signInsEnv() } });
// Agents' git and gh run on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
const AUTH = { authorization: 'Bearer dev-runner-token' };
const MIN = 60_000;

/** The server's clock runs `offset` ahead of the real one. */
let offset = 0;

beforeAll(() => {
  t.services.clock = () => new Date(Date.now() + offset);
  // Leases far longer than any jump of the fake clock: the sweep must not requeue a turn between two beats.
  Object.assign(t.services.runtime.options, { leaseMs: 6 * 60 * MIN, pollMs: 20, retryBackoffMs: 40 });
});

async function drain() {
  const rows = await t.services.db.select().from(dispatches);
  for (const r of rows)
    if (r.state === 'queued' || r.state === 'claimed' || r.state === 'running')
      await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, r.id));
}

async function ask(text: string) {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id;
}

describe('A · the real runner', () => {
  /** A scripted-kind provider that “works” 80 minutes of the server's clock, then answers in its final text. */
  const slow: AgentProvider = {
    kind: 'claude',
    available: async () => ({ ok: true, version: 'slow' }),
    capabilities: () => BASIC_CAPABILITIES,
    async *runTurn(): AsyncIterable<TurnEvent> {
      for (let i = 0; i < 8; i++) {
        offset += 10 * MIN;
        // Real time for the runner's beats (every 30 ms) to reach the server at the new time.
        await sleep(150);
        yield { type: 'thinking' };
      }
      yield { type: 'final', text: 'Finished after eighty minutes.' };
    },
  };
  const registry: ProviderRegistry = scripted({
    claims: () => ['claude'],
    for: () => slow,
    report: () => [],
  });
  let runner: Runner;

  beforeAll(async () => {
    await drain();
    runner = new Runner({
      api: createRunnerApi(t.baseUrl, 'dev-runner-token'),
      registry,
      managed: testPolicy(),
      serverUrl: t.baseUrl,
      workspacesRoot: `${process.env.TMPDIR ?? '/tmp'}/whombat-token-slide`,
      waitMs: 200,
      heartbeatMs: 50,
      progressMs: 30,
    });
    runner.start();
  });

  afterAll(async () => {
    await runner.stop(3000);
  });

  it('posts its final text through MCP after an 80-minute turn', async () => {
    const messageId = await ask('@Dusty please take your time with the rounding audit');
    const [dispatch] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, IDS.dusty)));
    const started = t.services.clock().getTime();
    const done = await waitFor(
      async () => {
        const [row] = await t.services.db
          .select()
          .from(dispatches)
          .where(eq(dispatches.id, dispatch?.id ?? ''));
        return row && ['done', 'failed'].includes(row.state) ? row : null;
      },
      20_000,
      'the long turn to end',
    );
    expect(t.services.clock().getTime() - started).toBeGreaterThanOrEqual(80 * MIN);
    expect(done.state).toBe('done');
    const [reply] = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, IDS.billing), eq(messages.authorId, IDS.dusty)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(reply?.text).toBe('Finished after eighty minutes.');
  });
});

describe('B · the runner protocol', () => {
  const RUNNER = 'rnr_token-slide';

  async function post(url: string, payload: unknown) {
    return t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
  }

  async function claimOne() {
    await drain();
    await ask('@Dusty one more thing');
    const res = await post('/internal/runner/claim', {
      runnerId: RUNNER,
      providers: ['claude'],
      waitMs: 0,
    });
    const ctx = runnerApi.claim.response.parse(res.json()).dispatch;
    if (!ctx) throw new Error('nothing claimed');
    return DispatchContext.parse(ctx);
  }

  // Every call carries the whole lease, the runner and its attempt (managed-sandbox.md MSB-10).
  const beat = async (ctx: DispatchContext) => {
    const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/progress`, {
      state: 'running',
      runnerId: RUNNER,
      attempt: ctx.dispatch.attempts,
    });
    expect(res.statusCode).toBe(200);
  };
  const heartbeat = async (id: string) => {
    const res = await post('/internal/runner/heartbeat', { runnerId: RUNNER, active: [id] });
    expect(res.json()).toMatchObject({ cancel: [] });
  };
  const live = async (token: string) => (await verifyAgentToken(t.services, token)) !== null;

  it('lapses after 30 minutes without a beat or a call', async () => {
    const ctx = await claimOne();
    expect(await live(ctx.agentToken.token)).toBe(true);
    offset += AGENT_TOKEN_TTL_MS + MIN;
    expect(await live(ctx.agentToken.token)).toBe(false);
    // A beat after it lapsed doesn't bring it back.
    await beat(ctx);
    expect(await live(ctx.agentToken.token)).toBe(false);
  });

  it('slides with progress and heartbeats past an hour, never past the claim + wall time + margin', async () => {
    const ctx = await claimOne();
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, ctx.dispatch.id));
    const cap = (row?.claimedAt?.getTime() ?? 0) + agentTokenCapMs(t.services);
    // The wall time is 8 hours by default (resourceful-agents.md RA-14), plus the 15-minute margin.
    const wall = t.services.config.WHOMBAT_SANDBOX_WALL_MINUTES;
    expect(wall).toBe(480);
    expect(agentTokenCapMs(t.services)).toBe((wall + 15) * MIN);
    for (let minute = 20; minute <= wall; minute += 20) {
      offset += 20 * MIN;
      expect(await live(ctx.agentToken.token), `at ${minute} min`).toBe(true);
      if (minute % 40 === 0) await heartbeat(ctx.dispatch.id);
      else await beat(ctx);
    }
    const [after] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, ctx.dispatch.id));
    expect(after?.tokenExpiresAt?.getTime()).toBe(cap);
    offset += 14 * MIN; // a minute before the cap
    expect(await live(ctx.agentToken.token)).toBe(true);
    await beat(ctx);
    offset += 2 * MIN; // past the cap, beats or not
    await beat(ctx);
    expect(await live(ctx.agentToken.token)).toBe(false);
  });

  it('an MCP call alone keeps it alive; a finished dispatch’s token stops at once', async () => {
    const ctx = await claimOne();
    offset += 25 * MIN;
    const mcp = await mcpClient(t.baseUrl, ctx.agentToken.token);
    try {
      const read = await mcp.call('read_conversation', { conversationId: IDS.billing, limit: 1 });
      expect(read.isError).toBe(false);
      offset += 25 * MIN; // 50 minutes after the claim, 25 after the call
      expect(await live(ctx.agentToken.token)).toBe(true);
      const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
        outcome: 'done',
        runnerId: RUNNER,
        attempt: ctx.dispatch.attempts,
      });
      expect(res.statusCode).toBe(200);
      expect(await live(ctx.agentToken.token)).toBe(false);
    } finally {
      await mcp.close().catch(() => {});
    }
  });

  it('an attempt that failed and was queued again loses its token', async () => {
    const ctx = await claimOne();
    expect(await live(ctx.agentToken.token)).toBe(true);
    const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
      outcome: 'failed',
      error: 'the sandbox stopped',
      runnerId: RUNNER,
      attempt: ctx.dispatch.attempts,
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, ctx.dispatch.id));
    expect(row?.state).toBe('queued');
    expect(await live(ctx.agentToken.token)).toBe(false);
  });
});
