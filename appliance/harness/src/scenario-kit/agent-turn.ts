/**
 * The harness acting as an agent (scenario p, IN-64): a stand-in for the runner that claims dispatches from the
 * runtime's runner protocol (`/internal/runner/*`, the environment's runner token, loopback only), beats progress, and
 * calls the Whombat MCP server (`/mcp`) with the dispatch's agent token, exactly as a provider does. It lets a scenario
 * decide what the agent calls without a live model or a scripted storyline for it.
 *
 * The runtime hands a dispatch to whichever runner claims it first, so the environment's own runner is stopped while
 * the stand-in works (the scenario does that, and starts it again). A dispatch the scenario isn't waiting for is
 * completed `cancelled` and listed in `foreign`, never run.
 *
 * Every raw answer (claims, MCP) is kept in `transcript` so the scenario can look for a secret in what an agent got.
 * The answers that are meant to carry one — the turn's keys (`runner.turnKeys`) and a login's password
 * (`runner.loginSecret`), contracts 0.125 CT-1231, CT-1241 — are kept apart in `keys`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type DispatchContext, DispatchLoginSecret, endpointUrl, runnerApi } from '@whombat/core/contracts';
import { AGENT_PROVIDERS } from '@whombat/core/domain';
import { envPath, loadEnv } from '../dev/env.ts';

/** What the environment's scripted Hermes reports as its version: Whombat knows it by the suffix (HE-46). */
const SCRIPTED_HERMES = 'harness (scripted)';

/** Every provider kind an agent can be on (contracts 0.124.0 `AGENT_PROVIDERS`), so the stand-in takes any turn. */
const PROVIDERS = AGENT_PROVIDERS;

/**
 * What a turn holds of the person's Vault, as the runner gets it (CT-1241): files for the keys folder, environment
 * variables for every command and the MCP servers for Hermes; the fields the scenarios read (`runner.turnKeys`,
 * contracts 3.0.0).
 */
export interface TurnKeys {
  files: { path: string; mode: string; base64: string }[];
  env: { name: string; value: string }[];
  mcpServers: { name: string; url: string; headers: { name: string; value: string }[]; tools: string[] }[];
  entries: { entryId: string; name: string }[];
}

export function runnerToken(): string {
  return (JSON.parse(readFileSync(envPath('runtime', 'secrets.json'), 'utf8')) as { runnerToken: string })
    .runnerToken;
}

/* MCP over streamable HTTP ------------------------------------------------------------------------------------- */

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

/**
 * The JSON-RPC messages of one streamable-HTTP answer: a JSON body (one message or a batch), or an SSE stream whose
 * `data:` fields each carry one. Pure.
 */
export function parseMcpHttpAnswer(contentType: string | null, body: string): JsonRpcMessage[] {
  if (!body.trim()) return [];
  if ((contentType ?? '').includes('text/event-stream')) {
    const out: JsonRpcMessage[] = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.trim()) out.push(JSON.parse(data) as JsonRpcMessage);
    }
    return out;
  }
  const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class McpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A tool as `tools/list` gives it. */
export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  annotations?: { title?: string } & Record<string, unknown>;
}

