/**
 * Pooled MCP clients over streamable HTTP, run by the server only (docs/decisions/vault.md VT-40, VT-43, VT-44;
 * connections-catalog.md CX-32): the shared core of the Vault's bridged MCP servers (`vault/pool.ts`) and catalog
 * connections (`connections/pool.ts`).
 *
 * One pooled connection per key (an entry, a connection), reconnected when its `version` changes, closed after a while
 * unused and evicted when what it stands for changes. A server that forgot the session (404 to its id, as T3 Code does
 * when it restarts) gets a new one and the call once more: per MCP's streamable HTTP it never ran the request. Every JSON-RPC request goes through the target's own `post` (its
 * destination rule, credential and caps); server-initiated streams and session teardown are not used.
 *
 * Nothing the remote side says reaches an agent unfiltered: a failed exchange is summarised by its status or kind
 * (`VaultCallError`), never quoted — a non-2xx answer reaches the SDK without its body — and every listed definition and
 * result is checked against the target's secret forms (withheld whole when one appears, VT-D22).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { RemoteVaultTool } from '@whombat/core';
import type { OutboundResponse } from '../lib/outbound';
import { statusFailure, VaultCallError, VaultEchoError } from '../vault/net';
import {
  bytesHoldSecret,
  cutText,
  holdsSecret,
  jsonHoldsSecret,
  type SecretForms,
  scrubJson,
} from '../vault/scrub';

/**
 * The scopes an OAuth `insufficient_scope` challenge asks for (RFC 6750 §3.1, MCP's step-up): `Bearer
 * error="insufficient_scope", scope="a b"`. Null for any other answer, or one that names no scope.
 */
