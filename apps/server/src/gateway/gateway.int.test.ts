/**
 * The AI gateway end to end against Postgres and a fake Fusebox (docs/decisions/ai-gateway.md AIG-01…AIG-16):
 * connecting Fusebox makes Whombat's own named client (revision retries, an open Fusebox stays open, a too old one is
 * refused), one gateway per burrow, the person's switches (signed under Keys, the burrow published), a claimed turn's
 * route (`DispatchContext.gateway`, no credential, `gateway_provider`) and its refusals posted by the agent, a turn
 * Fusebox has no room for (AIG-D31), the heartbeat's switches, the relay streaming a turn's SSE answer with the client
 * key and its refusals, the poller's pool with the accounts' emails and the person's alerts, Fusebox among the Services
 * with its card, points and page (fusebox-page.md FP-01…FP-12), and removing the connection (its client key taken out
 * of Fusebox).
 */
import { request as httpRequest } from 'node:http';
import { api, buildPath, formatGatewayUntil, RUNNER_PREFIX, runnerApi } from '@whombat/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import { openConnectionSecret } from '../connections/crypto';
import {
  burrows,
  catalogConnections,
  dispatches,
  events,
  gatewayUsage,
  messages,
  principals,
  vaultNetworks,
} from '../db/schema/index';
import { ensureChatWithAgent } from '../domain/the-agent';
import { checkConnectionHealth } from '../home/health';
import { providerLogins } from '../managed/providers/service';
import { loadPrincipalRow, toActor } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import { IDS, TEST_TZ } from '../seed/test-world';
import { FakeFusebox } from '../test/fusebox';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { forgetKindReads } from '../things/kinds/read';
import { readPoints } from '../things/points';
import { useVaultNetForTests } from '../vault/net';
import { fuseboxClientId, provisionFusebox } from './provision';

/** A JSON body as the tests read it. */
// biome-ignore lint/suspicious/noExplicitAny: the tests read nested JSON bodies.
type Body = Record<string, any>;

// No runner here to relay provider sign-ins (the default executor): this server reads none (SUB-56).
const t = useTestServer({
  seed: true,
  app: true,
  listen: true,
  env: { WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
const fusebox = new FakeFusebox();
const HOST = 'fusebox.home.test';
const ADDRESS = '192.168.92.10';
const B = { burrow: 'burrow-hq' };
const RUNNER = 'rnr_gateway';
/** Whombat's named client in the fake Fusebox for the seeded burrow (AIG-02, AIG-D15). */
const ourClientId = () => fuseboxClientId({ id: t.burrowId, slug: B.burrow });
let url = '';
let connectionId = '';
const frames: BusFrame[] = [];

beforeAll(async () => {
  await fusebox.start();
  url = `http://${HOST}:${fusebox.port}`;
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host !== HOST)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: ADDRESS, family: 4 }];
    },
    dialAddress: (a) => (a === ADDRESS ? '127.0.0.1' : a),
    deadlineMs: 3000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_fusebox_test',
    cidr: '192.168.92.0/24',
    ports: [fusebox.port],
    note: 'Fake Fusebox',
    addedAt: t.services.clock(),
  });
  // Dusty runs on Claude Code (on Codex where a test says so).
  await setProvider('claude');
  t.services.bus.onFrame((frame) => frames.push(frame));
});

afterAll(async () => {
  await fusebox.stop();
});

/** Turns Fusebox's “Claude or ChatGPT used up” on or off for the person (What Whombat watches). */
const watchUsedUp = (watched: boolean) =>
  call(IDS.mara, 'POST', buildPath(api.things.setWatch.path, { ...B, thing: `connection:${connectionId}` }), {
    check: 'fusebox.used_up',
    watched,
  });