export interface AgentMcp {
  listTools(): Promise<ListedTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * A minimal MCP client for a stateless MCP server over streamable HTTP (JSON or SSE answers): Whombat's `/mcp` with an
 * agent token, or, as Hermes reaches an MCP entry's server, with the headers the turn's keys carry (CT-1241).
 */
export async function agentMcp(
  url: string,
  auth: string | Record<string, string>,
  transcript: string[],
): Promise<AgentMcp> {
  const signIn = typeof auth === 'string' ? { authorization: `Bearer ${auth}` } : auth;
  let next = 0;
  let version = '2025-06-18';
  const post = async (message: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...signIn,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    transcript.push(body);
    return { res, messages: parseMcpHttpAnswer(res.headers.get('content-type'), body) };
  };
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const id = ++next;
    const { res, messages } = await post({ jsonrpc: '2.0', id, method, params });
    const answer = messages.find((m) => m.id === id);
    if (!answer) throw new Error(`MCP ${method}: HTTP ${res.status} without an answer`);
    if (answer.error) throw new McpRpcError(answer.error.code, answer.error.message, answer.error.data);
    return answer.result as Record<string, unknown>;
  };
  const init = await rpc('initialize', {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 'whombat-harness-agent', version: '1.0.0' },
  });
  if (typeof init.protocolVersion === 'string') version = init.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    async listTools() {
      return ((await rpc('tools/list', {})).tools ?? []) as ListedTool[];
    },
    async callTool(name, args) {
      return (await rpc('tools/call', { name, arguments: args })) as ToolResult;
    },
  };
}

/* The runner stand-in ------------------------------------------------------------------------------------------ */

export interface ClaimedTurn {
  ctx: DispatchContext;
  /**
   * The dispatch context as the server sent it. `ctx` is parsed with the contracts the harness vendors, which drop the
   * fields of newer releases (`skills` since 0.113, Whombat skill-store.md SST-07); a scenario reads those here.
   */
  raw: Record<string, unknown>;
  mcp: AgentMcp;
  /** One progress beat (`running`); answers whether the server wants the turn stopped. */
  beat(): Promise<{ cancel: boolean; reason: string | null }>;
  /**
   * `runner.turnKeys` (CT-1241): what the turn holds of the person's Vault — files, environment, MCP servers for
   * Hermes, the values to sweep. The status and, on 200, the keys.
   */
  turnKeys(): Promise<{ status: number; keys: TurnKeys | null; code: string | null }>;
  /** `runner.loginSecret` (CT-1231) for one of the turn's logins, with its lease: the status and, on 200, the secret. */
  loginSecret(
    entryId: string,
  ): Promise<{ status: number; secret: DispatchLoginSecret | null; code: string | null }>;
  /** `usage`: what the turn used, as a provider reports it (contracts ≥ 0.20.0 count it in Spend, SP-01). */
  complete(
    outcome: 'done' | 'failed' | 'cancelled',
    error?: string,
    usage?: { inputTokens: number; outputTokens: number; costUsd?: number },
  ): Promise<void>;
}

export interface HarnessRunner {
  runnerId: string;
  /** Dispatches claimed that the scenario wasn't waiting for, completed `cancelled`. */
  foreign: { id: string; trigger: string; agentId: string }[];
  /** Raw claim answers and MCP answers, in order. */
  transcript: string[];
  /** Raw answers of `runner.turnKeys` and `runner.loginSecret`: where a turn's secrets are meant to be. */
  keys: string[];
  /** Claims until a dispatch matches `pick` (others are cancelled), then beats once and opens its MCP client. */
  claim(pick: (ctx: DispatchContext) => boolean, what: string, timeoutMs?: number): Promise<ClaimedTurn>;
}

