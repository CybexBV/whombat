import { describe, expect, it } from 'vitest';
import {
  api,
  CONNECTION_ERROR_MESSAGES,
  CONNECTION_ERROR_STATUS,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  runnerApi,
  UsageListOutput,
} from '../contracts/index.js';
import { DispatchContext, GatewayDispatchContext } from '../contracts/runner.js';
import { EVENT_TYPES } from './audit.js';
import { Burrow } from './burrow.js';
import {
  CATALOG,
  CATALOG_USES,
  type CatalogEntry,
  CONNECTION_LABEL_MAX,
  catalogEntry,
  catalogSignIn,
  defaultConnectionLabel,
  fieldsFor,
  gatewayKindOf,
  handleFor,
  hasRequestTool,
  isAgentConnection,
  isGatewayConnection,
  probeMatches,
  resolveBaseUrl,
  resolveTokenUrl,
} from './connections-catalog.js';
import {
  AI_GATEWAY_RELAY_PATHS,
  aiGatewayFor,
  aiGatewayOn,
  aiGatewayProviders,
  aiGatewayRelayPath,
  aiGatewayRelayRoute,
  BurrowAiGateway,
  GATEWAY_ACCOUNTS_MAX,
  GATEWAY_REFUSAL_CODES,
  GatewayAccountUsage,
  GatewayName,
  GatewayPool,
  gatewayClientId,
  gatewayClientLabel,
  sortGatewayAccounts,
} from './gateway.js';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
};

const T = '2026-10-10T14:00:00.000Z';

const burrow = {
  id: 'bur_lumio',
  name: 'Lumio BV',
  slug: 'lumio',
  timeZone: 'Europe/Amsterdam',
  createdAt: '2026-01-05T09:00:00.000Z',
};

const gateway = {
  connectionId: 'con_fusebox',
  name: 'Fusebox',
  kind: 'fusebox' as const,
  claude: true,
  codex: false,
};

const account = (over: Partial<GatewayAccountUsage> = {}): GatewayAccountUsage => ({
  key: 'acc_3f9a',
  label: 'work@example.com',
  provider: 'claude',
  plan: 'max',
  status: 'ok',
  until: null,
  windows: [{ kind: 'five_hour', label: '5-hour', usedPct: 42, resetsAt: T, status: 'ok' }],
  ...over,
});