async function call(
  who: string,
  method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
  path: string,
  payload?: object,
) {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({
    method,
    url: `/api/v1${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as Body };
}

const connectionsPath = () => buildPath(api.connections.create.path, B);

async function connectFusebox() {
  return call(IDS.mara, 'POST', connectionsPath(), {
    catalogId: 'fusebox',
    scope: 'shared',
    signIn: 'token',
    fields: { url },
    secret: fusebox.managementKey,
  });
}

/** The tool the agent runs on. */
async function setProvider(provider: 'claude' | 'codex') {
  const agent = await loadPrincipalRow(t.services.db, IDS.dusty);
  await t.services.db
    .update(principals)
    .set({ runtime: { ...(agent?.runtime as object), provider } })
    .where(eq(principals.id, IDS.dusty));
}

async function burrowNow() {
  return (await call(IDS.mara, 'GET', buildPath(api.burrows.get.path, B))).body.burrow;
}

async function setSwitch(who: string, body: { claude?: boolean; codex?: boolean }) {
  return call(who, 'PUT', buildPath(api.burrows.setAiGateway.path, B), body);
}

async function runner(path: string, payload: object) {
  const res = await t.api.inject({
    method: 'POST',
    url: `${RUNNER_PREFIX}${path}`,
    headers: { authorization: 'Bearer dev-runner-token' },
    payload,
  });
  return { status: res.statusCode, body: res.json() as Body };
}

/** A queued turn of an agent, claimed at once; its row after the claim. */
async function claimTurn(
  agentId: string,
  provider: 'claude' | 'codex',
  conversationId: string = IDS.incidents,
  providers: readonly string[] = [provider],
) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, agentId, conversationId, {
    state: 'queued',
  });
  const res = await runner(runnerApi.claim.path, { runnerId: RUNNER, providers, waitMs: 0 });
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  // Done: the next turn of the agent in the room may start.
  await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, dispatchId));
  return { res, row, dispatchId };
}

/**
 * Runs `work` with the person's own sign-ins as the runner would list them (this server holds none of its own): each
 * `[provider, authMode]`.
 */
async function withOwnSignIns(signIns: ['claude' | 'codex', string][], work: () => Promise<void>) {
  const logins = providerLogins(t.services);
  const records = signIns.map(([provider, authMode]) => ({
    provider,
    meta: {
      v: 1 as const,
      provider,
      authMode,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      verified: 'valid' as const,
      verifiedAt: null,
      creatorAttested: false,
      login: null,
      signal: null,
    },
  }));
  const spies = [
    vi.spyOn(logins, 'readable', 'get').mockReturnValue(true),
    vi.spyOn(logins, 'personSignIns').mockResolvedValue(records),
    vi
      .spyOn(logins, 'record')
      .mockImplementation(async (p) => records.find((r) => r.provider === p)?.meta ?? null),
  ];
  try {
    await work();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Fusebox counts as not answering (true) or answering again. */
async function fuseboxAnswers(answers: boolean) {
  const set = { failures: answers ? 0 : 2, reachable: answers, failingSince: answers ? null : new Date() };
  await t.services.db
    .insert(gatewayUsage)
    .values({ connectionId, burrowId: t.burrowId, ...set })
    .onConflictDoUpdate({ target: gatewayUsage.connectionId, set });
}

/** The agent's newest message in a room. */
async function lastWords(
  agentId: string,
  conversationId: string = IDS.incidents,
): Promise<string | undefined> {
  const [m] = await t.services.db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.authorId, agentId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m?.text;
}

describe('connecting Fusebox (AIG-01, AIG-02)', () => {
  it('adds Whombat’s named client after a config change or two, keeping every other entry', async () => {
    fusebox.conflictsLeft = 2;
    const res = await connectFusebox();
    expect(res.status).toBe(201);
    connectionId = res.body.connection.id;
    expect(res.body.connection).toMatchObject({
      catalogId: 'fusebox',
      label: 'Fusebox',
      fields: { url, clientId: ourClientId() },
    });
    const ours = fusebox.namedClients.find((c) => c.id === ourClientId());
    expect(fusebox.namedClients[0]).toEqual({ id: 'laptop', label: 'Laptop', key: 'sk-laptop' });
    expect(ours).toMatchObject({ label: 'Whombat · Burrow HQ', key: expect.stringMatching(/^wbgw_/) });
    expect(fusebox.to('/api/config/settings').filter((r) => r.method === 'PATCH')).toHaveLength(3);
    // The new key was checked, and is kept sealed for this connection only.
    const status = fusebox.to('/v1/fusebox/status').at(-1);
    expect(status?.headers.authorization).toBe(`Bearer ${ours?.key}`);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(row?.clientSecretEnc).toBeTruthy();
    expect(openConnectionSecret(t.services.custody, connectionId, 'client', row?.clientSecretEnc ?? '')).toBe(
      ours?.key,
    );
    expect(JSON.stringify(row)).not.toContain(ours?.key ?? '-');
    // The burrow shows the gateway, both switches off.
    expect(await burrowNow()).toMatchObject({
      aiGateway: { connectionId, name: 'Fusebox', kind: 'fusebox', claude: false, codex: false },
    });
  });

  it('refuses a second gateway connection, naming the first', async () => {
    const res = await call(IDS.mara, 'POST', connectionsPath(), {
      catalogId: 'ai_gateway',
      scope: 'shared',
      signIn: 'token',
      fields: { url },
      secret: 'sk-shared',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      message: 'This Whombat already sends its AI through Fusebox. Remove that connection first.',
      details: { code: 'gateway_exists' },
    });
  });

  it('replaces its key in place when the management key is replaced (AIG-03)', async () => {
    // A model map the person set on Whombat's client in Fusebox (0.14+) survives the new key.
    const modelMap = { 'claude-opus-*': 'claude-sonnet-5-5' };
    fusebox.namedClients = fusebox.namedClients.map((c) =>
      c.id === ourClientId() ? { ...c, 'model-map': modelMap } : c,
    );
    const before = fusebox.namedClients.find((c) => c.id === ourClientId())?.key;
    const res = await call(
      IDS.mara,
      'PUT',
      buildPath(api.connections.setSecret.path, { ...B, connectionId }),
      { secret: fusebox.managementKey },
    );
    expect(res.status).toBe(200);
    const ours = fusebox.namedClients.filter((c) => c.id === ourClientId());
    expect(ours).toHaveLength(1);
    expect(ours[0]?.key).not.toBe(before);
    expect(ours[0]?.['model-map']).toEqual(modelMap);
    expect(fusebox.namedClients.map((c) => c.id)).toEqual(['laptop', ourClientId()]);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(openConnectionSecret(t.services.custody, connectionId, 'client', row?.clientSecretEnc ?? '')).toBe(
      ours[0]?.key,
    );
    expect(row?.fields).toEqual({ url, clientId: ourClientId() });
  });

  it('won’t move a Fusebox to another address: it is connected again', async () => {
    const res = await call(
      IDS.mara,
      'PATCH',
      buildPath(api.connections.update.path, { ...B, connectionId }),
      {
        fields: { url: `http://${HOST}:1` },
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Connect it again to use another address.');
  });
});

describe('provisioning on its own (AIG-02)', () => {
  const target = () => ({
    baseUrl: url,
    credential: { headers: { Authorization: `Bearer ${fusebox.managementKey}` }, query: {} },
  });
  const saved = { named: [] as typeof fusebox.namedClients, keys: [] as string[] };
  beforeAll(() => {
    saved.named = fusebox.namedClients;
    saved.keys = fusebox.apiKeys;
  });
  afterAll(() => {
    fusebox.namedClients = saved.named;
    fusebox.apiKeys = saved.keys;
    fusebox.tooOld = false;
    fusebox.conflictsLeft = 0;
  });

  it('gives up after three config changes in a row', async () => {
    fusebox.conflictsLeft = 3;
    await expect(
      provisionFusebox(t.services, target(), { id: 'brw_moss', slug: 'moss', name: 'Moss' }),
    ).rejects.toMatchObject({
      message: 'Fusebox’s settings kept changing while Whombat saved its key. Try again.',
    });
    fusebox.conflictsLeft = 0;
  });

  it('refuses a Fusebox too old for named clients', async () => {
    fusebox.tooOld = true;
    await expect(
      provisionFusebox(t.services, target(), { id: 'brw_moss', slug: 'moss', name: 'Moss' }),
    ).rejects.toMatchObject({
      message: 'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
      extra: { details: { code: 'gateway_too_old' } },
    });
    fusebox.tooOld = false;
  });

  it('leaves an open Fusebox open: no key added, none sent', async () => {
    fusebox.namedClients = [];
    fusebox.apiKeys = [];
    const made = await provisionFusebox(t.services, target(), { id: 'brw_moss', slug: 'moss', name: 'Moss' });
    expect(made).toEqual({ clientId: null, clientKey: null });
    expect(fusebox.namedClients).toEqual([]);
  });

  it('takes a key Fusebox won’t serve out again', async () => {
    fusebox.namedClients = [{ id: 'laptop', label: 'Laptop', key: 'sk-laptop' }];
    fusebox.refuseModels = true;
    await expect(
      provisionFusebox(t.services, target(), { id: 'brw_moss', slug: 'moss', name: 'Moss' }),
    ).rejects.toMatchObject({
      message: 'Whombat added its key to Fusebox, but Fusebox didn’t take it. Try again.',
    });
    fusebox.refuseModels = false;
    expect(fusebox.namedClients.map((c) => c.id)).toEqual(['laptop']);
  });

  it('keeps the user agents set on its entry, and puts the entry back when an older Fusebox won’t take the key', async () => {
    const naming = { id: 'brw_moss', slug: 'moss', name: 'Moss' };
    const ours = {
      id: fuseboxClientId(naming),
      label: 'Whombat · Moss',
      key: 'wbgw_old',
      'user-agents': ['claude-cli/*'],
    };
    fusebox.namedClients = [{ id: 'laptop', label: 'Laptop', key: 'sk-laptop' }, ours];
    // Fusebox 0.14+ checks the key alone, so the user agents don't refuse it.
    const made = await provisionFusebox(t.services, target(), naming);
    expect(fusebox.namedClients[1]).toMatchObject({ key: made.clientKey, 'user-agents': ['claude-cli/*'] });
    // An older Fusebox checks it on the models list, which the user agents refuse: the entry is as it was.
    fusebox.namedClients = [{ id: 'laptop', label: 'Laptop', key: 'sk-laptop' }, ours];
    fusebox.statusRoute = false;
    await expect(provisionFusebox(t.services, target(), naming)).rejects.toMatchObject({
      message: 'Whombat added its key to Fusebox, but Fusebox didn’t take it. Try again.',
    });
    fusebox.statusRoute = true;
    expect(fusebox.namedClients).toEqual([{ id: 'laptop', label: 'Laptop', key: 'sk-laptop' }, ours]);
  });
});

