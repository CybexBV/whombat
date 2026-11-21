/**
 * Turns through the burrow's AI gateway on the runner (Whombat docs/decisions/ai-gateway.md AIG-07, AIG-08, AIG-10,
 * AIG-12, AIG-15): no credential is resolved, the CLI runs with the gateway's home and base URL; in a managed turn its
 * model requests reach the server's relay through the turn's forwarder, its provider's endpoints aren't in its egress,
 * and its rate-limit readings and sign-in bookkeeping are left out; one the runner can't send there doesn't start.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  type ManagedSandbox,
  type SandboxSession,
  type SandboxTask,
  type TurnEvent,
  type TurnInput,
  type WhombatMcp,
} from '@whombat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import { gatewayUnusableText } from './gateway';
import { egressPolicy, GITHUB_ENDPOINTS, type ManagedPolicy } from './managed';
import { testContext } from './test-context';
import { runDispatch, type TurnDeps } from './turn';

class Api implements RunnerApi {
  completed: Record<string, unknown>[] = [];
  beats: Record<string, unknown>[] = [];
  async claim() {
    return null;
  }
  async progress(_id: string, body: Record<string, unknown>) {
    this.beats.push(body);
    return { cancel: false, reason: null };
  }
  async complete(_id: string, body: Record<string, unknown>) {
    this.completed.push(body);
  }
  async heartbeat() {
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

const mcp: WhombatMcp = { call: async () => ({ ok: true, isError: false, body: {} }), close: async () => {} };

function fakeProvider(
  kind: 'claude' | 'codex',
  run: (input: TurnInput, signal: AbortSignal) => AsyncGenerator<TurnEvent>,
): AgentProvider {
  return {
    kind,
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => BASIC_CAPABILITIES,
    runTurn: run,
  };
}

/** A sandbox that records what it was asked for (the real one is tested in agent-runtime). */
function stubSandbox() {
  const tasks: SandboxTask[] = [];
  const sandbox = {
    node: process.execPath,
    config: { deniedPaths: [], bwrap: '/usr/bin/bwrap' },
    async open(task: SandboxTask): Promise<SandboxSession> {
      tasks.push(task);
      return {
        id: task.id,
        mcpUrl: 'http://127.0.0.1:47100/mcp',
        spawn: () => {
          throw new Error('not in this test');
        },
        kill: async () => {},
        close: async () => {},
        violations: async () => [],
        stats: async () => null,
        commandsCgroup: () => null,
        egressEvents: () => [],
        setEgress: () => {},
        cgroupPath: () => '/sys/fs/cgroup/test',
      };
    },
  } as unknown as ManagedSandbox;
  return { sandbox, tasks };
}

const FUSEBOX = { v: 1, connectionId: 'con_fusebox1', name: 'Fusebox', kind: 'fusebox' } as const;

/** The agent's dispatch the server sent through the gateway: no credential (nobody's sign-in, AIG-07). */
function gatewayCtx(
  provider: 'claude' | 'codex',
  gateway: Record<string, unknown> = { ...FUSEBOX, provider },
) {
  const ctx = testContext();
  return {
    ...ctx,
    agent: { ...ctx.agent, runtime: { ...ctx.agent.runtime, provider } },
    credential: null,
    gateway,
  } as unknown as ReturnType<typeof testContext>;
}