describe('the AI gateway connections (0.76, CT-332, AIG-01, AIG-02, AIG-04, AIG-18)', () => {
  it('adds the gateway use and two shared developer entries without tools or request', () => {
    expect(CATALOG_USES).toEqual(['agents', 'automations', 'gateway']);
    for (const id of ['fusebox', 'ai_gateway']) {
      expect(entry(id), id).toMatchObject({
        category: 'developer',
        use: 'gateway',
        transport: 'rest',
        baseUrl: '{url}',
        tools: [],
        request: null,
        sensitive: [],
      });
      expect(
        entry(id).signIn.map((m) => m.kind),
        id,
      ).toEqual(['token']);
      expect(
        fieldsFor(entry(id), 'token').map((f) => f.id),
        id,
      ).toEqual(['url', 'fingerprint']);
      expect(entry(id).description.length, id).toBeLessThanOrEqual(140);
      expect(entry(id).guide, id).toContain('The agent doesn’t use this connection.');
    }
    expect(CATALOG.filter((e) => e.use === 'gateway').map((e) => e.id)).toEqual(['fusebox', 'ai_gateway']);
  });

  it('names ChatGPT, not Codex, in everything people and agents read about them (CT-1452)', () => {
    for (const id of ['fusebox', 'ai_gateway'] as const) {
      const e = entry(id);
      const token = catalogSignIn(e, 'token');
      const words = [
        e.description,
        e.tagline ?? '',
        e.guide,
        token?.kind === 'token' ? token.secretHelp : '',
        ...e.fields.map((f) => f.help),
      ];
      expect(`${e.description} ${e.guide}`, id).toContain('ChatGPT');
      for (const text of words) expect(text, id).not.toMatch(/codex/i);
    }
    // A ChatGPT turn calls the gateway as an OpenAI-compatible Responses API under /v1.
    expect(entry('ai_gateway').fields[0]?.help).toContain('/v1');
  });

  it('connects Fusebox with its address and management key, checked by listing its accounts', () => {
    const e = entry('fusebox');
    expect(e.name).toBe('Fusebox');
    expect(e.description).toContain('Claude Code and ChatGPT');
    const token = catalogSignIn(e, 'token');
    if (token?.kind !== 'token') throw new Error('token');
    expect(token.label).toBe('Management key');
    expect(token.secretLabel).toBe('Management key');
    expect(token.auth).toEqual({ type: 'bearer' });
    expect(token.secretHelp).toBe(
      'Whombat uses it to add its own client key to Fusebox and to read the accounts’ limits. It’s the key you open Fusebox’s dashboard with.',
    );
    expect(e.fields[0]?.placeholder).toBe('https://fusebox.example.com:8317');
    expect(e.check).toEqual({
      kind: 'request',
      method: 'GET',
      path: '/api/accounts',
      headers: {},
      okStatus: [200],
    });
    expect(e.docsUrl).toBe('https://github.com/DigitalPals/Fusebox');
    expect(resolveTokenUrl(e, { url: 'https://10.100.0.235:8317/' })).toBe('https://10.100.0.235:8317');
    expect(resolveBaseUrl(e, { url: 'https://10.100.0.235:8317/' })).toBe('https://10.100.0.235:8317');
    expect(e.handle).toBe('fusebox');
    expect(handleFor('fusebox', ['fusebox'])).toBe('fusebox-2');
  });

  it('finds Fusebox on port 8317 by its page title (AIG-18)', () => {
    const discovery = entry('fusebox').discovery;
    expect(discovery?.targets).toEqual([
      { port: 8317, scheme: 'https' },
      { port: 8317, scheme: 'http' },
    ]);
    const probe = discovery?.probes[0];
    if (!probe) throw new Error('probe');
    expect(probe).toMatchObject({ method: 'GET', path: '/' });
    const page = (body: string) => ({ status: 200, headers: {}, body });
    expect(probeMatches(probe, page('<html><head><title>Fusebox</title></head></html>'))).toBe(true);
    expect(probeMatches(probe, page('<title>Grafana</title>'))).toBe(false);
  });

  it('connects another gateway with its address and a key, checked by listing its models (AIG-04)', () => {
    const e = entry('ai_gateway');
    expect(e.name).toBe('AI gateway');
    expect(e.description).toContain('Claude Code and ChatGPT');
    const token = catalogSignIn(e, 'token');
    if (token?.kind !== 'token') throw new Error('token');
    expect(token.label).toBe('Key');
    expect(token.secretLabel).toBe('Key');
    expect(token.auth).toEqual({ type: 'bearer' });
    expect(e.check).toMatchObject({ kind: 'request', method: 'GET', path: '/v1/models', okStatus: [200] });
    expect(e.handle).toBe('gateway');
    expect(e.discovery).toBeNull();
    expect(e.tokenUrl).toBeNull();
  });

  it('is never an agent’s connection and tells itself apart', () => {
    for (const id of ['fusebox', 'ai_gateway']) {
      expect(isAgentConnection(id), id).toBe(false);
      expect(isGatewayConnection(id), id).toBe(true);
      expect(isGatewayConnection(entry(id)), id).toBe(true);
      expect(hasRequestTool(entry(id), 'token'), id).toBe(false);
    }
    expect(gatewayKindOf('fusebox')).toBe('fusebox');
    expect(gatewayKindOf(entry('ai_gateway'))).toBe('ai_gateway');
    for (const id of ['tracker', 'custom_api', 'homeassistant', 'newer_service']) {
      expect(isGatewayConnection(id), id).toBe(false);
      expect(gatewayKindOf(id), id).toBeNull();
    }
  });

  it('is named after the entry, without the host, since its name goes into sentences', () => {
    expect(defaultConnectionLabel(entry('fusebox'), { url: 'https://10.100.0.235:8317' })).toBe('Fusebox');
    expect(defaultConnectionLabel(entry('ai_gateway'), { url: 'https://llm.example.com' })).toBe(
      'AI gateway',
    );
    expect(defaultConnectionLabel(entry('tracker'), { url: 'https://dev.tracker.example' })).toBe(
      'Report tracker · dev.tracker.example',
    );
    expect(GatewayName.safeParse('x'.repeat(CONNECTION_LABEL_MAX)).success).toBe(true);
    expect(GatewayName.safeParse('x'.repeat(CONNECTION_LABEL_MAX + 1)).success).toBe(false);
  });

  it('refuses a second gateway and a Fusebox too old for a client key', () => {
    expect(CONNECTION_ERROR_STATUS.gateway_exists).toBe('conflict');
    expect(CONNECTION_ERROR_STATUS.gateway_too_old).toBe('conflict');
    expect(CONNECTION_ERROR_MESSAGES.gateway_too_old).toBe(
      'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
    );
    const removed = api.connections.disconnect.response;
    expect(removed.parse({ ok: true, eventId: null })).toEqual({ ok: true, eventId: null });
    const notice = 'Fusebox didn’t answer, so remove the client “Whombat · Lumio BV” there yourself.';
    expect(removed.parse({ ok: true, eventId: null, notice }).notice).toBe(notice);
  });

  it('names Whombat’s client in Fusebox after the burrow (AIG-02)', () => {
    expect(gatewayClientId('lumio')).toBe('whombat-lumio');
    expect(gatewayClientId('a'.repeat(63))).toBe(`whombat-${'a'.repeat(32)}`);
    expect(gatewayClientId(`${'a'.repeat(31)}-b`)).toBe(`whombat-${'a'.repeat(31)}`);
    expect(gatewayClientId('Burrow HQ')).toBe('whombat-burrow-hq');
    expect(gatewayClientLabel('Lumio BV')).toBe('Whombat · Lumio BV');
  });
});