describe('the switches (AIG-05, AIG-06, AIG-16)', () => {
  it('are signed under Keys per switch, and say when they override the terms', async () => {
    const on = await setSwitch(IDS.mara, { claude: true });
    expect(on.status).toBe(200);
    expect(on.body.burrow.aiGateway).toMatchObject({ claude: true, codex: false, name: 'Fusebox' });
    expect(on.body.eventId).toEqual(expect.any(String));
    const [signed] = await t.services.db.select().from(events).where(eq(events.id, on.body.eventId));
    expect(signed).toMatchObject({
      type: 'burrow.ai_gateway_changed',
      kind: 'Keys',
      actorId: IDS.mara,
      text: 'Mara now sends every Claude Code turn through Fusebox (an override: Anthropic’s terms don’t allow sharing a subscription)',
      payload: { connectionId, provider: 'claude', on: true },
    });
    const again = await setSwitch(IDS.mara, { claude: true });
    expect(again.body.eventId).toBeNull();
    expect(
      frames.some(
        (f) =>
          f.topic === `burrow:${t.burrowId}` &&
          f.event.type === 'burrow.updated' &&
          (f.event as Body).burrow?.aiGateway?.claude === true,
      ),
    ).toBe(true);
  });

  it('tells the runner with every heartbeat', async () => {
    const beat = await runner(runnerApi.heartbeat.path, { runnerId: RUNNER, active: [] });
    expect(beat.body.gateway).toEqual({ claude: true, codex: false });
  });
});

