/**
 * The claim loop: long-poll `/internal/runner/claim` while below the concurrency limit, run each claimed
 * dispatch as a provider turn, heartbeat the dispatches in flight (the server answers which to drop), and
 * on shutdown abort every turn — handing their dispatches back to the queue — before exiting.
 */
import { type CleanupResult, WorkspaceManager } from '@whombat/agent-runtime';
import { shownPath } from '@whombat/agent-runtime/host';
import { newId } from '@whombat/core';
import type { RunnerApi } from './api';
import { gatewaySwitchesOf, type ProviderRegistry } from './registry';
import { runDispatch, type TurnDeps, type TurnOutcome } from './turn';
import { agentHomeOf, type RunnerHost, removeStaleStepFolders } from './workspace';

/** An automation step's own folder older than this was left by a turn that never ended (AR-43). */
const STALE_STEP_FOLDER_MS = 2 * 86_400_000;

export interface RunnerOptions {
  api: RunnerApi;
  registry: ProviderRegistry;
  serverUrl: string;
  workspacesRoot: string;
  /** The host: home and `WHOMBAT_HOME` (default: from the environment). */
  host?: RunnerHost;
  concurrency?: number;
  /** Checked before claiming work, so pressure leaves the task queued without spending its lease. */
  admit?: (active: number) => Promise<{ allowed: boolean; reason: string }>;
  runnerId?: string;
  name?: string;
  /** Long-poll window per claim. */
  waitMs?: number;
  heartbeatMs?: number;
  progressMs?: number;
  log?: TurnDeps['log'];
  connectMcp?: TurnDeps['connectMcp'];
  /** Called after each turn (tests, metrics). */
  onTurn?: (dispatchId: string, outcome: TurnOutcome) => void;
  /**
   * Workspace cleanup (`WorkspaceManager.cleanup`): once at start, then every `intervalMs` (default a day).
   * Removes merged workspaces idle for `mergedAfterMs` (default a day) and any idle for `olderThanMs`, never
   * uncommitted or unpushed work; logs what it removed and what it kept. Off when absent.
   */
  cleanup?: { olderThanMs: number; mergedAfterMs?: number; intervalMs?: number };
  /** The execution policy (MA-10): the task sandbox every live turn runs in. */
  managed: TurnDeps['managed'];
  /** The installed AI clients (SUB-09). */
  clients?: TurnDeps['clients'];
  /** The agent's commands (one-person.md OP-07). */
  commands?: TurnDeps['commands'];
  /** The cache of the conversations' Files (files-space.md FS-09). */
  filesCache?: TurnDeps['filesCache'];
  /** The people's pods (hermes-native.md HN-09). */
  pods?: TurnDeps['pods'];
}

interface Active {
  controller: AbortController;
  done: Promise<void>;
  /** The provider session the turn resumes, if any: never pruned while it runs (BH-06). */
  session: string | null;
}

/** The claim waiting at the server, and what it asked for (SUB-53). */
interface Claiming {
  key: string;
  controller: AbortController;
  /** Ended because a re-check changed what this runner can run: claim again at once. */
  restarted: boolean;
}

/** What a claim asks for: its providers, in a comparable form. */
const claimKey = (providers: readonly string[]): string => JSON.stringify([...providers].sort());

const quiet: TurnDeps['log'] = () => {};

export class Runner {
  readonly runnerId: string;
  private readonly active = new Map<string, Active>();
  private readonly stopping = new AbortController();
  private loop: Promise<void> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleaning: Promise<CleanupResult | null> | null = null;
  private checking = false;
  private claiming: Claiming | null = null;
  private readonly log: TurnDeps['log'];

  constructor(private readonly options: RunnerOptions) {
    this.runnerId = options.runnerId ?? newId('runner');
    this.log = options.log ?? quiet;
  }

  get inFlight(): string[] {
    return [...this.active.keys()];
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.claimLoop();
    // The first beat right away: the server learns which providers this host has without waiting.
    void this.beat();
    this.heartbeat = setInterval(() => void this.beat(), this.options.heartbeatMs ?? 10_000);
    this.heartbeat.unref?.();
    if (this.options.cleanup) {
      void this.cleanup();
      this.cleanupTimer = setInterval(
        () => void this.cleanup(),
        this.options.cleanup.intervalMs ?? 86_400_000,
      );
      this.cleanupTimer.unref?.();
    }
  }

