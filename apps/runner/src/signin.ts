/**
 * The runner's sign-in executor (docs/decisions/managed-providers.md PV-12): on a managed appliance the providers'
 * sign-in CLIs run here, as the runner's user, so every credential home belongs to the user whose sandboxed turns
 * use it. The server keeps attempts, policy and audit and hands each step over the loopback runner protocol
 * (`/internal/runner/signin/poll|answer|event`, runner token). Secrets arrive only inside one request and are never
 * logged; the answers carry no secret except a GitHub token the server asked for one git operation.
 *
 * The Claude sign-in console (CT-71) runs here too: its output and exit go to `/internal/runner/signin/console` in
 * order, and neither its output nor its input is ever logged (the output may echo the code the person typed).
 */
import {
  type ConsoleStartJob,
  type CredentialProvider,
  LocalSignInExecutor,
  type SecretSignIn,
  type SignInTarget,
  type UsageHostJob,
  type UsageProbeHost,
  type UsageProvider,
} from '@whombat/agent-runtime/providers';
import {
  type ConsoleSignInEvent,
  runnerApi,
  SIGNIN_METHODS,
  type SignInRequest,
} from '@whombat/core/contracts';
import { PROVIDER_CONSOLE_READ_MAX_BYTES } from '@whombat/core/domain';
import { signInSocketFetch } from './signin-socket';

/** An empty long poll that returned sooner than this waits this long before the next one. */
export const MIN_EMPTY_POLL_MS = 1_000;

/** Most console events in one report (`signin.console`). */
export const CONSOLE_EVENTS_PER_POST = 64;
/** Most console output bytes in one report (before base64). */
export const CONSOLE_BYTES_PER_POST = 256 * 1024;
/** Longest wait between retries of a failed console report. */
export const CONSOLE_RETRY_MAX_MS = 10_000;

/**
 * The next report from the head of the queue: at most `CONSOLE_EVENTS_PER_POST` events, in order, with adjacent
 * output of the same console merged up to `PROVIDER_CONSOLE_READ_MAX_BYTES`. `taken` queue entries are covered.
 */
export function consoleBatch(queue: readonly ConsoleSignInEvent[]): {
  events: ConsoleSignInEvent[];
  taken: number;
} {
  /** Output keeps its raw bytes until the batch is built. */
  const items: (ConsoleSignInEvent | { consoleId: string; offset: number; bytes: Buffer[]; size: number })[] =
    [];
  let total = 0;
  let taken = 0;
  for (const event of queue) {
    if (event.kind === 'output') {
      const bytes = Buffer.from(event.data, 'base64');
      if (taken > 0 && total + bytes.length > CONSOLE_BYTES_PER_POST) break;
      const last = items.at(-1);
      if (
        last &&
        'bytes' in last &&
        last.consoleId === event.consoleId &&
        last.offset + last.size === event.offset &&
        last.size + bytes.length <= PROVIDER_CONSOLE_READ_MAX_BYTES
      ) {
        if (bytes.length) last.bytes.push(bytes);
        last.size += bytes.length;
      } else if (items.length >= CONSOLE_EVENTS_PER_POST) break;
      else
        items.push({ consoleId: event.consoleId, offset: event.offset, bytes: [bytes], size: bytes.length });
      total += bytes.length;
    } else if (items.length >= CONSOLE_EVENTS_PER_POST) break;
    else items.push(event);
    taken++;
  }
  const events = items.map(
    (item): ConsoleSignInEvent =>
      'bytes' in item
        ? {
            kind: 'output',
            consoleId: item.consoleId,
            offset: item.offset,
            data: (item.bytes.length === 1
              ? (item.bytes[0] as Buffer)
              : Buffer.concat(item.bytes, item.size)
            ).toString('base64'),
          }
        : item,
  );
  return { events, taken };
}