describe('a turn’s route at claim (AIG-07, AIG-12)', () => {
  it('goes through the gateway with no credential, and keeps its route on the dispatch', async () => {
    const { res, row } = await claimTurn(IDS.dusty, 'claude');
    expect(res.status).toBe(200);
    expect(res.body.dispatch.gateway).toEqual({
      v: 1,
      provider: 'claude',
      connectionId,
      name: 'Fusebox',
      kind: 'fusebox',
    });
    expect(res.body.dispatch.credential).toBeUndefined();
    expect(row?.gatewayProvider).toBe('claude');
  });

  it('starts a turn tried again on another route without its last attempt’s session (AIG-10)', async () => {
    const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
      state: 'queued',
    });
    // Its first attempt ran on Dusty's own sign-in, in that CLI home.
    await t.services.db
      .update(dispatches)
      .set({ attempts: 1, providerSessionId: 'sess-own-home', gatewayProvider: null })
      .where(eq(dispatches.id, dispatchId));
    const res = await runner(runnerApi.claim.path, { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
    expect(res.body.dispatch.dispatch.id).toBe(dispatchId);
    expect(res.body.dispatch.gateway).toMatchObject({ provider: 'claude' });
    expect(res.body.dispatch.dispatch.providerSessionId).toBeNull();
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    expect(row).toMatchObject({ providerSessionId: null, gatewayProvider: 'claude' });
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, dispatchId));
  });

  it('runs a tool whose switch is off on the agent’s own sign-in', async () => {
    await setProvider('codex');
    try {
      const { res, row } = await claimTurn(IDS.dusty, 'codex');
      expect(res.body.dispatch.gateway).toBeNull();
      expect(row?.gatewayProvider).toBeNull();
    } finally {
      await setProvider('claude');
    }
  });

  it('doesn’t start when the gateway isn’t answering and the person has no sign-in of their own', async () => {
    await fuseboxAnswers(false);
    const { res, row } = await claimTurn(IDS.dusty, 'claude');
    expect(res.body.dispatch).toBeNull();
    expect(row).toMatchObject({ state: 'failed', error: 'gateway.unreachable' });
    expect(await lastWords(IDS.dusty)).toContain('Settings → AI sign-in');
  });

  it('runs on the person’s own Claude sign-in while the gateway isn’t answering, in a fresh session', async () => {
    await fuseboxAnswers(false);
    // The thread's last turn ran through Fusebox in this session: Hermes can't carry it onto the person's sign-in.
    const { dispatchId: earlier } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
      state: 'queued',
    });
    await t.services.db
      .update(dispatches)
      .set({
        state: 'done',
        finishedAt: new Date(),
        providerSessionId: 'hermes:through-fusebox',
        gatewayProvider: 'claude',
      })
      .where(eq(dispatches.id, earlier));
    await withOwnSignIns([['claude', 'subscription_cli']], async () => {
      const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
        state: 'queued',
      });
      await t.services.db
        .update(dispatches)
        .set({ providerSessionId: 'hermes:through-fusebox' })
        .where(eq(dispatches.id, dispatchId));
      const res = await runner(runnerApi.claim.path, { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
      expect(res.body.dispatch.dispatch.id).toBe(dispatchId);
      expect(res.body.dispatch.gateway).toBeNull();
      expect(res.body.dispatch.agent.runtime.provider).toBe('claude');
      expect(res.body.dispatch.credential).toMatchObject({
        provider: 'claude',
        authMode: 'subscription_cli',
      });
      expect(res.body.dispatch.dispatch.providerSessionId).toBeNull();
      const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
      expect(row).toMatchObject({ state: 'claimed', gatewayProvider: null, providerSessionId: null });
      await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, dispatchId));
    });
  });

  it('runs on the person’s ChatGPT sign-in when they have no Claude one, with ChatGPT’s own model', async () => {
    await fuseboxAnswers(false);
    await withOwnSignIns([['codex', 'chatgpt']], async () => {
      const { res, row } = await claimTurn(IDS.dusty, 'claude', IDS.incidents, ['claude', 'codex']);
      expect(res.body.dispatch.gateway).toBeNull();
      expect(res.body.dispatch.agent.runtime.provider).toBe('codex');
      expect(res.body.dispatch.agent.runtime.model).toBeUndefined();
      expect(res.body.dispatch.credential).toMatchObject({ provider: 'codex', authMode: 'chatgpt' });
      expect(row).toMatchObject({ gatewayProvider: null, runtime: { provider: 'codex' } });
    });
  });

  it('never falls back on an API key, which costs money', async () => {
    await fuseboxAnswers(false);
    await withOwnSignIns([['claude', 'api_key']], async () => {
      const { res, row } = await claimTurn(IDS.dusty, 'claude');
      expect(res.body.dispatch).toBeNull();
      expect(row).toMatchObject({ state: 'failed', error: 'gateway.unreachable' });
    });
  });

  it('goes back through the gateway once it answers again', async () => {
    await fuseboxAnswers(true);
    await withOwnSignIns([['claude', 'subscription_cli']], async () => {
      const { res } = await claimTurn(IDS.dusty, 'claude');
      expect(res.body.dispatch.gateway).toMatchObject({ provider: 'claude' });
      expect(res.body.dispatch.credential).toBeUndefined();
    });
  });

  it('doesn’t start when every Claude account is used up', async () => {
    // A week ahead of the real clock: the claim compares `until` with now, so a fixed date goes stale.
    const monday = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await t.services.db
      .update(gatewayUsage)
      .set({
        failures: 0,
        reachable: true,
        accounts: [
          {
            key: 'gwa_1',
            label: 'work@example.com',
            provider: 'claude',
            plan: 'max',
            status: 'used_up',
            until: monday,
            windows: [],
          },
          {
            key: 'gwa_2',
            label: 'off@example.com',
            provider: 'claude',
            plan: null,
            status: 'off',
            until: null,
            windows: [],
          },
        ],
      })
      .where(eq(gatewayUsage.connectionId, connectionId));
    // A used-up pool doesn't move the turn onto the person's own sign-in: their accounts are usually in it.
    let row: Awaited<ReturnType<typeof claimTurn>>['row'];
    await withOwnSignIns([['claude', 'subscription_cli']], async () => {
      ({ row } = await claimTurn(IDS.dusty, 'claude'));
    });
    expect(row).toMatchObject({ state: 'failed', error: 'gateway.used_up' });
    expect(await lastWords(IDS.dusty)).toMatch(
      /^Fusebox has no Claude Code room left until .+, so I couldn’t start\.$/,
    );
    await t.services.db
      .update(gatewayUsage)
      .set({ accounts: [] })
      .where(eq(gatewayUsage.connectionId, connectionId));
  });

  it('doesn’t start when the other Claude account is an API key out of credit (Fusebox 0.13)', async () => {
    // Ahead of the real clock, as above: the claim compares `until` with now.
    const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const retry = new Date(Date.now() + 30 * 60_000).toISOString();
    fusebox.accounts = [
      {
        id: 'claude-work.json',
        provider: 'claude',
        label: 'work',
        email: 'work@example.com',
        disabled: false,
        quota: { windows: [{ name: 'week', used: 100, resets_at: reset }], plan: 'max' },
      },
      {
        id: 'anthropic-key',
        provider: 'claude',
        label: 'anthropic-key',
        kind: 'api-key',
        disabled: false,
        cooldown_kinds: { '*': 'credit' },
        quota: {},
      },
    ];
    fusebox.faults = [
      {
        key: 'quota:claude-work.json',
        kind: 'quota',
        provider: 'claude',
        account_id: 'claude-work.json',
        until: reset,
      },
      {
        key: 'credit:anthropic-key',
        kind: 'credit',
        provider: 'claude',
        account_id: 'anthropic-key',
        until: retry,
      },
    ];
    await t.services.gateway.pollNow(connectionId);
    const [usage] = await t.services.db
      .select({ accounts: gatewayUsage.accounts })
      .from(gatewayUsage)
      .where(eq(gatewayUsage.connectionId, connectionId));
    expect(
      usage?.accounts.map((a) => [a.label, a.status, a.paused ?? false, a.outOfCredit ?? false]),
    ).toEqual([
      ['work@example.com', 'used_up', false, false],
      ['anthropic-key', 'used_up', true, true],
    ]);
    const { row } = await claimTurn(IDS.dusty, 'claude');
    expect(row).toMatchObject({ state: 'failed', error: 'gateway.used_up' });
    // The room comes back when the subscription resets, not at Fusebox's next try of the key.
    const words = await lastWords(IDS.dusty);
    expect(words).toContain(formatGatewayUntil(reset, t.services.clock(), TEST_TZ));
    expect(words).not.toContain(formatGatewayUntil(retry, t.services.clock(), TEST_TZ));
    fusebox.accounts = [];
    fusebox.faults = [];
    await t.services.gateway.pollNow(connectionId);
  });

  it('doesn’t start when the connection has no key to send', async () => {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    await t.services.db
      .update(catalogConnections)
      .set({ clientSecretEnc: null })
      .where(eq(catalogConnections.id, connectionId));
    const claimed = await claimTurn(IDS.dusty, 'claude');
    expect(claimed.row).toMatchObject({ state: 'failed', error: 'gateway.missing' });
    expect(await lastWords(IDS.dusty)).toContain('Settings → Connections');
    await t.services.db
      .update(catalogConnections)
      .set({ clientSecretEnc: row?.clientSecretEnc ?? null })
      .where(eq(catalogConnections.id, connectionId));
  });
});

