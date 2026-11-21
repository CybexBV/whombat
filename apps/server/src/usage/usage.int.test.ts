/**
 * Subscription usage end to end against Postgres (docs/decisions/ui-improvements.md UI-R08…UI-R14): who sees what
 * (`usage.list`: the person's own; agents nothing), `usage.refresh` (the caller's own, once a minute, 404 without a
 * sign-in), probes and turn readings stored as one snapshot, `usage.updated` on the person's `me` topic, the probe
 * schedule (never an API key, never under a running turn), and the agent's alerts — once per window and level, in the
 * person's Chat.
 */
import { api, buildPath, type ProbeUsage, type RealtimeEvent, type UsageWindow } from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { conversations, dispatches, messages, principals, subscriptionUsage } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import type { ProbeAnswer, UsageSource } from './service';

const t = useTestServer({ seed: true, app: true });

const moss = {
  burrowId: '',
  mara: '',
  joris: '',
  maraAccount: '',
  jorisAccount: '',
  maraCookie: '',
  jorisCookie: '',
  maraDm: '',
  jorisDm: '',
  agent: '',
};

/** What the fake sign-in executor answers, and what it was asked. */
const source = {
  signIns: [] as { accountId: string; provider: 'claude' | 'codex'; authMode: string }[],
  answers: new Map<string, ProbeAnswer>(),
  asked: [] as string[],
};

/** The usage service's source: the fake's sign-ins and answers. */
const fakeSource: UsageSource = {
  signIns: async () => source.signIns,
  probe: async (accountId, provider) => {
    source.asked.push(`${accountId}/${provider}`);
    return (
      source.answers.get(`${accountId}/${provider}`) ?? {
        ok: false,
        code: 'provider.usage_failed',
        message: 'no answer scripted',
      }
    );
  },
};

const soon = () => new Date(t.services.clock().getTime() + 2 * 3_600_000).toISOString();

function window(kind: 'five_hour' | 'seven_day', usedPct: number, resetsAt = soon()): UsageWindow {
  return {
    kind,
    label: kind === 'five_hour' ? '5-hour' : '7-day',
    usedPct,
    resetsAt,
    status: usedPct >= 100 ? 'limited' : usedPct >= 80 ? 'warning' : 'ok',
    windowMinutes: kind === 'five_hour' ? 300 : 10080,
  };
}

function reading(windows: UsageWindow[], extra: Partial<ProbeUsage> = {}): ProbeAnswer {
  return {
    ok: true,
    usage: {
      provider: 'claude',
      kind: 'subscription',
      plan: 'max',
      windows,
      observedAt: t.services.clock().toISOString(),
      error: null,
      ...extra,
    },
  };
}

async function _personIn(accountId: string): Promise<string> {
  const [row] = await t.services.db
    .select()
    .from(principals)
    .where(and(eq(principals.burrowId, moss.burrowId), eq(principals.accountId, accountId)));
  if (!row) throw new Error('not in burrow');
  return row.id;
}

async function dmOf(personId: string): Promise<{ agentId: string; dmId: string }> {
  const [agent] = await t.services.db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.kind, 'agent'),
        sql`${principals.burrowId} = (select p.burrow_id from principals p where p.id = ${personId})`,
      ),
    );
  if (!agent) throw new Error('no agent');
  const [dm] = await t.services.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.dmAgentId, agent.id), eq(conversations.dmPersonId, personId)));
  return { agentId: agent.id, dmId: dm?.id ?? '' };
}

async function dmTexts(dmId: string): Promise<string[]> {
  const rows = await t.services.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, dmId))
    .orderBy(asc(messages.ord));
  return rows.filter((m) => !m.card).map((m) => m.text);
}