export interface SignInWorkerOptions {
  serverUrl: string;
  token: string;
  /**
   * The server's sign-in socket (MR-34): every request goes there, after the socket's owner is checked; the
   * server's loopback port then isn't used for sign-ins at all.
   */
  socketPath?: string;
  /** `WHOMBAT_CREDENTIALS_ROOT`. */
  root: string;
  /** Hermes's root and executable: ChatGPT sign-ins are Hermes's own logins in its profiles (hermes-native.md HN-03). */
  hermes?: { root?: string; bin?: string };
  fetchImpl?: typeof fetch;
  log?: (level: 'warn' | 'info', msg: string) => void;
  /** Tests: the CLIs, the plugin's ChatGPT steps and the free key check. */
  commands?: { claude?: string; gh?: string; chatgpt?: readonly string[] };
  verifyFetch?: (url: string, init: RequestInit) => Promise<Pick<Response, 'status'>>;
  /** The installed clients' executables (CT-72); null: not installed. */
  resolveClient?: (provider: 'claude') => string | null;
  /** Tests: the host environment the sign-in CLIs take PATH and the locale from. */
  hostEnv?: NodeJS.ProcessEnv;
  /** Tests: the first retry delay of a failed console report (doubles up to `CONSOLE_RETRY_MAX_MS`). */
  consoleRetryMs?: number;
  /** Where usage probes run (managed: a task sandbox, `managedUsageHost`; UI-R05). */
  usageHost?: (job: UsageHostJob) => Promise<UsageProbeHost>;
  /**
   * A sign-in changed — a sign-out, a key or token, a finished device or console sign-in (hermes-native.md HN-W11): the
   * person's pod lets its Hermes go once idle.
   */
  onLoginChange?: () => void;
}

export class SignInWorker {
  readonly executor: LocalSignInExecutor;
  private stopped = false;
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  /** Console events not yet accepted by the server, in order. */
  private readonly consoleQueue: ConsoleSignInEvent[] = [];
  /** The device logins and consoles running, until they end (`onLoginChange`). */
  private readonly running = new Set<string>();
  private consoleFlush: Promise<void> | null = null;

  constructor(private readonly options: SignInWorkerOptions) {
    this.executor = new LocalSignInExecutor({
      root: options.root,
      ...(options.hermes ? { hermes: options.hermes } : {}),
      ...(options.commands ? { commands: options.commands } : {}),
      ...(options.verifyFetch ? { fetch: options.verifyFetch } : {}),
      ...(options.resolveClient ? { resolveClient: options.resolveClient } : {}),
      ...(options.hostEnv ? { hostEnv: options.hostEnv } : {}),
      ...(options.usageHost ? { usageHost: options.usageHost } : {}),
      onDeviceDone: (done) => {
        this.ended(done.loginId, done.ok);
        void this.post('event', { done }).catch(() => {});
      },
      onConsoleEvent: (event) => {
        if (event.kind === 'exit') this.ended(event.consoleId, event.state === 'completed');
        this.queueConsoleEvent(event);
      },
    });
  }

  /** A device login or a console ended: when it signed the person in, their sign-in changed. */
  private ended(id: string, changed: boolean): void {
    const known = this.running.delete(id);
    if (known && changed) this.options.onLoginChange?.();
  }

  private queueConsoleEvent(event: ConsoleSignInEvent): void {
    this.consoleQueue.push(event);
    this.flushConsoleEvents();
  }