describe('the burrow’s switches (AIG-05, AIG-16, AIG-17)', () => {
  it('rides on the burrow, null without a gateway and absent from older runtimes', () => {
    expect(Burrow.parse(burrow).aiGateway).toBeUndefined();
    expect(Burrow.parse({ ...burrow, aiGateway: null }).aiGateway).toBeNull();
    expect(Burrow.parse({ ...burrow, aiGateway: gateway }).aiGateway).toEqual(gateway);
    expect(BurrowAiGateway.safeParse({ ...gateway, kind: 'litellm' }).success).toBe(false);
  });

  it('routes a provider only while its switch is on', () => {
    const b = { aiGateway: gateway };
    expect(aiGatewayFor(b, 'claude')).toEqual(gateway);
    expect(aiGatewayFor(b, 'codex')).toBeNull();
    expect(aiGatewayFor(b, 'local')).toBeNull();
    expect(aiGatewayFor({ aiGateway: { ...gateway, codex: true } }, 'codex')?.name).toBe('Fusebox');
    expect(aiGatewayFor({ aiGateway: null }, 'claude')).toBeNull();
    expect(aiGatewayFor({}, 'claude')).toBeNull();
    expect(aiGatewayFor(null, 'claude')).toBeNull();
    expect(aiGatewayProviders({ claude: true, codex: true })).toEqual(['claude', 'codex']);
    expect(aiGatewayProviders({ claude: false, codex: true })).toEqual(['codex']);
    expect(aiGatewayProviders(null)).toEqual([]);
    expect(aiGatewayOn({ claude: false, codex: false })).toBe(false);
    expect(aiGatewayOn(gateway)).toBe(true);
  });

  it('switches with burrows.setAiGateway: one switch or both, nothing else', () => {
    const ep = api.burrows.setAiGateway;
    expect(ep.id).toBe('burrows.setAiGateway');
    expect(ep.method).toBe('PUT');
    expect(ep.path).toBe('/burrows/:burrow/ai-gateway');
    expect(ep.body.parse({ claude: true })).toEqual({ claude: true });
    expect(ep.body.parse({ claude: false, codex: true })).toEqual({ claude: false, codex: true });
    expect(ep.body.safeParse({}).success).toBe(false);
    expect(ep.body.safeParse({ claude: true, connectionId: 'con_x' }).success).toBe(false);
    expect(ep.body.safeParse({ claude: 'yes' }).success).toBe(false);
    const res = ep.response.parse({ burrow: { ...burrow, aiGateway: gateway }, eventId: null });
    expect(res.burrow.aiGateway).toEqual(gateway);
    expect(EVENT_TYPES['burrow.ai_gateway_changed']).toBe('Keys');
  });

  it('tells the runner with every heartbeat, absent from older servers', () => {
    const res = runnerApi.heartbeat.response;
    expect(res.parse({ cancel: [] }).gateway).toBeUndefined();
    expect(res.parse({ cancel: [], gateway: { claude: true, codex: false } }).gateway).toEqual({
      claude: true,
      codex: false,
    });
    expect(res.safeParse({ cancel: [], gateway: { claude: true } }).success).toBe(false);
  });

  it('gives a gateway turn its route at claim', () => {
    const ctx = { v: 1, provider: 'codex', connectionId: 'con_fusebox', name: 'Fusebox', kind: 'fusebox' };
    expect(GatewayDispatchContext.parse(ctx)).toEqual(ctx);
    expect(GatewayDispatchContext.safeParse({ ...ctx, provider: 'local' }).success).toBe(false);
    expect(GatewayDispatchContext.safeParse({ ...ctx, v: 2 }).success).toBe(false);
    const field = DispatchContext.shape.gateway;
    expect(field.safeParse(undefined).success).toBe(false);
    expect(field.parse(null)).toBeNull();
    expect(field.parse(ctx)).toEqual(ctx);
  });
});

