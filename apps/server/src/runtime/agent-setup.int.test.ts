/**
 * AI provider setup on a live Whombat (docs/decisions/agent-setup.md): `host.agents` summarizes what the runners
 * report, and a dispatch no connected runner can run ends with the agent's quiet reply — after a runner's first claim
 * when the server just started, as its heartbeat alone doesn't say what it runs.
 */
import { AgentSetupStatus, api, buildPath, unrunnableReply } from '@whombat/core';
import { desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { aiClients, CLIENT_CATCH_UP_MS, type ManagerClients } from '../clients/service';
import { sendMessage } from '../commands/messages';
import { messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let mara = '';

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

async function setup(method: 'GET' | 'POST' = 'GET') {
  const ep = method === 'GET' ? api.host.agents : api.host.recheckAgents;
  const res = await t.api.inject({
    method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie: mara },
  });
  expect(res.statusCode).toBe(200);
  return AgentSetupStatus.parse(res.json());
}

async function lastMessageBy(authorId: string) {
  const [row] = await t.services.db
    .select()
    .from(messages)
    .where(eq(messages.authorId, authorId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row;
}

describe('dispatches no runner can run', () => {
  async function mention(text: string) {
    const res = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text });
    if (res.status !== 'ok') throw new Error('send failed');
    return res.result.id;
  }

  it('with no runner at all, the agent says the runner isn’t running', async () => {
    const options = t.services.runtime.options;
    const lease = options.leaseMs;
    Object.assign(options, { leaseMs: 1, noRunnerMs: 0 });
    try {
      await new Promise((r) => setTimeout(r, 10));
      expect((await setup()).runner.connected).toBe(false);
      await mention('@Dusty anyone home?');
      await t.services.runtime.sweepUnrunnable();
      expect((await lastMessageBy(IDS.dusty))?.text).toBe(unrunnableReply({ kind: 'no_runner' }));
    } finally {
      Object.assign(options, { leaseMs: lease });
    }
  });

  it('a runner that beat after the start but hasn’t claimed yet: its turns wait until its claim says what it runs', async () => {
    const options = t.services.runtime.options;
    const saved = { unrunnableMs: options.unrunnableMs, noRunnerMs: options.noRunnerMs };
    // Just started (well within noRunnerMs), and a turn is due for the check at once.
    Object.assign(options, { unrunnableMs: 0, noRunnerMs: 3_600_000 });
    try {
      await t.services.runtime.heartbeat({ runnerId: 'rnr_after-restart', active: [] });
      await mention('@Dusty are you back?');
      expect(await t.services.runtime.sweepUnrunnable()).toBe(0);
      expect((await lastMessageBy(IDS.dusty))?.text).not.toBe(
        unrunnableReply({ kind: 'provider', provider: 'claude' }),
      );
      // Its claim says it runs only the model on the network: Dusty's Claude turn is one it can't run.
      expect(
        await t.services.runtime.claim({ runnerId: 'rnr_after-restart', providers: ['local'], waitMs: 0 }),
      ).toBeNull();
      expect(await t.services.runtime.sweepUnrunnable()).toBeGreaterThan(0);
      expect((await lastMessageBy(IDS.dusty))?.text).toBe(
        unrunnableReply({ kind: 'provider', provider: 'claude' }),
      );
    } finally {
      Object.assign(options, saved);
    }
  });

  it('a client the manager has just installed: its turns wait for the runner to find it, not refused at once', async () => {
    const options = t.services.runtime.options;
    const saved = { unrunnableMs: options.unrunnableMs, noRunnerMs: options.noRunnerMs };
    Object.assign(options, { unrunnableMs: 0, noRunnerMs: 0 });
    const clients = (await aiClients(t.services)) as ManagerClients;
    try {
      // A runner that runs ChatGPT only so far; the manager reports Claude Code installed.
      expect(
        await t.services.runtime.claim({ runnerId: 'rnr_before-recheck', providers: ['codex'], waitMs: 0 }),
      ).toBeNull();
      await clients.apply({ clients: [claudeInstalled], channel: null });
      await mention('@Dusty did the install finish?');
      expect(await t.services.runtime.sweepUnrunnable()).toBe(0);
      // A client the runner still hasn't found a minute later is one this Whombat can't run.
      clients.installedAt.set('claude', Date.now() - CLIENT_CATCH_UP_MS - 1);
      expect(await t.services.runtime.sweepUnrunnable()).toBeGreaterThan(0);
      expect((await lastMessageBy(IDS.dusty))?.text).toBe(
        unrunnableReply({ kind: 'provider', provider: 'claude' }),
      );
    } finally {
      Object.assign(options, saved);
      await clients.apply({ clients: [], channel: null });
    }
  });
});

const claudeInstalled = {
  provider: 'claude' as const,
  state: 'installed' as const,
  installed: {
    version: '1.0.0',
    installedAt: '2026-11-15T00:00:00Z',
    executable: { path: '/persist/whombat/clients/claude/1.0.0/claude', sha256: 'a'.repeat(64) },
    fixturesDigest: `sha256:${'a'.repeat(64)}`,
  },
  latest: null,
  progress: null,
  error: null,
};