  /** Reports queued console events, in order; a failed report is retried with the same events, none dropped. */
  private flushConsoleEvents(): void {
    if (this.consoleFlush) return;
    this.consoleFlush = (async () => {
      let delay = this.options.consoleRetryMs ?? 500;
      while (this.consoleQueue.length > 0) {
        const { events, taken } = consoleBatch(this.consoleQueue);
        let unknown: string[];
        try {
          const answer = runnerApi.signinConsole.response.safeParse(await this.post('console', { events }));
          unknown = answer.success ? answer.data.unknown : [];
        } catch (err) {
          // Only the status or the transport error: never the events (output may echo what the person typed).
          this.options.log?.(
            'warn',
            `sign-in console report failed: ${err instanceof Error ? err.message : 'error'}`,
          );
          if (this.stopped) return;
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, CONSOLE_RETRY_MAX_MS);
          continue;
        }
        this.consoleQueue.splice(0, taken);
        delay = this.options.consoleRetryMs ?? 500;
        // Consoles the server no longer knows are stopped; their exit is still reported (and ignored there).
        for (const id of new Set(unknown)) void this.executor.consoleStop(id, 'cancelled').catch(() => {});
      }
    })().finally(() => {
      this.consoleFlush = null;
      // An event queued between the loop's last look and here still goes out.
      if (this.consoleQueue.length > 0 && !this.stopped) this.flushConsoleEvents();
    });
  }

  private async post(
    path: 'poll' | 'answer' | 'event' | 'console',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const doFetch =
      this.options.fetchImpl ??
      (this.options.socketPath ? signInSocketFetch(this.options.socketPath) : fetch);
    const res = await doFetch(new URL(`/internal/runner/signin/${path}`, this.options.serverUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`sign-in ${path} answered ${res.status}`);
    return res.json();
  }

  /** Runs one request (exported for tests). */
  async handle(req: SignInRequest): Promise<unknown> {
    const schema = SIGNIN_METHODS[req.method];
    if (!schema) throw new Error(`unknown sign-in method ${String(req.method)}`);
    // The contract's params for the method (CT-39): ids and paths are checked before any home is touched.
    const p = schema.params.parse(req.params) as Record<string, unknown>;
    switch (req.method) {
      case 'submitSecret':
        return this.executor.submitSecret(p as unknown as SecretSignIn).then((result) => {
          if (result.ok) this.options.onLoginChange?.();
          return result;
        });
      case 'startDevice':
        this.running.add(String(p.loginId));
        return this.executor.startDevice(p as unknown as SignInTarget);
      case 'cancel':
        return this.executor.cancel(String(p.loginId)).then(() => null);
      case 'logout':
        return this.executor
          .logout(p.provider as CredentialProvider)
          .finally(() => this.options.onLoginChange?.());
      case 'list':
        return this.executor.list();
      case 'githubToken':
        return this.executor.githubToken();
      case 'consoleStart':
        this.running.add(String(p.consoleId));
        return this.executor.consoleStart(p as unknown as ConsoleStartJob);
      case 'consoleInput':
        return this.executor.consoleInput(String(p.consoleId), String(p.data));
      case 'consoleResize':
        return this.executor.consoleResize(String(p.consoleId), Number(p.cols), Number(p.rows));
      case 'usageProbe':
        return this.executor.usageProbe(p.provider as UsageProvider);
      case 'consoleStop':
        return this.executor
          .consoleStop(String(p.consoleId), p.reason === 'expired' ? 'expired' : 'cancelled')
          .then(() => null);
      default:
        throw new Error(`unknown sign-in method ${String(req.method)}`);
    }
  }

  private async answer(req: SignInRequest): Promise<void> {
    let body: unknown;
    try {
      body = { id: req.id, ok: true, result: await this.handle(req) };
    } catch (err) {
      body = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await this.post('answer', body).catch((err) =>
      this.options.log?.('warn', `sign-in answer failed: ${String(err)}`),
    );
  }

  start(): void {
    this.loop ??= (async () => {
      while (!this.stopped) {
        try {
          const started = Date.now();
          const { requests } = (await this.post('poll', { waitMs: 25_000 }, this.controller.signal)) as {
            requests: SignInRequest[];
          };
          for (const req of requests) void this.answer(req);
          // A long poll that came back empty at once (a server that doesn't hold it) must not become a busy loop.
          if (requests.length === 0 && Date.now() - started < MIN_EMPTY_POLL_MS && !this.stopped)
            await new Promise((r) => setTimeout(r, MIN_EMPTY_POLL_MS));
        } catch (err) {
          if (this.stopped) break;
          this.options.log?.('warn', `sign-in poll failed: ${String(err)}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    // Stops every console; their exits are reported once more (not retried: the server expires what it misses).
    await this.executor.close();
    await Promise.race([
      this.consoleFlush?.catch(() => {}),
      new Promise((r) => setTimeout(r, 3_000).unref?.()),
    ]);
    await this.loop?.catch(() => {});
  }
}
