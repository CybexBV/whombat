/**
 * The AI client this Whombat's agents run on (SUB-09; contracts 0.9.0 CT-72…CT-74), `clients.list|install|remove` over
 * the session: Claude Code, DirectSDK's model client. ChatGPT runs on Hermes's own loop with nothing installed
 * (hermes-native.md HN-04): Codex is never listed or installed, and a Codex the manager still has is removed once the
 * manager reports it (HN-A01…HN-A03).
 *
 * The appliance manager installs signed, tested client bundles. The runtime asks it over the manager socket
 * (`GET /v1/clients`, `POST /v1/clients/install|remove`, `@whombat/control-contracts/local`) and the manager pushes
 * every change to the admin socket (`POST /clients`, `ClientsPushRequest`). The latest status is written to
 * `WHOMBAT_CLIENTS_FILE` for the runner, which runs exactly the installed executable and checks its digest.
 *
 * Listing, installing and removing are the person's.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { CLIENT_ADAPTER_LEVELS, CLIENT_NAMES, providerExecutable } from '@whombat/agent-runtime/providers';
import {
  type ClientsPushRequest,
  LOCAL_API_VERSION,
  type LocalClient,
  LocalClient as LocalClientSchema,
  LocalClientsStatus,
  MANAGER_PATHS,
} from '@whombat/control-contracts/local';
import type { ClientStatus } from '@whombat/core';
import { CommandStopped, externalEffect } from '../commit/scope';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';

/** The clients this Whombat installs: Claude Code alone (HN-A01). */
export type ClientProviderName = 'claude';
const CLIENT_PROVIDERS: readonly ClientProviderName[] = ['claude'];

/** A client this Whombat installs, of the providers the contract names (`claude`, `codex`). */
export function isClientProvider(provider: string): provider is ClientProviderName {
  return (CLIENT_PROVIDERS as readonly string[]).includes(provider);
}

/** `clients.install|remove` for anything but Claude Code: ChatGPT needs nothing installed (HN-A01). */
export function noClientNeeded(): ApiError {
  return new ApiError(
    'validation_failed',
    'ChatGPT needs nothing installed on this Whombat. Sign in to it in Settings → AI sign-in.',
    { details: { code: 'client.not_needed' } },
  );
}

export interface ClientsList {
  clients: ClientStatus[];
  checkedAt: string | null;
}

/** The clients as the manager keeps them. */
export interface ClientsBackend {
  list(): Promise<ClientsList>;
  install(provider: ClientProviderName): Promise<ClientStatus>;
  remove(provider: ClientProviderName): Promise<ClientStatus>;
  /**
   * The executable a sign-in runs for this provider now: a path, null when it should be installed and isn't, or
   * undefined for the provider's own default lookup (nothing installed by Whombat, or no status known).
   */
  command(provider: ClientProviderName): string | null | undefined;
  start(): void;
  stop(): Promise<void>;
}

/** A manager's client as Settings shows it (`ClientStatus`): its error codes get the app's `client.` prefix. */
export function clientStatusOf(c: LocalClient): ClientStatus {
  return {
    provider: c.provider,
    installed: c.installed ? { version: c.installed.version, installedAt: c.installed.installedAt } : null,
    latest: c.latest,
    state: c.state,
    progress: c.progress,
    error: c.error
      ? {
          code: c.error.code.startsWith('client.') ? c.error.code : `client.${c.error.code}`,
          message: c.error.message,
        }
      : null,
  };
}

function notInstalled(provider: ClientProviderName): ClientStatus {
  return { provider, installed: null, latest: null, state: 'not_installed', progress: null, error: null };
}