export function harnessRunner(serverUrl: string, token = runnerToken()): HarnessRunner {
  const runnerId = `rnr_harness_${randomBytes(6).toString('hex')}`;
  const transcript: string[] = [];
  const keys: string[] = [];
  const foreign: HarnessRunner['foreign'] = [];
  /** A runner call whose refusal is an answer: the status, the parsed body (null on an error) and the error's code. */
  const answer = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(new URL(url, serverUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    keys.push(text);
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    const code = res.ok ? null : ((parsed as { error?: { code?: string } } | null)?.error?.code ?? null);
    return { status: res.status, body: res.ok ? parsed : null, code };
  };
  const call = async <E extends 'claim' | 'progress' | 'complete'>(
    name: E,
    params: Record<string, string>,
    body: unknown,
  ): Promise<unknown> => {
    const ep = runnerApi[name];
    const res = await fetch(new URL(endpointUrl(ep, params), serverUrl), {
      method: ep.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (name === 'claim') transcript.push(text);
    if (!res.ok) throw new Error(`${ep.id}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const lease = (ctx: DispatchContext) => ({
    runnerId,
    ...(ctx.dispatch.attempts ? { attempt: ctx.dispatch.attempts } : {}),
  });
  /**
   * Says what the stand-in runs before it claims, as the environment's runner does in its heartbeats: the scripted
   * Hermes it stands in for (Whombat HE-46). The server then claims its turns without asking a runner for the person's
   * sign-in, which the stopped runner would never answer (`provider.signin_unavailable` after 45 s).
   */
  let announced = false;
  const announce = async () => {
    if (announced || (loadEnv()?.agents ?? 'scripted') !== 'scripted') return;
    const ep = runnerApi.heartbeat;
    const res = await fetch(new URL(endpointUrl(ep, {}), serverUrl), {
      method: ep.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        runnerId,
        active: [],
        status: {
          hermes: { ready: true, version: SCRIPTED_HERMES, problem: null, detail: null },
          providers: [],
          checkedAt: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${ep.id}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    announced = true;
  };
  return {
    runnerId,
    foreign,
    transcript,
    keys,
    async claim(pick, what, timeoutMs = 60_000) {
      await announce();
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const waitMs = Math.max(0, Math.min(5_000, until - Date.now()));
        const raw = (await call(
          'claim',
          {},
          {
            runnerId,
            name: 'harness (scenario stand-in)',
            providers: PROVIDERS,
            waitMs,
          },
        )) as unknown;
        const { dispatch: ctx } = runnerApi.claim.response.parse(raw);
        if (!ctx) continue;
        const sent = ((raw as { dispatch?: Record<string, unknown> }).dispatch ?? {}) as Record<
          string,
          unknown
        >;
        if (!pick(ctx)) {
          foreign.push({ id: ctx.dispatch.id, trigger: ctx.dispatch.trigger, agentId: ctx.dispatch.agentId });
          await call('complete', { dispatchId: ctx.dispatch.id }, { ...lease(ctx), outcome: 'cancelled' });
          continue;
        }
        const beat = async () => {
          const r = (await call(
            'progress',
            { dispatchId: ctx.dispatch.id },
            { ...lease(ctx), state: 'running', thinking: true },
          )) as { cancel: boolean; reason: string | null };
          return { cancel: r.cancel, reason: r.reason };
        };
        const first = await beat();
        if (first.cancel) throw new Error(`${what}: the server stopped the turn at once (${first.reason})`);
        const mcp = await agentMcp(
          new URL(ctx.mcpPath, serverUrl).toString(),
          ctx.agentToken.token,
          transcript,
        );
        const live = lease(ctx);
        return {
          ctx,
          raw: sent,
          mcp,
          beat,
          async turnKeys() {
            const ep = runnerApi.turnKeys;
            const r = await answer(
              endpointUrl(ep, { dispatchId: ctx.dispatch.id }, { runnerId, attempt: live.attempt ?? 1 }),
              ep.method,
            );
            return { status: r.status, keys: r.body ? (r.body as TurnKeys) : null, code: r.code };
          },
          async loginSecret(entryId) {
            const r = await answer(
              endpointUrl(runnerApi.loginSecret, { dispatchId: ctx.dispatch.id, entryId }),
              runnerApi.loginSecret.method,
              { runnerId, attempt: live.attempt ?? 1 },
            );
            return {
              status: r.status,
              secret: r.body ? DispatchLoginSecret.parse(r.body) : null,
              code: r.code,
            };
          },
          async complete(outcome, error, usage) {
            await call(
              'complete',
              { dispatchId: ctx.dispatch.id },
              { ...lease(ctx), outcome, ...(error ? { error } : {}), ...(usage ? { usage } : {}) },
            );
          },
        };
      }
      throw new Error(
        `${what}: no such dispatch within ${timeoutMs} ms (cancelled on the way: ${foreign.length})`,
      );
    },
  };
}