describe('the relay’s paths (AIG-08, AIG-09)', () => {
  it('forwards only the providers’ own endpoints and answers Claude Code’s ping itself', () => {
    expect(aiGatewayRelayPath('claude')).toBe('/ai-gateway/claude');
    expect(aiGatewayRelayPath('codex')).toBe('/ai-gateway/codex');
    expect(aiGatewayRelayRoute('claude', 'v1/messages')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', '/v1/messages?beta=true')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', 'v1/messages/count_tokens')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', 'v1/responses')).toBe('refuse');
    expect(aiGatewayRelayRoute('codex', 'v1/responses/compact')).toBe('forward');
    expect(aiGatewayRelayRoute('codex', 'v1/models')).toBe('forward');
    expect(aiGatewayRelayRoute('codex', 'api/config/settings')).toBe('refuse');
    expect(aiGatewayRelayRoute('claude', '../api/accounts')).toBe('refuse');
    expect(aiGatewayRelayRoute('claude', 'api/hello')).toBe('hello');
    expect(aiGatewayRelayRoute('claude', 'v1/api/hello')).toBe('hello');
    expect(Object.keys(AI_GATEWAY_RELAY_PATHS)).toEqual(['claude', 'codex']);
  });
});

describe('the pool’s usage (AIG-11, AIG-13)', () => {
  const pool = {
    connectionId: 'con_fusebox',
    name: 'Fusebox',
    kind: 'fusebox',
    claude: true,
    codex: false,
    reachable: true,
    observedAt: T,
    error: null,
    accounts: [
      account({ key: 'acc_2', label: 'ChatGPT account 1', provider: 'codex', plan: 'plus' }),
      account({ status: 'used_up', until: '2026-10-12T07:00:00.000Z' }),
    ],
  };

  it('lists a Fusebox’s accounts with the meters of a subscription, Claude first', () => {
    const parsed = GatewayPool.parse(pool);
    expect(parsed.accounts[1]?.windows[0]?.kind).toBe('five_hour');
    expect(sortGatewayAccounts(parsed.accounts).map((a) => a.provider)).toEqual(['claude', 'codex']);
    for (const status of ['ok', 'used_up', 'rate_limited', 'signin_expired', 'off'])
      expect(GatewayAccountUsage.safeParse(account({ status: status as never })).success, status).toBe(true);
    expect(GatewayAccountUsage.safeParse(account({ provider: 'gemini' as never })).success).toBe(false);
    const many = Array.from({ length: GATEWAY_ACCOUNTS_MAX + 1 }, () => account());
    expect(GatewayPool.safeParse({ ...pool, accounts: many }).success).toBe(false);
    const windows = Array.from({ length: 9 }, () => account().windows[0]);
    expect(GatewayAccountUsage.safeParse(account({ windows: windows as never })).success).toBe(false);
  });

  it('carries the plan’s name and a confirmed missing 5-hour limit, both absent from older runtimes', () => {
    const ultra = account({
      plan: 'max_20x',
      planName: 'Ultra',
      noFiveHourLimit: true,
      paused: true,
      windows: [],
    });
    expect(GatewayAccountUsage.parse(ultra)).toMatchObject({
      planName: 'Ultra',
      noFiveHourLimit: true,
      paused: true,
    });
    expect(GatewayAccountUsage.parse(account({ status: 'used_up', outOfCredit: true })).outOfCredit).toBe(
      true,
    );
    const older = GatewayAccountUsage.parse(account());
    expect(older.planName).toBeUndefined();
    expect(older.noFiveHourLimit).toBeUndefined();
    expect(older.paused).toBeUndefined();
    expect(older.outOfCredit).toBeUndefined();
    expect(GatewayAccountUsage.safeParse(account({ planName: '' })).success).toBe(false);
  });

  it('rides on usage.list for everyone, null without a gateway and absent from older runtimes', () => {
    expect(UsageListOutput.parse({ mine: [], everyone: null }).gateway).toBeUndefined();
    expect(UsageListOutput.parse({ mine: [], everyone: null, gateway: null }).gateway).toBeNull();
    expect(UsageListOutput.parse({ mine: [], everyone: null, gateway: pool }).gateway?.accounts).toHaveLength(
      2,
    );
    const generic = { ...pool, kind: 'ai_gateway', name: 'LiteLLM', accounts: [] };
    expect(UsageListOutput.parse({ mine: [], everyone: null, gateway: generic }).gateway?.kind).toBe(
      'ai_gateway',
    );
  });

  it('says it changed on the burrow topic, without the usage itself', () => {
    const event = RealtimeEvent.parse({ type: 'usage.gateway_updated', connectionId: 'con_fusebox' });
    expect(event).toEqual({ type: 'usage.gateway_updated', connectionId: 'con_fusebox' });
    expect(REALTIME_EVENT_TOPICS['usage.gateway_updated']).toEqual(['burrow']);
  });

  it('refuses turns with three codes, never falling back to anyone’s own sign-in (AIG-12)', () => {
    expect(GATEWAY_REFUSAL_CODES).toEqual(['gateway.missing', 'gateway.unreachable', 'gateway.used_up']);
  });
});
