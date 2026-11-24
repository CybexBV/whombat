/**
 * The 1Password worker (docs/decisions/onepassword-sync.md OPW-30, OPW-31): a process of its own that runs 1Password's
 * SDK, a 0.x WASM library, so a crash or a leak in it can't take the server down. The server's pool (`pool.ts`) starts
 * it with `--whombat-onepassword-worker` and speaks JSON lines with it: one request per line on stdin
 * (`OnePasswordRequest`), one answer per line on stdout (`OnePasswordReply`), in any order, matched by `id`.
 *
 * It keeps one SDK client per token while it runs (the token arrives with every call, so the worker holds nothing that
 * matters), writes no value and no token anywhere, and reaches only 1Password: the global `fetch`, which the SDK's
 * core uses for every request, is wrapped before the SDK loads so it goes only over https to 1password.com,
 * 1password.eu, 1password.ca and their subdomains, and follows no redirect.
 *
 * This module is loaded two ways: imported by the server's tests (the functions below), and as the worker's entry:
 * from source by Node's own type stripping, and from a release as `app/onepassword-worker.mjs`, its own esbuild entry
 * (scripts/package) next to `node_modules/@1password/sdk`. So it imports only Node built-ins and the SDK, never a
 * workspace package or a relative module, and uses only erasable TypeScript.
 */
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

/** The argument the pool starts the worker with; without it, importing this module serves nothing. */
export const ONEPASSWORD_WORKER_FLAG = '--whombat-onepassword-worker';

/** What a request names. `probe` only loads the SDK (and so its WASM): the packaged layout's own check. */
export type OnePasswordCall =
  | { call: 'probe' }
  | { call: 'check'; token: string }
  | { call: 'overview'; token: string; vaultId: string }
  | { call: 'list'; token: string; vaultId: string }
  | { call: 'get'; token: string; vaultId: string; itemIds: string[] }
  | { call: 'create'; token: string; item: Record<string, unknown> }
  | { call: 'put'; token: string; item: Record<string, unknown> }
  | { call: 'archive'; token: string; vaultId: string; itemId: string };

export type OnePasswordRequest = OnePasswordCall & { id: number };

/**
 * Why a call failed: `limit` (1Password's “too many requests”), `auth` (the token was refused or expired),
 * `forbidden` (the token may not do this: a read-only token writing), `not_found`, `network` (1Password couldn't be
 * reached, or the address wasn't 1Password's), `invalid` (a request the worker couldn't read), `failed` (anything else,
 * a stale `put` among them).
 */
export type OnePasswordErrorKind =
  | 'limit'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'network'
  | 'invalid'
  | 'failed';

export interface OnePasswordWorkerError {
  kind: OnePasswordErrorKind;
  /** The SDK's words with the token and every value of the request taken out, at most 300 characters. */
  message: string;
}

export type OnePasswordReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: OnePasswordWorkerError };

/** A `get`'s answer: the items read, the ids 1Password doesn't have, and those it couldn't read. */
export interface OnePasswordGetResult {
  items: unknown[];
  missing: string[];
  failed: string[];
}

/** The part of the SDK the worker uses (`@1password/sdk` 0.5.0). Tests hand in a stand-in. */
export interface SdkClient {
  vaults: {
    list(): Promise<unknown[]>;
    getOverview(vaultId: string): Promise<unknown>;
  };
  items: {
    list(vaultId: string, ...filters: unknown[]): Promise<unknown[]>;
    getAll(
      vaultId: string,
      itemIds: string[],
    ): Promise<{ individualResponses: { content?: unknown; error?: { type: string } }[] }>;
    create(params: unknown): Promise<unknown>;
    put(item: unknown): Promise<unknown>;
    archive(vaultId: string, itemId: string): Promise<void>;
  };
}

export interface Sdk {
  createClient(config: {
    auth: string;
    integrationName: string;
    integrationVersion: string;
  }): Promise<SdkClient>;
  RateLimitExceededError?: new (...args: never[]) => Error;
  AuthExpiredError?: new (...args: never[]) => Error;
  DesktopSessionExpiredError?: new (...args: never[]) => Error;
}

/* The network --------------------------------------------------------------------------------------- */

