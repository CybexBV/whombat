/**
 * The runner's end of the Hermes-home service's long poll (hermes-engine.md HE-38, HE-S110), as the sign-in worker's
 * (`signin.ts`): it asks the server for steps (`/internal/runner/hermes/poll`), runs each and answers
 * (`/internal/runner/hermes/answer`) — over the sign-in socket when one is configured (MR-34: the server's, checked
 * before every request), else the loopback runner API, with the runner token. Every minute it works through what
 * waits (sessions to delete, transfers to drop).
 */
import { type HermesHomeAnswer, type HermesHomeRequest, hermesHomeEndpoints } from '@whombat/core';
import { signInSocketFetch } from '../signin-socket';
import type { HermesHomeService } from './index';

/** An empty long poll that came back sooner than this waits this long before the next one. */
const MIN_EMPTY_POLL_MS = 1_000;
/** How often what waits in the background is tried again. */
const SWEEP_MS = 60_000;

export interface HermesHomeWorkerOptions {
  serverUrl: string;
  token: string;
  /** The server's sign-in socket (MR-34): every request goes there, after its owner is checked. */
  socketPath?: string;
  fetchImpl?: typeof fetch;
  log?: (level: 'warn' | 'info', msg: string) => void;
  /** Tests: a shorter sweep. */
  sweepMs?: number;
}

export class HermesHomeWorker {
  private stopped = false;
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly running = new Set<Promise<void>>();

  constructor(
    readonly service: HermesHomeService,
    private readonly options: HermesHomeWorkerOptions,
  ) {}

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const doFetch =
      this.options.fetchImpl ??
      (this.options.socketPath ? signInSocketFetch(this.options.socketPath) : fetch);
    const res = await doFetch(new URL(`/internal/runner${path}`, this.options.serverUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`hermes ${path} answered ${res.status}`);
    return res.json();
  }

  private async answer(req: HermesHomeRequest): Promise<void> {
    const answer: HermesHomeAnswer = await this.service.handle(req);
    await this.post(hermesHomeEndpoints.answer.path, answer).catch((err) =>
      this.options.log?.('warn', `hermes-home answer failed: ${String(err)}`),
    );
  }

  start(): void {
    const sweep = () => void this.service.sweep().catch(() => {});
    sweep();
    this.sweeper = setInterval(sweep, this.options.sweepMs ?? SWEEP_MS);
    this.sweeper.unref?.();
    this.loop ??= (async () => {
      while (!this.stopped) {
        try {
          const started = Date.now();
          const polled = hermesHomeEndpoints.poll.response.safeParse(
            await this.post(hermesHomeEndpoints.poll.path, { waitMs: 25_000 }, this.controller.signal),
          );
          const requests = polled.success ? polled.data.requests : [];
          for (const req of requests) {
            const task = this.answer(req).finally(() => this.running.delete(task));
            this.running.add(task);
          }
          if (requests.length === 0 && Date.now() - started < MIN_EMPTY_POLL_MS && !this.stopped)
            await new Promise((r) => setTimeout(r, MIN_EMPTY_POLL_MS));
        } catch (err) {
          if (this.stopped) break;
          this.options.log?.('warn', `hermes-home poll failed: ${String(err)}`);
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.sweeper) clearInterval(this.sweeper);
    await this.loop?.catch(() => {});
    await Promise.race([Promise.all(this.running), new Promise((r) => setTimeout(r, 3_000).unref?.())]);
    await this.service.idle();
  }
}