  /** One cleanup pass over the workspaces (one at a time); null when cleanup is off or it failed. */
  cleanup(): Promise<CleanupResult | null> {
    const settings = this.options.cleanup;
    if (!settings) return Promise.resolve(null);
    this.cleaning ??= (async () => {
      const shown = (path: string) => (this.options.host ? shownPath(path, this.options.host.home) : path);
      try {
        const result = await new WorkspaceManager({ root: this.options.workspacesRoot }).cleanup({
          olderThanMs: settings.olderThanMs,
          ...(settings.mergedAfterMs !== undefined ? { mergedAfterMs: settings.mergedAfterMs } : {}),
        });
        for (const path of result.removed) this.log('info', `cleanup · removed ${shown(path)}`);
        for (const kept of result.kept)
          this.log('info', `cleanup · kept ${shown(kept.path)}: ${kept.reason}`);
        // Automation steps' own folders a turn left behind when the runner stopped mid-turn (AR-43).
        const home = this.options.host ? agentHomeOf(this.options.host) : null;
        const stale = home ? await removeStaleStepFolders(home, STALE_STEP_FOLDER_MS) : [];
        for (const path of stale) this.log('info', `cleanup · removed ${shown(path)}`);
        return result;
      } catch (err) {
        this.log('warn', 'cleanup failed', { err: String(err) });
        return null;
      } finally {
        this.cleaning = null;
      }
    })();
    return this.cleaning;
  }

  private async claimLoop(): Promise<void> {
    const limit = this.options.concurrency ?? 4;
    let backoff = 500;
    let capacityReason = '';
    // After a failed claim (the server restarting or away) the server may not know this runner any more: it hears what
    // the runner runs first, or a scripted Hermes' turn would be handed out for a sign-in it doesn't need (HE-46).
    let beatFirst = false;
    while (!this.stopping.signal.aborted) {
      if (this.active.size >= limit) {
        await Promise.race([...this.active.values()].map((a) => a.done));
        continue;
      }
      let claim: Claiming | null = null;
      try {
        const admission = await this.options.admit?.(this.active.size);
        if (admission && !admission.allowed) {
          if (capacityReason !== admission.reason) this.log('info', admission.reason);
          capacityReason = admission.reason;
          await sleep(5_000, this.stopping.signal);
          continue;
        }
        if (capacityReason) this.log('info', 'capacity available; resuming queued work');
        capacityReason = '';
        const providers = this.options.registry.claims();
        if (providers.length === 0) {
          // Live mode with neither Claude Code nor Codex ready: nothing to claim until a re-check finds one.
          await sleep(2_000, this.stopping.signal);
          continue;
        }
        // The server learns what this runner can run from its claims only, and a claim waits up to `waitMs`:
        // a re-check that changes the list ends this one (`reclaimIfChanged`), so a provider that just became
        // ready (a client the manager installed) is claimable at once, not after the wait (SUB-53).
        if (beatFirst) beatFirst = !(await this.beat());
        claim = {
          key: claimKey(providers),
          controller: new AbortController(),
          restarted: false,
        };
        this.claiming = claim;
        const ctx = await this.options.api.claim(
          {
            runnerId: this.runnerId,
            providers,
            waitMs: this.options.waitMs ?? 25_000,
            ...(this.options.name ? { name: this.options.name } : {}),
          },
          AbortSignal.any([this.stopping.signal, claim.controller.signal]),
        );
        backoff = 500;
        if (ctx) this.launch(ctx);
      } catch (err) {
        if (this.stopping.signal.aborted) break;
        if (claim?.restarted) continue;
        beatFirst = true;
        this.log('warn', `claim failed, retrying in ${backoff} ms`, { err: String(err) });
        await sleep(backoff, this.stopping.signal);
        backoff = Math.min(backoff * 2, 10_000);
      } finally {
        if (this.claiming === claim) this.claiming = null;
      }
    }
  }