/** 1Password's sign-in domains (a service account's token names one of them, or a subdomain of one). */
const ONEPASSWORD_HOST = /^(?:[a-z0-9-]+\.)*1password\.(?:com|eu|ca)$/i;

/** Whether the worker may send a request there: https, the default port, a 1Password host. */
export function onePasswordAddressAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    ONEPASSWORD_HOST.test(url.hostname)
  );
}

/** Hosts a request was refused for (names only), for the smoke script's report and the server's log. */
export const refusedHosts = new Set<string>();

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

/**
 * The global `fetch`, wrapped: only 1Password's own hosts over https, never a redirect (a redirect elsewhere would
 * leave the rule behind). The server's outbound guard (`lib/outbound.ts`) can't wrap the SDK's client, so this is its
 * guard (OPW-31).
 */
export function guardFetch(real: typeof fetch): typeof fetch {
  const guarded = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input);
    if (!onePasswordAddressAllowed(url)) {
      let host = 'an address';
      try {
        host = new URL(url).hostname || host;
      } catch {}
      refusedHosts.add(host.slice(0, 100));
      return Promise.reject(new TypeError(`Whombat’s 1Password worker reaches only 1Password, not ${host}.`));
    }
    return real(input, { ...init, redirect: 'error' });
  };
  return guarded as typeof fetch;
}

/* Errors and words ------------------------------------------------------------------------------------- */

const MESSAGE_MAX = 300;

/**
 * The text with every one of `secrets` taken out (the token, the item's values), then cut to 300 characters. Values
 * shorter than 4 characters stay: taking out every “a” would only garble the words.
 */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  const sorted = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join('[hidden]');
  // A service account token has its own shape: anything that looks like one goes too.
  out = out.replace(/ops_[A-Za-z0-9+/=_-]{8,}/g, '[hidden]');
  return out.length > MESSAGE_MAX ? `${out.slice(0, MESSAGE_MAX - 1)}…` : out;
}

/** Every text value in a request: the token and each string inside an item (field values, titles, addresses). */
export function requestSecrets(request: Partial<OnePasswordCall>): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  if ('token' in request && typeof request.token === 'string') out.push(request.token);
  if ('item' in request) walk(request.item, 0);
  return out;
}

/** The kind of a failure, from the SDK's own error classes, else from its words. */
export function classifyError(err: unknown, sdk: Partial<Sdk> | null): OnePasswordErrorKind {
  if (sdk?.RateLimitExceededError && err instanceof sdk.RateLimitExceededError) return 'limit';
  if (sdk?.AuthExpiredError && err instanceof sdk.AuthExpiredError) return 'auth';
  if (sdk?.DesktopSessionExpiredError && err instanceof sdk.DesktopSessionExpiredError) return 'auth';
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  if (/rate.?limit|too many requests/i.test(`${name} ${text}`)) return 'limit';
  if (err instanceof TypeError && /fetch|reaches only 1Password|network/i.test(text)) return 'network';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network/i.test(text)) return 'network';
  if (
    /permission|forbidden|not allowed|access denied|read.?only|not authori[sz]ed to (write|update|create)/i.test(
      text,
    )
  )
    return 'forbidden';
  if (
    /invalid (service account )?token|unauthori[sz]ed|authenticat|auth expired|sign.?in failed|token/i.test(
      text,
    )
  )
    return 'auth';
  if (/not found|doesn'?t exist|does not exist|no item/i.test(text)) return 'not_found';
  return 'failed';
}

/* Calls ---------------------------------------------------------------------------------------------- */

/** Dates as ISO text and bytes as number arrays, the way the SDK itself sends them back in a `put`. */
function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Uint8Array) return Array.from(v);
      return v;
    }),
  );
}

/** Who 1Password sees calling: Whombat, with the worker's protocol version (not the release's). */
const INTEGRATION = { integrationName: 'Whombat', integrationVersion: '1' } as const;

const ACTIVE_ONLY = { type: 'ByState', content: { active: true, archived: false } } as const;

export interface WorkerOptions {
  /** Loads the SDK (and so its WASM) on first use. */
  loadSdk: () => Promise<Sdk>;
  write: (line: string) => void;
}