describe('a turn Fusebox has no room for (AIG-D31)', () => {
  it('ends at once, says when Fusebox has room again, and carries on then', async () => {
    const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
      state: 'queued',
    });
    const res = await runner(runnerApi.claim.path, { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
    expect(res.body.dispatch.dispatch.id).toBe(dispatchId);
    // As the runner reports Fusebox's 429 (its wait from now).
    const resetsAt = new Date(Date.now() + 2949_000).toISOString();
    await t.services.runtime.finalize(dispatchId, {
      outcome: 'failed',
      error: 'HTTP 429: all accounts for claude-opus-5-5 are rate limited; next available in 2949s',
      failure: { code: 'usage_limit', resetsAt },
    });
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    // Not tried again 10 s later: that would only meet the same limit.
    expect(row).toMatchObject({ state: 'failed', attempts: 1, failure: { code: 'usage_limit', resetsAt } });
    expect(await lastWords(IDS.dusty)).toMatch(
      /^I’ve used up what Fusebox has for Claude Code until .+, so I stopped; I’ll carry on then\.$/,
    );
    const again = (await t.services.db.select().from(dispatches)).filter((d) => d.retryOfId === dispatchId);
    expect(again).toMatchObject([{ state: 'queued', requeuedFor: 'usage_limit' }]);
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled' })
      .where(eq(dispatches.retryOfId, dispatchId));
  });

  it('Claude’s third-party extra-usage refusal names Fusebox, explains billing, and waits for the person', async () => {
    const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
      state: 'queued',
    });
    const res = await runner(runnerApi.claim.path, { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
    expect(res.body.dispatch.dispatch.id).toBe(dispatchId);
    expect(res.body.dispatch.gateway.name).toBe('Fusebox');
    const error =
      'custom rejected this request as malformed. Start a clean session with /new or switch models with /model. Provider said: HTTP 400: Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.';
    await t.services.runtime.finalize(dispatchId, {
      outcome: 'failed',
      error,
      // Home's older runner reports this as internal; the server still identifies the actual reason.
      failure: { code: 'internal' },
    });
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    expect(row).toMatchObject({
      state: 'failed',
      attempts: 1,
      failure: { code: 'usage_limit', resetsAt: null },
    });
    const [message] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.failure?.messageId ?? ''));
    expect(message?.text).toContain('through Fusebox');
    expect(message?.text).toContain('third-party apps');
    expect(message?.text).toContain('separate from plan limits');
    expect(message?.text).toContain('claude.ai/settings/usage');
    expect(message?.text).toContain('Try again');
    expect(message?.text).not.toMatch(/malformed|\/new|\/model|resets|few minutes/);
    expect(message?.card).toMatchObject({
      kind: 'turn_failed',
      code: 'usage_limit',
      reason: row?.failure?.reason,
    });
    expect(row?.failure?.reason).toContain('Fusebox');
    expect(row?.failure?.detail).toContain('Third-party apps');
    const again = (await t.services.db.select().from(dispatches)).filter((d) => d.retryOfId === dispatchId);
    expect(again).toEqual([]);
  });
});

describe('the relay (AIG-08, AIG-09)', () => {
  let token = '';
  let dispatchId = '';
  const relay = (path: string, init: RequestInit = {}) => fetch(`${t.baseUrl}/ai-gateway${path}`, init);
  const messagesBody = JSON.stringify({ model: 'claude-opus-6', stream: true, messages: [] });

  beforeAll(async () => {
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, { state: 'running' });
    token = turn.token;
    dispatchId = turn.dispatchId;
    await t.services.db
      .update(dispatches)
      .set({ gatewayProvider: 'claude' })
      .where(eq(dispatches.id, dispatchId));
  });

  it('streams a turn’s answer from Fusebox with Whombat’s client key, as it comes', async () => {
    fusebox.streamGapMs = 250;
    const before = fusebox.requests.length;
    const res = await relay('/claude/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-fusebox-client-scope': 'spoofed',
      },
      body: messagesBody,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-fusebox-account')).toBeNull();
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    // The first event arrives while Fusebox is still writing the rest.
    expect(first).toContain('message_start');
    expect(first).not.toContain('message_stop');
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain('message_stop');
    fusebox.streamGapMs = 30;
    const got = fusebox.requests.slice(before).find((r) => r.path === '/v1/messages');
    const ours = fusebox.namedClients.find((c) => c.id === ourClientId());
    expect(got?.url).toBe('/v1/messages?beta=true');
    expect(got?.headers.authorization).toBe(`Bearer ${ours?.key}`);
    expect(got?.headers['x-api-key']).toBeUndefined();
    expect(got?.headers['x-fusebox-client-scope']).toBeUndefined();
    expect(got?.headers['anthropic-version']).toBe('2023-06-01');
    expect(got?.body).toBe(messagesBody);
    await waitFor(async () => {
      const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
      return row?.gatewayAccount === 'claude-work.json';
    });
  });

  it('relays a GET without a body (the models list)', async () => {
    const res = await relay('/claude/v1/models', { headers: { 'x-api-key': token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: 'list' });
    expect(fusebox.to('/v1/models').at(-1)?.headers.authorization).toMatch(/^Bearer wbgw_/);
  });

  it('answers Claude Code’s ping itself, without a key', async () => {
    const before = fusebox.requests.length;
    const res = await relay('/claude/api/hello');
    expect(res.status).toBe(200);
    // Claude Code 2.1.296 pings with HEAD (runner AIG-D30).
    const head = await relay('/claude/api/hello', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(fusebox.requests.length).toBe(before);
  });

  it('refuses a bad key, another tool, a path outside the list, and an ended turn, as the CLI reads them', async () => {
    const bad = await relay('/claude/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer wat_nope', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });

    const other = await relay('/codex/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: 'forbidden', param: null } });

    const outside = await relay('/claude/api/config/settings', { headers: { 'x-api-key': token } });
    expect(outside.status).toBe(404);

    const huge = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${t.baseUrl}/ai-gateway/claude/v1/messages`,
        {
          method: 'POST',
          headers: {
            'x-api-key': token,
            'content-type': 'application/json',
            'content-length': String(70 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('{');
    });
    expect(huge).toBe(413);

    const { token: ended, dispatchId: endedId } = await agentTokenFor(
      t.services,
      t.burrowId,
      IDS.dusty,
      IDS.pr482,
    );
    await t.services.db
      .update(dispatches)
      .set({ gatewayProvider: 'claude', state: 'done' })
      .where(eq(dispatches.id, endedId));
    const gone = await relay('/claude/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ended, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(gone.status).toBe(409);

    const { token: own } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.general);
    const notGateway = await relay('/codex/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${own}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(notGateway.status).toBe(403);
  });

  it('says it couldn’t reach the gateway in the provider’s shape (502), and counts it unreachable at once', async () => {
    fusebox.down = true;
    const res = await relay('/claude/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: messagesBody,
    });
    fusebox.down = false;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Whombat couldn’t reach Fusebox: Whombat couldn’t reach it.' },
    });
    // The turn's retry and the next turns run on the person's own sign-in without waiting for two polls.
    await waitFor(async () => {
      const [usage] = await t.services.db
        .select()
        .from(gatewayUsage)
        .where(eq(gatewayUsage.connectionId, connectionId));
      return usage?.reachable === false && usage.failures >= 2;
    });
    await fuseboxAnswers(true);
  });

  it('relays a Codex turn to the Responses API', async () => {
    await setSwitch(IDS.mara, { codex: true });
    const { token: codex, dispatchId: id } = await agentTokenFor(
      t.services,
      t.burrowId,
      IDS.dusty,
      IDS.billing,
    );
    await t.services.db.update(dispatches).set({ gatewayProvider: 'codex' }).where(eq(dispatches.id, id));
    const res = await relay('/codex/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${codex}`, 'content-type': 'application/json' },
      body: '{"stream":true}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('message_stop');
    expect(fusebox.to('/v1/responses').at(-1)?.headers.authorization).toMatch(/^Bearer wbgw_/);
  });
});