  private launch(ctx: Parameters<typeof runDispatch>[0]): void {
    const id = ctx.dispatch.id;
    // The server handed this dispatch out again (its lease ran out while this runner couldn't reach it) while its last
    // run here is still ending: that run is over, and its end must not drop the new one from what this runner runs.
    this.active.get(id)?.controller.abort('cancelled');
    const controller = new AbortController();
    this.log('info', `${ctx.agent.name} · ${ctx.dispatch.trigger} in ${ctx.conversation.title}`, {
      dispatchId: id,
    });
    const done = runDispatch(
      ctx,
      {
        api: this.options.api,
        registry: this.options.registry,
        serverUrl: this.options.serverUrl,
        workspacesRoot: this.options.workspacesRoot,
        ...(this.options.host ? { host: this.options.host } : {}),
        log: this.log,
        ...(this.options.progressMs ? { progressMs: this.options.progressMs } : {}),
        ...(this.options.connectMcp ? { connectMcp: this.options.connectMcp } : {}),
        managed: this.options.managed,
        ...(this.options.clients ? { clients: this.options.clients } : {}),
        ...(this.options.commands ? { commands: this.options.commands } : {}),
        ...(this.options.filesCache ? { filesCache: this.options.filesCache } : {}),
        ...(this.options.pods ? { pods: this.options.pods } : {}),
      },
      controller.signal,
    )
      .then((outcome) => {
        this.log(
          'info',
          `${ctx.agent.name} · ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ''}`,
          {
            dispatchId: id,
          },
        );
        this.options.onTurn?.(id, outcome);
      })
      .catch((err) => this.log('error', 'turn failed', { dispatchId: id, err: String(err) }))
      .finally(() => {
        if (this.active.get(id) === entry) this.active.delete(id);
      });
    const entry: Active = { controller, done, session: ctx.dispatch.providerSessionId ?? null };
    this.active.set(id, entry);
  }

  /**
   * Runner liveness; the server lists dispatches this runner must stop (cancelled, taken over, not ours), and says which
   * providers' turns go through the burrow's AI gateway (AIG-16): a change ends the waiting claim, like a re-check that
   * changed the providers (SUB-53).
   */
  /** One heartbeat; whether the server answered it. */
  async beat(): Promise<boolean> {
    try {
      const status = this.options.registry.status?.();
      const response = await this.options.api.heartbeat({
        runnerId: this.runnerId,
        active: this.inFlight,
        ...(status ? { status } : {}),
      });
      const { cancel, recheck } = response;
      for (const id of cancel) this.active.get(id)?.controller.abort('cancelled');
      const switches = gatewaySwitchesOf(response);
      if (this.options.registry.setGateway?.(switches)) {
        const on = (['claude', 'codex'] as const).filter((p) => switches?.[p]);
        this.log(
          'info',
          `AI gateway: claiming ${this.options.registry.claims().join(', ') || 'nothing'} (switched on: ${on.join(', ') || 'none'})`,
        );
        this.reclaimIfChanged();
      }
      void this.recheck(recheck === true);
      return true;
    } catch (err) {
      this.log('warn', 'heartbeat failed', { err: String(err) });
      return false;
    }
  }

  /**
   * Checks the providers again when due (or now, when someone pressed “Check again”) and reports a change
   * right away instead of at the next beat. One check at a time.
   */
  private async recheck(force: boolean): Promise<void> {
    const registry = this.options.registry;
    if (!registry.recheck || this.checking || this.stopping.signal.aborted) return;
    this.checking = true;
    try {
      const changed = await registry.recheck({ force });
      this.reclaimIfChanged();
      if (changed.length > 0 || force) await this.beat();
    } catch (err) {
      this.log('warn', 'provider check failed', { err: String(err) });
    } finally {
      this.checking = false;
    }
  }

  /**
   * Ends the waiting claim when it no longer asks for what this runner can run (a provider became ready or went
   * away), so the loop claims again with the new list right away (SUB-53). A dispatch the server leased in the
   * same instant is not lost: the server ends a claim whose runner hung up, and a lease nobody renews expires.
   */
  private reclaimIfChanged(): void {
    const claim = this.claiming;
    if (!claim || claim.restarted) return;
    const registry = this.options.registry;
    if (claimKey(registry.claims()) === claim.key) return;
    claim.restarted = true;
    claim.controller.abort('claims changed');
  }

  /** Graceful shutdown: stop claiming, abort every turn (their dispatches go back to the queue), wait. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const a of this.active.values()) a.controller.abort('shutdown');
    const all = Promise.all([this.loop, ...[...this.active.values()].map((a) => a.done)]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  }
}

/**
 * Waits `ms`, or until `signal` aborts. The claim loop sleeps on the runner's own signal, which lives as long as the
 * runner: a sleep that ends leaves no listener on it.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