export function insufficientScopeOf(header: string | null | undefined): string[] | null {
  if (!header) return null;
  const param = (name: string) =>
    new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`, 'i').exec(header);
  const error = param('error');
  if ((error?.[1] ?? error?.[2])?.toLowerCase() !== 'insufficient_scope') return null;
  const scope = param('scope');
  const scopes = (scope?.[1] ?? scope?.[2] ?? '').split(/\s+/).filter(Boolean);
  return scopes.length ? scopes : null;
}

/**
 * The server refused a call for a scope its token lacks and named what it wants (a 403 `insufficient_scope`): the
 * person has to allow more at the service. Summarised as any refusal, with the scopes it asked for.
 */
export class ScopeNeededError extends VaultCallError {
  constructor(readonly scopes: string[]) {
    super('rejected', 'The service needs more permission for this.', 403);
    this.name = 'ScopeNeededError';
  }
}

/** The `_meta` key a server puts its challenge under in a tool's error result, for clients that read it there. */
const CHALLENGE_META_KEY = 'mcp/www_authenticate';

/** What one pooled connection is for. A change of `version` reconnects. */
export interface McpPoolTarget {
  key: string;
  url: string;
  version: string;
  /** The secret forms answers are checked against (VT-D22); [] for none. */
  forms: readonly SecretForms[];
  /**
   * Sends one JSON-RPC POST with the SDK's headers and body (the target adds its credential last) and answers whatever
   * the server said. Throws a summarised `VaultCallError` when it can't be sent or answered.
   */
  post(headers: Record<string, string>, body: string): Promise<OutboundResponse>;
}

export interface McpToolResult {
  /** The tool's text content, scrubbed and cut at the output cap. */
  text: string;
  /** The tool's structured content (dropped when larger than the output cap). */
  structured: Record<string, unknown> | undefined;
  isError: boolean;
  truncated: boolean;
  bytes: number;
  /** An error result whose `_meta` held an `insufficient_scope` challenge: the scopes it asks for. */
  scopeNeeded?: string[];
}

export interface McpPoolOptions {
  /** The client name the server sees. */
  clientName: string;
  /** The whole exchange's deadline (connect, list, call). */
  deadlineMs: () => number;
  idleMs: number;
  /** The output a call keeps. */
  outputMax: number;
}

/** A listed tool's input schema is kept up to this size; a larger one is offered as a plain object. */
const SCHEMA_MAX = 32 * 1024;
/** `tools/list` pages read at most. */
const LIST_PAGES_MAX = 10;

interface Connection {
  key: string;
  version: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
  inflight: number;
  idle: NodeJS.Timeout | null;
}

/** The server answered 404 to the session it gave: it forgot it. */
class SessionLost extends Error {}

/** Runs `promise` until `deadlineAt`, then fails `timeout` (and calls `onTimeout`). */
export function until<T>(promise: Promise<T>, deadlineAt: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        onTimeout();
        reject(new VaultCallError('timeout'));
      },
      Math.max(1, deadlineAt - Date.now()),
    );
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Why an MCP exchange failed, in our words (VT-42). `during`: connecting (a JSON-RPC error there means it isn't an
 * MCP server) or calling a tool (the tool reported an error).
 */
export function summariseMcp(err: unknown, during: 'connect' | 'call'): VaultCallError {
  if (err instanceof VaultCallError) return err;
  if (err instanceof StreamableHTTPError) {
    const code = typeof err.code === 'number' ? err.code : -1;
    return code >= 100 && code <= 599 ? statusFailure(code) : new VaultCallError('rejected');
  }
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return new VaultCallError('timeout');
    return during === 'call' ? new VaultCallError('invalid_request') : new VaultCallError('rejected');
  }
  return new VaultCallError(during === 'call' ? 'invalid_request' : 'rejected');
}

export class McpClientPool<T extends McpPoolTarget = McpPoolTarget> {
  readonly #connections = new Map<string, Promise<Connection>>();
  #closed = false;

  constructor(private readonly options: McpPoolOptions) {}

  /** Connections held now (tests). */
  get size(): number {
    return this.#connections.size;
  }

  /** A fresh connection, `initialize` and every page of `tools/list`, closed again. Definitions are scrubbed. */
  async listTools(target: T): Promise<RemoteVaultTool[]> {
    const deadlineAt = Date.now() + this.options.deadlineMs();
    const client = this.#client();
    try {
      // The person's own check: definitions are scrubbed below, nothing is withheld (VT-D08).
      await until(
        this.#connect(client, this.#transport(target, false)),
        deadlineAt,
        () => void client.close().catch(() => {}),
      );
      const tools: RemoteVaultTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES_MAX; page++) {
        const res = await until(
          client.listTools(cursor ? { cursor } : undefined),
          deadlineAt,
          () => void client.close().catch(() => {}),
        ).catch((err: unknown) => {
          throw summariseMcp(err, 'connect');
        });
        for (const t of res.tools) tools.push(this.#listed(t as RemoteVaultTool, target.forms));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools.filter((t) => t.name !== '');
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * What the server says of itself in `initialize` (its name, version and icons), from a fresh connection closed again;
   * null when it says nothing. Scrubbed as listed tools are.
   */
  async serverInfo(target: T): Promise<Record<string, unknown> | null> {
    const deadlineAt = Date.now() + this.options.deadlineMs();
    const client = this.#client();
    try {
      await until(
        this.#connect(client, this.#transport(target, false)),
        deadlineAt,
        () => void client.close().catch(() => {}),
      );
      const info = client.getServerVersion();
      return info ? (scrubJson(info, target.forms) as Record<string, unknown>) : null;
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Calls a tool on the target's pooled connection. Throws `VaultCallError` (summarised). A lost session is opened
   * again once, within the same deadline.
   */
  async call(target: T, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.#closed) throw new VaultCallError('unreachable');
    const deadlineAt = Date.now() + this.options.deadlineMs();
    try {
      return await this.#callOnce(target, tool, args, deadlineAt);
    } catch (err) {
      if (!(err instanceof SessionLost)) throw err;
      return this.#callOnce(target, tool, args, deadlineAt).catch((again: unknown) => {
        throw again instanceof SessionLost ? statusFailure(404) : again;
      });
    }
  }

  async #callOnce(
    target: T,
    tool: string,
    args: Record<string, unknown>,
    deadlineAt: number,
  ): Promise<McpToolResult> {
    const existing = this.#connections.get(target.key);
    const current = existing ? await existing.catch(() => null) : null;
    let pending: Promise<Connection>;
    if (existing && current && current.version === target.version) pending = existing;
    else {
      if (existing) await this.evict(target.key);
      const opening = this.#open(target, deadlineAt);
      pending = opening;
      this.#connections.set(target.key, opening);
      opening.catch(() => {
        if (this.#connections.get(target.key) === opening) this.#connections.delete(target.key);
      });
    }
    const conn = await pending;
    conn.inflight++;
    if (conn.idle) clearTimeout(conn.idle);
    conn.idle = null;
    try {
      const result = await until(
        conn.client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: Math.max(1, deadlineAt - Date.now()) + 1000,
        }),
        deadlineAt,
        () => void this.evict(target.key),
      ).catch(async (err: unknown) => {
        if (err instanceof StreamableHTTPError && err.code === 404 && conn.transport.sessionId) {
          // Only this session goes: another call may have opened the next one already.
          if (this.#connections.get(target.key) === pending) this.#connections.delete(target.key);
          await conn.client.close().catch(() => {});
          throw new SessionLost();
        }
        throw summariseMcp(err, 'call');
      });
      return this.#render(
        result as { content?: unknown; isError?: boolean; structuredContent?: unknown; _meta?: unknown },
        target.forms,
      );
    } finally {
      conn.inflight--;
      if (this.#connections.get(target.key) === pending && conn.inflight === 0) {
        conn.idle = setTimeout(() => void this.evict(target.key), this.options.idleMs);
        conn.idle.unref?.();
      }
    }
  }

  /** Closes a key's connection (what it stands for changed or went away). */
  async evict(key: string): Promise<void> {
    const pending = this.#connections.get(key);
    this.#connections.delete(key);
    const conn = await pending?.catch(() => null);
    if (!conn) return;
    if (conn.idle) clearTimeout(conn.idle);
    await conn.client.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#connections.keys()].map((k) => this.evict(k)));
  }

  async #open(target: T, deadlineAt: number): Promise<Connection> {
    const client = this.#client();
    const transport = this.#transport(target, true);
    try {
      await until(this.#connect(client, transport), deadlineAt, () => void client.close().catch(() => {}));
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return { key: target.key, version: target.version, client, transport, inflight: 0, idle: null };
  }

  async #connect(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
    try {
      await client.connect(transport, { timeout: this.options.deadlineMs() });
    } catch (err) {
      throw summariseMcp(err, 'connect');
    }
  }

  #client(): Client {
    const client = new Client({ name: this.options.clientName, version: '1.0.0' }, { capabilities: {} });
    // The SDK reports transport errors here too; they are summarised where they are thrown, never logged.
    client.onerror = () => {};
    return client;
  }

  /**
   * The transport of one connection. `withhold`: an agent's calls — any raw answer (a result, an error, a failed
   * request's body) that holds a secret form throws `VaultEchoError` before the SDK parses it (VT-D22).
   */
  #transport(target: T, withhold: boolean): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(target.url), {
      fetch: async (_url, init) => {
        // No standalone server-to-client stream and no session teardown: answer as a server without them would.
        if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return new Response(null, { status: 405 });
        const sent: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          sent[k] = v;
        });
        const res = await target.post(sent, typeof init?.body === 'string' ? init.body : '');
        if (withhold && bytesHoldSecret(res.body, target.forms)) throw new VaultEchoError(res.status);
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') out.set(k, v);
          else if (Array.isArray(v)) out.set(k, v.join(', '));
        }
        // A missing scope the server names: the person can allow it at the service (MCP's step-up).
        if (res.status === 403) {
          const scopes = insufficientScopeOf(out.get('www-authenticate'));
          if (scopes) throw new ScopeNeededError(scopes);
        }
        // A failed answer reaches the SDK without its body, so its error can never quote it (VT-42).
        if (res.status < 200 || res.status >= 300) return new Response(null, { status: res.status });
        return new Response(res.status === 204 || res.status === 202 ? null : new Uint8Array(res.body), {
          status: res.status,
          headers: out,
        });
      },
    });
  }

  /** A listed tool as it is stored and hashed: scrubbed, a bounded schema; a name holding a secret is dropped. */
  #listed(tool: RemoteVaultTool, secrets: readonly SecretForms[]): RemoteVaultTool {
    if (typeof tool.name !== 'string' || holdsSecret(tool.name, secrets)) return { name: '' };
    const clean = scrubJson(
      {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      secrets,
    );
    const schema = JSON.stringify(clean.inputSchema ?? null);
    return {
      ...clean,
      name: tool.name,
      inputSchema:
        schema.length <= SCHEMA_MAX && clean.inputSchema && typeof clean.inputSchema === 'object'
          ? clean.inputSchema
          : { type: 'object', additionalProperties: true },
    };
  }

  #render(
    result: { content?: unknown; isError?: boolean; structuredContent?: unknown; _meta?: unknown },
    secrets: readonly SecretForms[],
  ): McpToolResult {
    const meta = result._meta as Record<string, unknown> | undefined;
    const challenge = result.isError === true ? meta?.[CHALLENGE_META_KEY] : undefined;
    const scopeNeeded = typeof challenge === 'string' ? insufficientScopeOf(challenge) : null;
    const max = this.options.outputMax;
    // Checked whole before anything is kept or cut (VT-D20, VT-D22): the raw answer already was; this is the parsed one.
    if (
      jsonHoldsSecret(result.content ?? null, secrets) ||
      jsonHoldsSecret(result.structuredContent ?? null, secrets)
    )
      throw new VaultEchoError();
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const item of result.content as { type?: string; text?: unknown }[]) {
        if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
        else if (typeof item?.type === 'string') parts.push(`[${item.type.slice(0, 40)} content]`);
      }
    }
    let structured: Record<string, unknown> | undefined;
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      const json = JSON.stringify(result.structuredContent);
      if (json.length <= max) structured = result.structuredContent as Record<string, unknown>;
      if (!parts.length) parts.push(json);
    }
    const full = parts.join('\n');
    if (holdsSecret(full, secrets)) throw new VaultEchoError();
    const bytes = Buffer.byteLength(full);
    const cut = cutText(full, max, secrets);
    const text = cut.cut ? `${cut.text}\n[output cut at ${max} bytes]` : full;
    return {
      text,
      structured,
      isError: result.isError === true,
      truncated: cut.cut,
      bytes,
      ...(scopeNeeded ? { scopeNeeded } : {}),
    };
  }
}