describe('the pool and the alerts (AIG-11, AIG-13, AIG-14)', () => {
  beforeAll(async () => {
    // Mara's Chat with the agent, where the alerts go.
    await t.services.pipeline.transact(t.burrowId, async (session) => {
      const burrow = await loadBurrowRow(session.tx, t.burrowId);
      const mara = await loadPrincipalRow(session.tx, IDS.mara);
      if (!burrow || !mara) throw new Error('no burrow');
      const now = t.services.clock();
      const ctx = applyContext(session, {
        burrow,
        actor: toActor(mara),
        now,
        at: now.toISOString(),
        decision: null,
        requirement: null,
        approvalId: null,
        onBehalfOf: {},
      });
      return ensureChatWithAgent(ctx, mara);
    });
  });

  it('reads the accounts and faults, shows them with their emails and tells the person once', async () => {
    // Claude or ChatGPT used up starts off (watch-defaults.md): this person turned it on.
    expect((await watchUsedUp(true)).status).toBe(200);
    const until = new Date(t.services.clock().getTime() + 3 * 3_600_000).toISOString();
    fusebox.accounts = [
      {
        id: 'claude-work.json',
        provider: 'claude',
        label: 'work',
        email: 'work@example.com',
        disabled: false,
        quota: { windows: [{ name: '5h', used: 100, resets_at: until }], plan: 'max' },
      },
      {
        id: 'codex-1',
        provider: 'codex',
        label: 'team',
        email: 'team@example.com',
        disabled: false,
        quota: {},
      },
      { id: 'gem', provider: 'gemini', label: 'g', disabled: false, quota: {} },
    ];
    fusebox.faults = [
      {
        key: 'quota:claude-work.json',
        kind: 'quota',
        provider: 'claude',
        account_id: 'claude-work.json',
        until,
      },
      { key: 'provider:claude', kind: 'provider', provider: 'claude', account_id: null, until },
    ];
    frames.length = 0;
    const polled = await t.services.gateway.pollNow(connectionId);
    expect(polled).toMatchObject({
      changed: true,
      reachable: true,
      alerts: [{ kind: 'used_up', provider: 'claude' }],
    });
    expect(
      frames.some((f) => f.topic === `burrow:${t.burrowId}` && f.event.type === 'usage.gateway_updated'),
    ).toBe(true);

    const person = await call(IDS.mara, 'GET', buildPath(api.usage.list.path, B));
    expect(person.body.gateway).toMatchObject({
      connectionId,
      name: 'Fusebox',
      kind: 'fusebox',
      claude: true,
      codex: true,
      reachable: true,
      error: null,
    });
    expect(person.body.gateway.accounts.map((a: Body) => [a.label, a.provider, a.status])).toEqual([
      ['work@example.com', 'claude', 'used_up'],
      ['team@example.com', 'codex', 'ok'],
    ]);

    await t.services.gateway.settle();
    const [hazel] = await t.services.db
      .select()
      .from(principals)
      .where(
        and(
          eq(principals.kind, 'agent'),
          sql`${principals.burrowId} = (select p.burrow_id from principals p where p.id = ${IDS.mara})`,
        ),
      );
    const alert = await t.services.db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.authorId, hazel?.id ?? '-'))
      .orderBy(asc(messages.createdAt));
    expect(alert.at(-1)?.text).toMatch(
      /^Fusebox has no Claude Code room left until .+\. Claude Code turns won’t start until then\.$/,
    );

    // Read again with nothing new: no frame, no alert.
    frames.length = 0;
    const again = await t.services.gateway.pollNow(connectionId);
    expect(again).toMatchObject({ changed: false, alerts: [] });
    expect(frames.filter((f) => f.event.type === 'usage.gateway_updated')).toHaveLength(0);

    // Dismissed in Fusebox's dashboard, one and then both, the faults still hold: nothing changed, no “room is back”.
    const [quota, provider] = fusebox.faults;
    fusebox.faults = [provider];
    fusebox.dismissedFaults = [quota];
    expect(await t.services.gateway.pollNow(connectionId)).toMatchObject({ changed: false, alerts: [] });
    fusebox.faults = [];
    fusebox.dismissedFaults = [quota, provider];
    expect(await t.services.gateway.pollNow(connectionId)).toMatchObject({ changed: false, alerts: [] });
    const still = await call(IDS.mara, 'GET', buildPath(api.usage.list.path, B));
    expect(still.body.gateway.accounts.map((a: Body) => a.status)).toEqual(['used_up', 'ok']);

    // Shown again between the two reads: the list's second read has them.
    fusebox.onRequest = (path) => {
      if (path !== '/api/faults/dismissed') return;
      fusebox.faults = [quota, provider];
      fusebox.dismissedFaults = [];
    };
    expect(await t.services.gateway.pollNow(connectionId)).toMatchObject({ changed: false, alerts: [] });
    fusebox.onRequest = null;

    // The dismissed list unreadable: the faults stay as last read, and the gateway says why.
    fusebox.faults = [];
    fusebox.dismissedFaults = { not: 'a list' };
    expect((await t.services.gateway.pollNow(connectionId)).alerts).toEqual([]);
    const unread = await call(IDS.mara, 'GET', buildPath(api.usage.list.path, B));
    expect(unread.body.gateway.accounts.map((a: Body) => a.status)).toEqual(['used_up', 'ok']);
    expect(unread.body.gateway.error).toMatch(/faults/);

    // The room is back (and this Fusebox is an older one again, without the dismissed list).
    fusebox.dismissedFaults = null;
    const back = await t.services.gateway.pollNow(connectionId);
    expect(back.alerts).toEqual([{ kind: 'back', provider: 'claude' }]);
    await t.services.gateway.settle();
  });

  it('counts two failed polls in a row as unreachable', async () => {
    fusebox.down = true;
    const one = await t.services.gateway.pollNow(connectionId);
    expect(one.reachable).toBe(true);
    const two = await t.services.gateway.pollNow(connectionId);
    expect(two.reachable).toBe(false);
    const view = await call(IDS.mara, 'GET', buildPath(api.usage.list.path, B));
    expect(view.body.gateway).toMatchObject({ reachable: false, error: 'Whombat couldn’t reach it.' });
    fusebox.down = false;
    expect((await t.services.gateway.pollNow(connectionId)).reachable).toBe(true);
  });
});