/** HTTP/1.1 JSON on the manager's unix socket; resolves with the status and the parsed body (null: none). */
function managerCall(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 256 * 1024) req.destroy(new Error('manager answer too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 500, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`manager ${path}: timed out`)));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

/**
 * Writes the runner's clients file whole: a new temp file (`wx`, random name), synced, renamed over it (SUB-46). Mode
 * 0640 set explicitly (SUB-54): the appliance's server runs with UMask 0077, and the runner, another user, reads it
 * through the group of its setgid directory.
 */
export async function writeClientsFile(file: string, doc: LocalClientsStatus): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o640);
  try {
    try {
      await handle.chmod(0o640);
      await handle.writeFile(`${JSON.stringify(doc)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The manager's side (CT-73). */
export class ManagerClients implements ClientsBackend {
  private status: LocalClientsStatus | null = null;
  /**
   * Install requests the manager refused as `unavailable` (nothing published fits this machine, or no channel): each
   * lists as `failed` with its reason until the manager reports that provider installing or installed, or another
   * install or remove is asked (SUB-55). The manager keeps no state for a refusal, so without this the next
   * `clients.list` showed `not_installed` again and the Install click looked like it did nothing.
   */
  private readonly refused = new Map<ClientProviderName, NonNullable<ClientStatus['error']>>();

  constructor(
    private readonly services: Services,
    private readonly socketPath: string | undefined,
    private readonly clientsFile: string | undefined,
  ) {}

  private unreachable(): ApiError {
    return new ApiError('conflict', 'The appliance’s manager isn’t answering. Try again in a moment.', {
      details: { code: 'client.unavailable' },
    });
  }

  /** How many statuses arrived (`apply`); a write is made only for the newest one (SUB-46). */
  private arrived = 0;

  /** When the manager first reported each client installed (since this server started), until it no longer is. */
  readonly installedAt = new Map<ClientProviderName, number>();
  /** The write in progress; the next one waits for it. */
  private writing: Promise<void> = Promise.resolve();

  /**
   * The manager's push (admin socket `POST /clients`) or its answer to `GET /v1/clients`. Statuses count in the order
   * they arrive: the newest one is kept, and only it is written — one write at a time, each to its own new temp file
   * (`wx`), synced and renamed over the file, so the runner never reads a mix of two, half of one or an older one than
   * this server holds (SUB-46, review CLI-4). The push carries no sequence of its own (contracts 0.9.0); arrival
   * order is the order.
   */
  async apply(status: Pick<ClientsPushRequest, 'clients' | 'channel'>): Promise<void> {
    const doc = LocalClientsStatus.parse({
      v: LOCAL_API_VERSION,
      clients: status.clients,
      channel: status.channel,
    });
    const seq = ++this.arrived;
    this.status = doc;
    for (const provider of CLIENT_PROVIDERS) {
      const installed = !!doc.clients.find((c) => c.provider === provider)?.installed;
      if (!installed) this.installedAt.delete(provider);
      else if (!this.installedAt.has(provider)) this.installedAt.set(provider, Date.now());
    }
    for (const c of doc.clients)
      if (isClientProvider(c.provider) && (c.state === 'installing' || c.state === 'updating'))
        this.refused.delete(c.provider);
    this.dropCodex(doc);
    const file = this.clientsFile;
    if (!file) return;
    const write = this.writing.then(async () => {
      if (seq !== this.arrived) return; // a newer status arrived: it writes itself
      await writeClientsFile(file, doc);
    });
    this.writing = write.catch(() => {});
    await write;
  }

  /** The removal of a Codex the manager still had, once asked (HN-A03); null until then or after it failed. */
  private codexRemoval: Promise<void> | null = null;

  /**
   * A Codex client the manager still has — installed before ChatGPT ran on Hermes, an install in progress or one that
   * failed and would be tried again — is removed: nothing here runs it (HN-04). Asked once per server start; asked again
   * at the manager's next status when the removal failed. Sign-ins are the runtime's and stay.
   */
  private dropCodex(doc: LocalClientsStatus): void {
    const codex = doc.clients.find((c) => c.provider === 'codex');
    if (!codex || codex.state === 'not_installed' || this.codexRemoval || !this.socketPath) return;
    const socketPath = this.socketPath;
    const log = this.services.log;
    this.codexRemoval = managerCall(socketPath, 'POST', MANAGER_PATHS.clientsRemove, {
      v: LOCAL_API_VERSION,
      provider: 'codex',
    }).then(
      (res) => {
        if (res.status < 300) {
          log.info({ was: codex.installed?.version ?? codex.state }, 'removed the Codex client nothing runs');
          return;
        }
        log.warn({ status: res.status }, 'the manager didn’t remove the Codex client; asking again later');
        this.codexRemoval = null;
      },
      (err) => {
        log.warn({ err: String(err) }, 'could not ask the manager to remove the Codex client');
        this.codexRemoval = null;
      },
    );
  }

  /** Tests: the Codex removal asked so far (null: none). */
  codexRemoved(): Promise<void> | null {
    return this.codexRemoval;
  }

  private async refresh(): Promise<LocalClientsStatus | null> {
    if (!this.socketPath) return this.status;
    try {
      const res = await managerCall(this.socketPath, 'GET', MANAGER_PATHS.clients);
      const parsed = LocalClientsStatus.safeParse(res.body);
      if (res.status < 300 && parsed.success) await this.apply(parsed.data);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'could not read the AI clients from the manager');
    }
    return this.status;
  }

  async list(): Promise<ClientsList> {
    const status = this.status ?? (await this.refresh());
    return {
      clients: CLIENT_PROVIDERS.map((p) => {
        const c = status?.clients.find((x) => x.provider === p);
        return this.withRefusal(c ? clientStatusOf(c) : notInstalled(p));
      }),
      checkedAt: status?.channel?.checkedAt ?? null,
    };
  }

  /** A client as listed, with a refused install shown as `failed` while the manager has nothing newer to say. */
  private withRefusal(c: ClientStatus): ClientStatus {
    const error = isClientProvider(c.provider) ? this.refused.get(c.provider) : undefined;
    if (!error) return c;
    if (c.state === 'installing' || c.state === 'updating' || c.error) return c;
    return { ...c, state: c.installed ? c.state : 'failed', error };
  }

  private async change(path: string, provider: ClientProviderName): Promise<ClientStatus> {
    if (!this.socketPath) throw this.unreachable();
    this.refused.delete(provider);
    let res: { status: number; body: unknown };
    const socketPath = this.socketPath;
    try {
      // The manager installs or removes the client (command-safety.md CS-01): an install is idempotent (it answers the
      // running or installed one), a removal isn't. A 4xx answer, or a socket nobody listens on, did nothing.
      res = await externalEffect(
        `manager.${path === MANAGER_PATHS.clientsInstall ? 'clients.install' : 'clients.remove'}`,
        async () => {
          const answer = await managerCall(socketPath, 'POST', path, { v: LOCAL_API_VERSION, provider });
          if (answer.status >= 400 && answer.status < 500) throw new ManagerRefused(answer);
          return answer;
        },
        {
          idempotent: path === MANAGER_PATHS.clientsInstall,
          refused: (err) =>
            err instanceof ManagerRefused ||
            ['ENOENT', 'ECONNREFUSED'].includes(String((err as { code?: unknown })?.code)),
        },
      );
    } catch (err) {
      if (err instanceof CommandStopped) throw err;
      if (!(err instanceof ManagerRefused)) throw this.unreachable();
      res = err.answer;
    }
    const client = LocalClientSchema.safeParse(res.body);
    if (res.status < 300 && client.success) {
      // Until the manager's next push: this client as it answered.
      if (this.status)
        this.status = {
          ...this.status,
          clients: [...this.status.clients.filter((c) => c.provider !== provider), client.data],
        };
      return clientStatusOf(client.data);
    }
    const code = (res.body as { error?: { code?: string; message?: string } } | null)?.error?.code;
    if (res.status === 404 || code === 'unavailable') {
      const reason = (res.body as { error?: { message?: string } } | null)?.error?.message;
      this.services.log.warn(
        { provider, reason: typeof reason === 'string' ? reason.slice(0, 300) : null },
        'the manager has no AI client to install',
      );
      this.refused.set(provider, {
        code: 'client.unavailable',
        message: `No tested ${CLIENT_NAMES[provider]} version is published for this appliance yet.`,
      });
      return (await this.list()).clients.find((c) => c.provider === provider) ?? notInstalled(provider);
    }
    if (res.status === 409 || code === 'busy')
      throw new ApiError('conflict', `${CLIENT_NAMES[provider]} is being changed. Try again in a moment.`, {
        details: { code: 'client.busy' },
      });
    throw new ApiError('conflict', `The appliance couldn’t change ${CLIENT_NAMES[provider]}.`, {
      details: { code: 'client.install_failed' },
    });
  }

  install(provider: ClientProviderName): Promise<ClientStatus> {
    return this.change(MANAGER_PATHS.clientsInstall, provider);
  }

  remove(provider: ClientProviderName): Promise<ClientStatus> {
    return this.change(MANAGER_PATHS.clientsRemove, provider);
  }

  command(provider: ClientProviderName): string | null | undefined {
    if (!this.status) return undefined;
    return this.status.clients.find((c) => c.provider === provider)?.installed?.executable.path ?? null;
  }

  start(): void {
    // Catch up at start (the manager also pushes at runtime start).
    void this.refresh();
  }

  async stop(): Promise<void> {}
}

/** The manager answered 4xx: it changed nothing. */
class ManagerRefused extends Error {
  constructor(readonly answer: { status: number; body: unknown }) {
    super(`the manager answered ${answer.status}`);
  }
}

const backends = new WeakMap<Services, Promise<ClientsBackend>>();
const built = new WeakMap<Services, ClientsBackend>();

/**
 * The executable a sign-in CLI of this provider runs (`LocalSignInExecutor.resolveClient`): the installed client, the
 * operator's pin or the provider's default; null when it should be installed and isn't.
 */
export function clientCommand(services: Services, provider: ClientProviderName): string | null {
  const said = built.get(services)?.command(provider);
  return said === undefined ? providerExecutable(provider, process.env) : said;
}

async function build(services: Services): Promise<ClientsBackend> {
  const backend = await create(services);
  built.set(services, backend);
  return backend;
}

async function create(services: Services): Promise<ClientsBackend> {
  return new ManagerClients(
    services,
    services.config.WHOMBAT_MANAGER_SOCKET,
    services.config.WHOMBAT_CLIENTS_FILE,
  );
}

/**
 * What the manager last said about a provider's client (SUB-52) — `installed`, `missing`, or `unknown` before its first
 * status (the image's pins then still apply).
 */
export function managedClientState(
  services: Services,
  provider: ClientProviderName,
): 'installed' | 'missing' | 'unknown' {
  const backend = built.get(services);
  if (!(backend instanceof ManagerClients)) return 'unknown';
  const said = backend.command(provider);
  return said === undefined ? 'unknown' : said ? 'installed' : 'missing';
}

/**
 * How long a runner gets to find a client the manager just installed: it reads the clients file at its next re-check
 * (a heartbeat, every 10 s) and checks the new executable before it claims that provider's turns.
 */
export const CLIENT_CATCH_UP_MS = 60_000;

/**
 * Whether the manager reported `provider`'s client installed less than `CLIENT_CATCH_UP_MS` ago: the runners may not
 * claim its turns yet, and a turn for it isn't one nothing here can run.
 */
export function clientJustInstalled(services: Services, provider: string, now = Date.now()): boolean {
  if (!isClientProvider(provider)) return false;
  const backend = built.get(services);
  const at = backend instanceof ManagerClients ? backend.installedAt.get(provider) : undefined;
  return at !== undefined && now - at < CLIENT_CATCH_UP_MS;
}

/** This Whombat's one clients backend. */
export function aiClients(services: Services): Promise<ClientsBackend> {
  let b = backends.get(services);
  if (!b) {
    b = build(services);
    backends.set(services, b);
  }
  return b;
}

/** The runtime's adapter levels (`RuntimeFacts.clientAdapters`, CT-73): Claude Code's (HN-A02: no Codex client). */
export function clientAdapters(): { claude: number } {
  return { claude: CLIENT_ADAPTER_LEVELS.claude };
}