async function call(
  endpoint: typeof api.usage.list | typeof api.usage.refresh,
  cookie: string,
  body?: object,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await t.api.inject({
    method: endpoint.method,
    url: `${endpoint.base}${buildPath(endpoint.path, { burrow: 'moss-co' })}`,
    headers: { cookie },
    ...(body ? { payload: body } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const frames: { topic: string; event: RealtimeEvent }[] = [];

/** Moss Co's agent works on Claude, on the sign-in of the person each turn is for (its default, one-agent.md OA-11). */
async function onClaude() {
  const [agent] = await t.services.db.select().from(principals).where(eq(principals.id, moss.agent));
  await t.services.db
    .update(principals)
    .set({ runtime: { ...(agent?.runtime as object), provider: 'claude' } })
    .where(eq(principals.id, moss.agent));
}

beforeAll(async () => {
  moss.maraAccount = await accountOf(t.services, IDS.mara);
  const created = await createBurrow(t.services, moss.maraAccount, 'Moss Co', { besideOwn: true });
  moss.burrowId = created.burrowId;
  moss.mara = created.principalId;
  await t.services.guides.settle();
  ({ agentId: moss.agent, dmId: moss.maraDm } = await dmOf(moss.mara));
  moss.maraCookie = (await sessionFor(t.services, moss.mara)).cookie;
  // The person's own subscriptions (one-person.md OP-11): the old fixture's names for them stay.
  moss.jorisAccount = moss.maraAccount;
  moss.joris = moss.mara;
  moss.jorisDm = moss.maraDm;
  moss.jorisCookie = moss.maraCookie;
  t.services.usage.useSource(fakeSource);
  t.services.bus.onFrame((f) => {
    if (f.event.type === 'usage.updated') frames.push({ topic: f.topic, event: f.event });
  });
});

beforeEach(async () => {
  source.signIns = [
    { accountId: moss.jorisAccount, provider: 'claude', authMode: 'subscription_cli' },
    { accountId: moss.jorisAccount, provider: 'codex', authMode: 'api_key' },
  ];
  source.answers.clear();
  source.asked.length = 0;
  frames.length = 0;
  await t.services.db.delete(subscriptionUsage);
  await t.services.usage.signIns(true);
});

describe('usage.list: who sees what', () => {
  it('the person sees their own sign-ins, and nobody else’s; an API key is pay as you go', async () => {
    const res = await call(api.usage.list, moss.jorisCookie);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('everyone');
    expect(res.body.mine).toEqual([
      expect.objectContaining({
        provider: 'claude',
        kind: 'subscription',
        connected: true,
        windows: [],
        observedAt: null,
      }),
      expect.objectContaining({ provider: 'codex', kind: 'api_key', windows: [] }),
    ]);
  });

  it('the agent reads nothing', async () => {
    const [agent] = await t.services.db.select().from(principals).where(eq(principals.id, moss.agent));
    if (!agent) throw new Error('no agent');
    await expect(t.services.usage.list(agent, moss.burrowId)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('usage.refresh', () => {
  it('probes the caller’s own subscription, once a minute, and says when to ask again', async () => {
    source.answers.set(
      `${moss.jorisAccount}/claude`,
      reading([window('five_hour', 42), window('seven_day', 10)]),
    );
    const first = await call(api.usage.refresh, moss.jorisCookie, { provider: 'claude' });
    expect(first.status).toBe(200);
    expect(first.body.usage).toMatchObject({
      plan: 'max',
      source: 'probe',
      windows: [
        { kind: 'five_hour', usedPct: 42 },
        { kind: 'seven_day', usedPct: 10 },
      ],
    });
    expect(source.asked).toEqual([`${moss.jorisAccount}/claude`]);
    const again = await call(api.usage.refresh, moss.jorisCookie, { provider: 'claude' });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({
      error: { code: 'rate_limited', details: { retryAfter: expect.any(Number) } },
    });
    expect(source.asked).toHaveLength(1);
  });

  it('no sign-in for the provider is not found', async () => {
    source.signIns = source.signIns.filter((x) => x.provider !== 'codex');
    await t.services.usage.signIns(true);
    const res = await call(api.usage.refresh, moss.maraCookie, { provider: 'codex' });
    expect(res.status).toBe(404);
  });

  it('usage.updated goes to the person', async () => {
    source.answers.set(`${moss.maraAccount}/claude`, reading([window('five_hour', 12)]));
    await call(api.usage.refresh, moss.maraCookie, { provider: 'claude' });
    const topics = frames.map((f) => f.topic);
    expect(topics).toContain(`me:${moss.mara}`);
    expect(topics.every((topic) => topic.startsWith('me:'))).toBe(true);
    const mine = frames.find((f) => f.topic === `me:${moss.mara}` && f.event.type === 'usage.updated');
    expect(mine?.event).toMatchObject({ usage: { windows: [{ usedPct: 12 }] } });
  });
});

describe('alerts', () => {
  it('80 %: the agent tells the subscription’s person once; 95 % and the limit follow', async () => {
    // Both Chats, each in its own order: what came since in either.
    const chats = async () => ({ dusty: await dmTexts(IDS.dmDusty), moss: await dmTexts(moss.maraDm) });
    const start = await chats();
    const fresh = async () => {
      const now = await chats();
      return [...now.dusty.slice(start.dusty.length), ...now.moss.slice(start.moss.length)];
    };
    source.answers.set(`${moss.jorisAccount}/claude`, reading([window('five_hour', 85)]));
    await t.services.usage.probe(moss.jorisAccount, 'claude');
    await t.services.usage.settle();
    let joris = await fresh();
    expect(joris).toEqual([
      expect.stringMatching(/^Your Claude subscription is at 85 % of its 5-hour limit, resets /),
    ]);

    // The same window again: nothing new.
    await t.services.usage.probe(moss.jorisAccount, 'claude');
    await t.services.usage.settle();
    expect(await fresh()).toHaveLength(1);

    // A turn for Joris (on his own Claude sign-in) hits the limit.
    await onClaude();
    const { dispatchId } = await agentTokenFor(t.services, moss.burrowId, moss.agent, moss.jorisDm, {
      onBehalfOfAccountId: moss.jorisAccount,
    });
    await t.services.usage.fromTurn(dispatchId, {
      provider: 'claude',
      plan: null,
      windows: [window('five_hour', 100)],
      observedAt: t.services.clock().toISOString(),
    });
    await t.services.usage.settle();
    joris = await fresh();
    expect(joris[1]).toMatch(
      /^Your Claude subscription hit its 5-hour limit, resets .*Turns on it wait until then\.$/,
    );
    const [row] = await t.services.db
      .select()
      .from(subscriptionUsage)
      .where(eq(subscriptionUsage.accountId, moss.jorisAccount));
    expect(row).toMatchObject({ source: 'turn', plan: 'max' });
    expect(row?.usedAt).not.toBeNull();
    await t.services.db.delete(dispatches).where(eq(dispatches.id, dispatchId));
  });

  it('a turn on an organization credential or on the operator’s login is nobody’s subscription', async () => {
    const { dispatchId } = await agentTokenFor(t.services, moss.burrowId, moss.agent, moss.jorisDm, {
      onBehalfOfAccountId: moss.jorisAccount,
    });
    // The agent runs on another provider than the reading's: dropped.
    await t.services.usage.fromTurn(dispatchId, {
      provider: 'codex',
      plan: null,
      windows: [window('five_hour', 99)],
      observedAt: t.services.clock().toISOString(),
    });
    expect(await t.services.db.select().from(subscriptionUsage)).toEqual([]);
    await t.services.db.delete(dispatches).where(eq(dispatches.id, dispatchId));
  });
});

describe('the probe schedule', () => {
  it('probes what is due, never an API key, never under a running turn; drops signed-out snapshots', async () => {
    source.answers.set(`${moss.maraAccount}/claude`, reading([window('five_hour', 5)]));
    await onClaude();
    const { dispatchId } = await agentTokenFor(t.services, moss.burrowId, moss.agent, moss.maraDm, {
      onBehalfOfAccountId: moss.maraAccount,
      state: 'running',
    });
    expect(await t.services.usage.tick()).toBe(0);
    await t.services.db.delete(dispatches).where(eq(dispatches.id, dispatchId));
    expect(await t.services.usage.tick()).toBe(1);
    expect(source.asked).toEqual([`${moss.maraAccount}/claude`]);
    // Just read: not due again.
    expect(await t.services.usage.tick()).toBe(0);

    // Mara signs out of Claude: her snapshot goes once the tick reads the sign-ins again (they are kept 5 minutes,
    // server-efficiency.md SV-03; a new source drops the list as its age would).
    source.signIns = [];
    await t.services.usage.tick();
    expect((await t.services.db.select().from(subscriptionUsage)).length).toBe(1);
    t.services.usage.useSource(fakeSource);
    await t.services.usage.tick();
    expect(await t.services.db.select().from(subscriptionUsage)).toEqual([]);
  });

  it('a runner that can’t probe yet (an older release) is not asked again for a while', async () => {
    const unsupported = {
      ok: false,
      code: 'unsupported',
      message: 'Usage can be read once this Whombat’s runner is updated.',
    } as const;
    source.answers.set(`${moss.maraAccount}/claude`, unsupported);
    // The first answer stops the round; the snapshot says why.
    expect(await t.services.usage.tick()).toBe(1);
    const rows = await t.services.db.select().from(subscriptionUsage);
    expect(rows.map((r) => r.error)).toEqual([expect.stringMatching(/runner is updated/)]);
    expect(await t.services.usage.tick()).toBe(0);
  });
});