describe('its page and card (fusebox-page.md FP-01…FP-12)', () => {
  it('is one of the Services, checked like the others, with its own figures, tables and points', async () => {
    const hours = (h: number) => new Date(t.services.clock().getTime() + h * 3_600_000).toISOString();
    const week = (used: number, resetH: number) => ({ name: 'week', used, resets_at: hours(resetH) });
    const five = (used: number, resetH: number) => ({ name: '5h', used, resets_at: hours(resetH) });
    fusebox.accounts = [
      {
        id: 'claude-a.json',
        provider: 'claude',
        label: 'a',
        email: 'a@example.com',
        disabled: false,
        last_used: hours(-0.1),
        quota: { plan: 'max_20x', windows: [five(30, 2), week(70, 40)] },
        quota_attribution: {
          current: [
            {
              name: 'week',
              outside: 5,
              clients: [
                { id: 'laptop', label: 'Laptop', points: 40 },
                { id: ourClientId(), label: 'Whombat', points: 20 },
              ],
            },
          ],
        },
      },
      {
        id: 'claude-b.json',
        provider: 'claude',
        label: 'b',
        email: 'b@example.com',
        disabled: false,
        quota: { plan: 'max_20x', windows: [five(10, 3), week(60, 50)] },
      },
      {
        id: 'codex-1',
        provider: 'codex',
        label: 'team',
        email: 'team@example.com',
        disabled: false,
        quota: { plan: 'pro', windows: [week(20, 120)] },
      },
    ];
    fusebox.faults = [];
    fusebox.clientsUsage = {
      clients: {},
      last_used: { [ourClientId()]: hours(-0.05) },
      connected: [{ key: 'laptop', label: 'Laptop' }],
    };
    fusebox.usageStatus = { database: { bytes: 412e6, growth_bytes_per_day: 6e6 } };
    fusebox.usageDashboard = {
      facets: { clients: [{ id: 'laptop', label: 'Laptop' }] },
      combined: {
        totals: { estimated_cost_nanos: 1906e9 },
        trends: {
          provider: [
            { date: '2026-10-01', group: 'anthropic', estimated_cost_nanos: 100e9 },
            { date: '2026-10-02', group: 'openai', estimated_cost_nanos: 20e9 },
          ],
        },
        breakdowns: {
          client: [
            { id: 'laptop', observations: 900, estimated_cost_nanos: 980e9 },
            { id: ourClientId(), observations: 400, estimated_cost_nanos: 412e9 },
          ],
        },
      },
    };
    await t.services.gateway.pollNow(connectionId);
    forgetKindReads(t.services);

    // The health pass checks it like any connection and keeps its card and points (FP-01…FP-03).
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    if (!row) throw new Error('no connection');
    const glance = await checkConnectionHealth(t.services, row);
    expect(glance?.facts.map((f) => f.label)).toEqual(['Claude week', 'ChatGPT week', 'Subscriptions']);
    const points = await readPoints(
      t.services.db,
      connectionId,
      ['claude_week', 'req_ok', 'rtt_ms'],
      t.services.clock(),
    );
    expect(points.get('claude_week')?.at(-1)?.value).toBe(65);
    expect(points.get('req_ok')?.at(-1)?.value).toBe(117);
    expect(points.get('rtt_ms')?.at(-1)?.value).not.toBeNull();

    // Home lists it among the services, with its card (sidebar, Connections → Services).
    const home = await call(IDS.mara, 'GET', buildPath(api.home.overview.path, B));
    const thing = home.body.things.find((x: Body) => x.id === `connection:${connectionId}`);
    expect(thing).toMatchObject({ kind: 'connection', catalogId: 'fusebox' });
    expect(thing.facts.map((f: Body) => f.label)).toEqual(['Claude week', 'ChatGPT week', 'Subscriptions']);

    // Its page in slots: the limits now, what goes through it, the tables below, who used it and what Whombat sends,
    // its own lines in a card; no row of figures, no access line, no keys (FP-09…FP-12).
    const pagePath = buildPath(api.things.page.path, { ...B, thing: `connection:${connectionId}` });
    const page = await call(IDS.mara, 'GET', `${pagePath}?range=7d`);
    expect(page.status).toBe(200);
    const summary = page.body.tabs[0].panels as Body[];
    expect(summary.some((p) => p.kind === 'kpis')).toBe(false);
    expect(summary.find((p) => p.id === 'limits')?.items.map((i: Body) => i.id)).toEqual([
      'claude-week',
      'claude-5h',
      'codex-week',
    ]);
    expect(summary.map((p) => p.id)).toEqual(
      // Worth a look is there only while it has a line.
      expect.arrayContaining([
        'limits',
        'gateway',
        'people',
        'subscriptions',
        'who-claude',
        'whombat',
        'machine',
      ]),
    );
    expect(summary.find((p) => p.id === 'machine')?.title).toBe('Fusebox itself');
    expect(summary.some((p) => p.kind === 'access')).toBe(false);
    expect(page.body.open.label).toBe('Open Fusebox');
    expect(JSON.stringify(page.body)).not.toContain('sk-shared');
    expect(JSON.stringify(page.body)).not.toContain('/etc/fusebox');

    // A sign-in dismissed in Fusebox's dashboard is still on the page; with the dismissed list unreadable, the poller's
    // last faults stand in for it.
    const signinLines = async () => {
      forgetKindReads(t.services);
      const p = await call(IDS.mara, 'GET', `${pagePath}?range=7d`);
      const notices = (p.body.tabs[0].panels as Body[]).find((x) => x.id === 'notices');
      return ((notices?.items ?? []) as Body[]).filter((i) => String(i.id).startsWith('signin-')).length;
    };
    expect(await signinLines()).toBe(0);
    fusebox.dismissedFaults = [
      { key: 'signin:claude-a.json', kind: 'signin', provider: 'claude', account_id: 'claude-a.json' },
    ];
    expect(await signinLines()).toBe(1);
    await t.services.gateway.pollNow(connectionId);
    fusebox.dismissedFaults = { not: 'a list' };
    expect(await signinLines()).toBe(1);
    fusebox.dismissedFaults = null;
    await t.services.gateway.pollNow(connectionId);
    expect(await signinLines()).toBe(0);

    // Every Claude subscription used up: a limit that resets by itself, calm until someone turns the check on
    // (watch-defaults.md); then bad, and Watch says why rather than “isn’t answering” (FP-05).
    const until = hours(20);
    fusebox.faults = ['claude-a.json', 'claude-b.json'].map((id) => ({
      key: `quota:${id}`,
      kind: 'quota',
      provider: 'claude',
      account_id: id,
      until,
    }));
    await watchUsedUp(false);
    await t.services.gateway.pollNow(connectionId);
    expect(await checkConnectionHealth(t.services, { ...row, glance })).toMatchObject({ status: 'ok' });
    await watchUsedUp(true);
    const used = await checkConnectionHealth(t.services, { ...row, glance });
    expect(used).toMatchObject({ status: 'bad' });
    expect(used?.reason).toContain('Claude');
    const watch = await call(IDS.mara, 'GET', buildPath(api.watch.list.path, B));
    const item = watch.body.items.find((i: Body) => i.id === `connection:${connectionId}`);
    expect(item.title).toContain('Claude');
    expect(item.title).not.toContain('answering');
    fusebox.faults = [];
    await t.services.gateway.pollNow(connectionId);
  });
});