let root: string;
let credentials: string;
let relay: {
  url: string;
  seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[];
  close: () => Promise<void>;
};
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wb-gwturn-'));
  credentials = join(root, 'credentials');
  // The server's relay standing in.
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('event: message_stop\ndata: {}\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  relay = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  closers.push(relay.close);
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function deps(api: Api, provider: AgentProvider, managed: ManagedPolicy, extra: Partial<TurnDeps> = {}) {
  const home = join(root, 'whombat');
  const asked: unknown[] = [];
  const d: TurnDeps = {
    api,
    registry: {
      claims: () => ['claude', 'codex'],
      for: (...args: unknown[]) => {
        asked.push(args[1]);
        return provider;
      },
      report: () => [],
    },
    serverUrl: relay.url,
    workspacesRoot: join(home, 'workspaces'),
    host: {
      home: root,
      whombatHome: home,
      runnerTmp: join(root, 'tmp'),
      env: { PATH: '/usr/bin' },
    },
    log: () => {},
    progressMs: 5,
    connectMcp: async () => mcp,
    managed,
    ...extra,
  };
  return { deps: d, asked };
}

/** A model call through the forwarder's socket, as the sandbox's bridge would pass it. */
function callThrough(socket: string, path: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: 'POST',
        path,
        headers: { authorization: `Bearer ${token}`, 'x-api-key': token },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('a managed turn through the AI gateway', () => {
  it('Claude Code: the gateway’s home and bridge, nobody’s sign-in, model calls through the forwarder to the relay', async () => {
    const sb = stubSandbox();
    const api = new Api();
    let seen: TurnInput | undefined;
    let status = 0;
    let during = false;
    const { deps: d, asked } = deps(
      api,
      fakeProvider('claude', async function* (input) {
        seen = input;
        const socket = sb.tasks[0]?.gateway?.socket as string;
        during = existsSync(socket);
        status = await callThrough(socket, '/ai-gateway/claude/v1/messages?beta=true', input.mcp.token);
        // What the CLI says about its subscription's windows: the gateway's pool, nobody's (not reported).
        yield {
          type: 'rate_limits',
          usage: { provider: 'claude', plan: null, windows: [], observedAt: '2026-10-10T10:00:00.000Z' },
        } as unknown as TurnEvent;
        yield { type: 'final', text: 'ok' };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    const out = await runDispatch(gatewayCtx('claude'), d, new AbortController().signal);
    expect(out.outcome).toBe('done');
    const home = join(credentials, 'gateway', 'con_fusebox1', 'claude');
    expect(seen?.gateway).toEqual({
      name: 'Fusebox',
      baseUrl: 'http://127.0.0.1:47104/ai-gateway/claude',
      home,
    });
    // No credential was resolved (without the gateway it would have been refused “not signed in”).
    expect(seen?.credential).toBeUndefined();
    expect(seen?.host?.credentialHome).toBeUndefined();
    expect(seen?.host?.confinement?.denyRead).toContain(home);
    // The gateway's home, mounted like an organization's: only Claude's config dir writable, no key file.
    const task = sb.tasks[0];
    expect(task?.credentialHome).toBe(join(home, 'config'));
    expect(task?.readable?.some((p) => p.endsWith('api-key'))).toBe(false);
    // The provider's endpoints aren't reachable: the CLI can't fall back to Anthropic. GitHub stays.
    expect(task?.egress.allow).toEqual(expect.arrayContaining(['github.com']));
    for (const host of ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.com'])
      expect(task?.egress.allow).not.toContain(host);
    // The forwarder for the provider's lifetime, its model call at the relay with the agent token as it was sent.
    expect(during).toBe(true);
    expect(status).toBe(200);
    expect(relay.seen).toHaveLength(1);
    expect(relay.seen[0]).toMatchObject({ method: 'POST', url: '/ai-gateway/claude/v1/messages?beta=true' });
    expect(relay.seen[0]?.headers.authorization).toBe(`Bearer ${seen?.mcp.token}`);
    expect(existsSync(task?.gateway?.socket as string)).toBe(false);
    // No rate-limit readings, no sign-in bookkeeping.
    expect([...api.beats, ...api.completed].some((b) => 'rateLimits' in b)).toBe(false);
    expect(existsSync(join(home, 'whombat-credential.json'))).toBe(false);
    expect(asked).toEqual([{ gateway: true }]);
  });

  it('never asks for fast replies; one that wanted them says they weren’t available (chat-runtime-runner.md CR-R08)', async () => {
    const sb = stubSandbox();
    const api = new Api();
    let seen: TurnInput | undefined;
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* (input) {
        seen = input;
        yield { type: 'final', text: 'ok' };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    d.registry = {
      ...d.registry,
      models: () => [
        { id: 'opus', label: 'Opus', description: null, efforts: ['medium'], isDefault: true, fast: 'off' },
      ],
    };
    const ctx = gatewayCtx('claude');
    ctx.agent.runtime = { ...ctx.agent.runtime, fast: true };
    expect((await runDispatch(ctx, d, new AbortController().signal)).outcome).toBe('done');
    expect(seen?.gateway?.name).toBe('Fusebox');
    expect(seen?.fast).toBeNull();
    // Hermes's own loop names the model: the CLI's default from the runner's list (HE-S48).
    expect(seen?.model).toBe('opus');
    expect(api.completed.at(-1)).toMatchObject({
      ran: { model: 'opus', effort: 'medium', fast: false, fastSkipped: 'unavailable' },
    });
  });

  it('a model the gateway refuses runs again on the list’s default, named (ME-05, HE-S48)', async () => {
    const sb = stubSandbox();
    const api = new Api();
    const seen: (string | undefined)[] = [];
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* (input) {
        seen.push(input.model);
        if (seen.length === 1)
          yield {
            type: 'error',
            message: 'There’s an issue with the selected model (fable). It may not exist (HTTP 404)',
            retryable: false,
            code: 'model_not_found',
          };
        else yield { type: 'final', text: 'ok' };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    const efforts = ['medium'] as const;
    d.registry = {
      ...d.registry,
      models: () => [
        { id: 'opus', label: 'Opus', description: null, efforts: [...efforts], isDefault: true },
        { id: 'fable', label: 'Fable', description: null, efforts: [...efforts], isDefault: false },
      ],
    };
    const ctx = gatewayCtx('claude');
    ctx.agent.runtime = { ...ctx.agent.runtime, model: 'fable' };
    expect((await runDispatch(ctx, d, new AbortController().signal)).outcome).toBe('done');
    expect(seen).toEqual(['fable', 'opus']);
    expect(api.completed.at(-1)).toMatchObject({ outcome: 'done', modelFallback: { model: 'fable' } });
    // The list's default refused too: nothing else to run on, an ordinary failure.
    seen.length = 0;
    ctx.agent.runtime = { ...ctx.agent.runtime, model: 'opus' };
    d.registry = {
      ...d.registry,
      models: () => [
        { id: 'opus', label: 'Opus', description: null, efforts: [...efforts], isDefault: true },
      ],
    };
    const refusedDefault = fakeProvider('claude', async function* (input) {
      seen.push(input.model);
      yield {
        type: 'error',
        message: 'There’s an issue with the selected model (opus). It may not exist (HTTP 404)',
        retryable: false,
        code: 'model_not_found',
      };
    });
    d.registry = { ...d.registry, for: () => refusedDefault };
    expect((await runDispatch(ctx, d, new AbortController().signal)).outcome).toBe('failed');
    expect(seen).toEqual(['opus']);
  });

  it('ChatGPT: the Responses base at the bridge, nothing of a home in the task, no OpenAI endpoint', async () => {
    const sb = stubSandbox();
    let seen: TurnInput | undefined;
    const { deps: d } = deps(
      new Api(),
      fakeProvider('codex', async function* (input) {
        seen = input;
        yield { type: 'final', text: 'ok' };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    const out = await runDispatch(gatewayCtx('codex'), d, new AbortController().signal);
    expect(out.outcome).toBe('done');
    const home = join(credentials, 'gateway', 'con_fusebox1', 'codex');
    expect(seen?.gateway).toEqual({
      name: 'Fusebox',
      baseUrl: 'http://127.0.0.1:47104/ai-gateway/codex/v1',
      home,
    });
    // Hermes's own loop calls the relay itself (HE-S48): no Codex home to mount, no Codex config in it (HN-04).
    expect(sb.tasks[0]?.credentialHome).toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
    for (const host of ['api.openai.com', '*.openai.com', 'chatgpt.com'])
      expect(sb.tasks[0]?.egress.allow).not.toContain(host);
  });

  it.each([
    [
      'a 401 (the gateway refused its key)',
      'API Error: 401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ],
    ['a used-up pool', 'API Error: 429 usage limit reached'],
  ])('%s ends the turn as a provider error, not as the agent’s own sign-in', async (_name, message) => {
    const sb = stubSandbox();
    const api = new Api();
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* () {
        yield { type: 'error', message, retryable: false };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    const out = await runDispatch(gatewayCtx('claude'), d, new AbortController().signal);
    expect(out.outcome).toBe('failed');
    expect(out.refusal).toBeUndefined();
    const last = api.completed.at(-1);
    expect(last?.error).toBe(message);
    expect(String(last?.error)).not.toMatch(/^managed:/);
    expect(last?.refusal).toBeUndefined();
  });

  it('Fusebox with no room for the model: a usage limit with the time it said (AIG-D31)', async () => {
    const api = new Api();
    const message =
      'Provider said: HTTP 429: all accounts for claude-opus-5-5 are rate limited; next available in 2949s';
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* () {
        yield { type: 'error', message, retryable: false };
      }),
      { credentialsRoot: credentials, sandbox: stubSandbox().sandbox, generation: 3 },
    );
    const before = Date.now();
    await runDispatch(gatewayCtx('claude'), d, new AbortController().signal);
    const last = api.completed.at(-1);
    expect(last).toMatchObject({ outcome: 'failed', failure: { code: 'usage_limit' } });
    expect(last?.refusal).toBeUndefined();
    const resetsAt = Date.parse(String((last?.failure as { resetsAt?: string } | undefined)?.resetsAt));
    expect(resetsAt).toBeGreaterThanOrEqual(before + 2949_000);
    expect(resetsAt).toBeLessThanOrEqual(Date.now() + 2949_000);
  });

  it('Claude’s extra-usage rejection through Fusebox keeps the upstream detail and reports no reset', async () => {
    const api = new Api();
    const message =
      'custom rejected this request as malformed. Provider said: HTTP 400: Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.';
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* () {
        yield { type: 'error', message, retryable: false };
      }),
      { credentialsRoot: credentials, sandbox: stubSandbox().sandbox, generation: 3 },
    );
    await runDispatch(gatewayCtx('claude'), d, new AbortController().signal);
    expect(api.completed.at(-1)).toMatchObject({
      outcome: 'failed',
      error: message,
      failure: { code: 'usage_limit', resetsAt: null },
    });
    expect(api.completed.at(-1)?.refusal).toBeUndefined();
  });

  it('a gateway this runner can’t send the turn to: refused before anything starts, never run on a sign-in', async () => {
    const sb = stubSandbox();
    const api = new Api();
    let ran = false;
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* () {
        ran = true;
        yield { type: 'final', text: 'ok' };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    // The server named Codex's gateway for a Claude Code agent.
    const out = await runDispatch(
      gatewayCtx('claude', { ...FUSEBOX, provider: 'codex' }),
      d,
      new AbortController().signal,
    );
    expect(ran).toBe(false);
    expect(sb.tasks).toEqual([]);
    expect(out.refusal).toBe(gatewayUnusableText('Fusebox'));
    expect(api.completed.at(-1)).toMatchObject({
      outcome: 'failed',
      error: 'host_not_ready',
      refusal: gatewayUnusableText('Fusebox'),
      failure: { code: 'provider' },
    });
  });

  it('a forwarder that can’t start refuses the turn and says so', async () => {
    const sb = stubSandbox();
    const api = new Api();
    let ran = false;
    const { deps: d } = deps(
      api,
      fakeProvider('claude', async function* () {
        ran = true;
        yield { type: 'final', text: 'ok' };
      }),
      { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
    );
    // Where the forwarder's folder would go is a file: nothing can listen there.
    mkdirSync(join(root, 'tmp'), { mode: 0o700 });
    writeFileSync(join(root, 'tmp', 'aig'), 'not a folder');
    const out = await runDispatch(gatewayCtx('claude'), d, new AbortController().signal);
    expect(out.outcome).toBe('failed');
    expect(ran).toBe(false);
    expect(sb.tasks).toEqual([]);
    expect(api.completed.at(-1)).toMatchObject({
      outcome: 'failed',
      refusal: gatewayUnusableText('Fusebox'),
      failure: { code: 'provider' },
    });
  });
});

describe('a gateway turn’s egress (AIG-10)', () => {
  const gateway = { name: 'Fusebox', baseUrl: 'http://127.0.0.1:47104/ai-gateway/claude', home: '/h' };
  it('leaves out the provider’s endpoints; GitHub and the operator’s allowances stay', () => {
    expect(
      egressPolicy('claude', { network: false, gateway }, { egressAllow: ['registry.npmjs.org'] }),
    ).toEqual({
      allow: [...GITHUB_ENDPOINTS, 'registry.npmjs.org'],
    });
    expect(egressPolicy('claude', { network: false }, {}).allow).toContain('api.anthropic.com');
  });

  it('with the web key any public host, as the key says', () => {
    expect(egressPolicy('codex', { network: true, gateway }, {})).toEqual({ allow: 'public' });
  });
});