/** The worker's state: the SDK once loaded and one client per token (by the token's hash). */
export function createWorker(options: WorkerOptions) {
  let sdk: Promise<Sdk> | null = null;
  const clients = new Map<string, Promise<SdkClient>>();

  const loaded = () => {
    sdk ??= options.loadSdk();
    return sdk;
  };
  const keyOf = (token: string) => createHash('sha256').update(token).digest('hex');

  async function clientFor(token: string): Promise<SdkClient> {
    const key = keyOf(token);
    let client = clients.get(key);
    if (!client) {
      client = loaded().then((s) => s.createClient({ auth: token, ...INTEGRATION }));
      clients.set(key, client);
      // A client that couldn't sign in is forgotten, so the next call tries again.
      client.catch(() => {
        if (clients.get(key) === client) clients.delete(key);
      });
    }
    return client;
  }

  async function run(request: OnePasswordCall): Promise<unknown> {
    switch (request.call) {
      case 'probe':
        await loaded();
        return { loaded: true };
      case 'check': {
        const client = await clientFor(request.token);
        const vaults = (await client.vaults.list()) as { id: string; title: string }[];
        return { vaults: vaults.map((v) => ({ id: v.id, title: v.title })) };
      }
      case 'overview':
        return toJson(await (await clientFor(request.token)).vaults.getOverview(request.vaultId));
      case 'list':
        return toJson(await (await clientFor(request.token)).items.list(request.vaultId, ACTIVE_ONLY));
      case 'get': {
        const ids = request.itemIds.slice(0, 50);
        const answer = await (await clientFor(request.token)).items.getAll(request.vaultId, ids);
        const result: OnePasswordGetResult = { items: [], missing: [], failed: [] };
        answer.individualResponses.forEach((r, i) => {
          const id = ids[i] ?? '';
          if (r.content !== undefined) result.items.push(toJson(r.content));
          else if (r.error?.type === 'itemNotFound') result.missing.push(id);
          else result.failed.push(id);
        });
        return result;
      }
      case 'create':
        return toJson(await (await clientFor(request.token)).items.create(request.item));
      case 'put':
        return toJson(await (await clientFor(request.token)).items.put(request.item));
      case 'archive':
        await (await clientFor(request.token)).items.archive(request.vaultId, request.itemId);
        return { archived: true };
    }
  }

  /** One line in, one line out. A line that isn't a request is answered `invalid` (with id 0 when it has none). */
  async function handle(line: string): Promise<void> {
    let request: OnePasswordRequest;
    try {
      request = JSON.parse(line) as OnePasswordRequest;
      if (!request || typeof request !== 'object' || typeof request.id !== 'number') throw new Error('no id');
    } catch {
      options.write(
        JSON.stringify({ id: 0, ok: false, error: { kind: 'invalid', message: 'Not a request.' } }),
      );
      return;
    }
    let reply: OnePasswordReply;
    try {
      reply = { id: request.id, ok: true, result: await run(request) };
    } catch (err) {
      const s = await sdk?.catch(() => null);
      // An expired sign-in: the next call makes a new client.
      const kind = classifyError(err, s ?? null);
      if (kind === 'auth' && 'token' in request) clients.delete(keyOf(request.token));
      const text = err instanceof Error ? err.message || err.name : String(err);
      reply = {
        id: request.id,
        ok: false,
        error: { kind, message: scrubText(text || 'It failed.', requestSecrets(request)) },
      };
    }
    options.write(JSON.stringify(reply));
  }

  return { handle, clients };
}

/* The process ------------------------------------------------------------------------------------------------ */

async function loadRealSdk(): Promise<Sdk> {
  const mod = (await import('@1password/sdk')) as unknown as { default?: Sdk } & Sdk;
  return (mod.default ?? mod) as Sdk;
}

function serve(): void {
  globalThis.fetch = guardFetch(globalThis.fetch.bind(globalThis));
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const worker = createWorker({ loadSdk: loadRealSdk, write: out });
  // Nothing of the SDK's own reaches stderr unscrubbed: its warnings go nowhere (the pool logs only what we write).
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (line.trim() !== '') void worker.handle(line);
  });
  // The server went away (or stopped the worker): nothing more to do.
  input.on('close', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`onepassword worker: ${scrubText(err.name || 'Error', [])}\n`);
    process.exit(70);
  });
}

if (process.argv.includes(ONEPASSWORD_WORKER_FLAG)) serve();