describe('removing it (AIG-03)', () => {
  it('takes Whombat’s client out of Fusebox and clears the switches', async () => {
    const res = await call(
      IDS.mara,
      'DELETE',
      buildPath(api.connections.disconnect.path, { ...B, connectionId }),
    );
    expect(res.status).toBe(200);
    expect(res.body.notice ?? null).toBeNull();
    expect(fusebox.namedClients.map((c) => c.id)).toEqual(['laptop']);
    const [row] = await t.services.db.select().from(burrows).where(eq(burrows.id, t.burrowId));
    expect(row?.aiGateway).toBeNull();
    expect((await burrowNow()).aiGateway).toBeNull();
    const beat = await runner(runnerApi.heartbeat.path, { runnerId: RUNNER, active: [] });
    // Both off: absent, as from an older server.
    expect(beat.body.gateway).toBeUndefined();
  });

  it('says to remove it by hand when Fusebox doesn’t answer', async () => {
    const connected = await connectFusebox();
    expect(connected.status).toBe(201);
    expect((await burrowNow()).aiGateway).toMatchObject({ claude: false, codex: false });
    fusebox.down = true;
    const res = await call(
      IDS.mara,
      'DELETE',
      buildPath(api.connections.disconnect.path, { ...B, connectionId: connected.body.connection.id }),
    );
    fusebox.down = false;
    expect(res.status).toBe(200);
    expect(res.body.notice).toBe(
      'Fusebox didn’t answer, so remove the client “Whombat · Burrow HQ” there yourself.',
    );
    expect((await burrowNow()).aiGateway).toBeNull();
  });
});

describe('another AI gateway (AIG-04)', () => {
  it('connects with its own key and relays with it', async () => {
    const res = await call(IDS.mara, 'POST', connectionsPath(), {
      catalogId: 'ai_gateway',
      scope: 'shared',
      signIn: 'token',
      label: 'LiteLLM',
      fields: { url },
      secret: 'sk-shared',
    });
    expect(res.status).toBe(201);
    const id = res.body.connection.id;
    expect(res.body.connection.fields).toEqual({ url });
    const on = await setSwitch(IDS.mara, { claude: true });
    const [signed] = await t.services.db.select().from(events).where(eq(events.id, on.body.eventId));
    expect(signed?.text).toBe('Mara now sends every Claude Code turn through LiteLLM');
    const { res: claimed } = await claimTurn(IDS.dusty, 'claude');
    expect(claimed.body.dispatch.gateway).toEqual({
      v: 1,
      provider: 'claude',
      connectionId: id,
      name: 'LiteLLM',
      kind: 'ai_gateway',
    });
    const { token, dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.dmDusty);
    await t.services.db
      .update(dispatches)
      .set({ gatewayProvider: 'claude' })
      .where(eq(dispatches.id, dispatchId));
    const relayed = await fetch(`${t.baseUrl}/ai-gateway/claude/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(relayed.status).toBe(200);
    await relayed.text();
    expect(fusebox.to('/v1/messages').at(-1)?.headers.authorization).toBe('Bearer sk-shared');
    const pool = await t.services.gateway.pollNow(id);
    expect(pool.reachable).toBe(true);
    const view = await call(IDS.mara, 'GET', buildPath(api.usage.list.path, B));
    expect(view.body.gateway).toMatchObject({ kind: 'ai_gateway', name: 'LiteLLM', accounts: [] });
    const off = await setSwitch(IDS.mara, { claude: false });
    const [stopped] = await t.services.db.select().from(events).where(eq(events.id, off.body.eventId));
    expect(stopped?.text).toBe('Mara stopped sending Claude Code turns through LiteLLM');
  });
});
