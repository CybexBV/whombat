/**
 * When the 1Password sync runs (docs/decisions/onepassword-sync.md OPW-20): one pass at a time, when the server starts
 * read-write, every 10 minutes, 10 seconds after a change to a Vault entry (a few changes make one pass), and on Sync
 * now; reasons that come together make one pass. Never in read-only mode, during a maintenance pause, drain or
 * quarantine: the next reason after it ends runs one. Home's health and the connection page read the stored state and
 * never wait for a pass.
 */
import { join } from 'node:path';
import { defaultWhombatHome } from '@whombat/agent-runtime/host';
import { ONEPASSWORD_CHANGE_DELAY_MS, ONEPASSWORD_PASS_EVERY_MS } from '@whombat/core';
import { outsideCommandScope } from '../../commit/scope';
import { onConnectionLifecycle } from '../../connections/lifecycle';
import type { Services } from '../../services';
import { runOnePasswordPass } from './pass';
import { type OnePasswordApi, OnePasswordPool } from './pool';
import { onePasswordConnections } from './store';
import { onePasswordStandInOn, StandInOnePassword } from './testing/standin';

const overrides = new WeakMap<Services, OnePasswordApi>();

/** Tests only: a stand-in 1Password instead of the worker. Refused outside `NODE_ENV=test`. */
export function useOnePasswordForTests(services: Services, api: OnePasswordApi): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The 1Password seam is for tests only.');
  overrides.set(services, api);
}

export class OnePasswordSync {
  readonly #services: Services;
  #pool: OnePasswordPool | null = null;
  #standIn: StandInOnePassword | null = null;
  #timer: NodeJS.Timeout | null = null;
  #dueAt: number | null = null;
  #running: Promise<void> | null = null;
  /** Another pass asked for while one ran: after how long (the shortest asked for). */
  #again: number | null = null;
  /** Entries changed while a pass ran: those the pass didn't change itself ask for another. */
  #seen = new Set<string>();
  #stops: (() => void)[] = [];
  #started = false;
  #closed = false;

  constructor(services: Services) {
    this.#services = services;
  }

  /**
   * What the pass and the check talk to: the worker, a test's stand-in, or on a development box the stand-in 1Password
   * for `ops_dev_` tokens in front of the worker (`testing/standin.ts`; never in production).
   */
  get api(): OnePasswordApi {
    const override = overrides.get(this.#services);
    if (override) return override;
    return this.standIn ?? this.#worker();
  }

  /** Development's stand-in 1Password, or null where it isn't on (always in production). */
  get standIn(): StandInOnePassword | null {
    if (!onePasswordStandInOn(this.#services.config)) return null;
    const home = defaultWhombatHome({ WHOMBAT_HOME: this.#services.config.WHOMBAT_HOME });
    this.#standIn ??= new StandInOnePassword(() => this.#worker(), {
      file: join(home, 'onepassword-standin.json'),
    });
    return this.#standIn;
  }

  #worker(): OnePasswordPool {
    this.#pool ??= new OnePasswordPool({ log: this.#services.log });
    return this.#pool;
  }

  /** Whether a pass is running or asked for (the page's `syncing`). */
  get syncing(): boolean {
    return this.#running !== null || this.#timer !== null;
  }

  /** Starts the reasons: a pass now, every 10 minutes, after a Vault change, after the connection's token changed. */
  start(): void {
    if (this.#started || this.#services.schemaAccess === 'read-only') return;
    this.#started = true;
    const services = this.#services;
    this.#stops.push(
      services.housekeeping.add(
        '1password sync',
        ONEPASSWORD_PASS_EVERY_MS,
        async () => {
          this.request(0);
        },
        { first: 'tick' },
      ),
    );
    this.#stops.push(
      services.bus.onFrame((frame) => {
        if (frame.event.type !== 'vault.updated' || !frame.event.entryId) return;
        if (this.#running) this.#seen.add(frame.event.entryId);
        else this.request(ONEPASSWORD_CHANGE_DELAY_MS);
      }),
    );
    // A new token or vault: a pass soon. A connection removed: nothing to do (its rows went with it).
    this.#stops.push(
      onConnectionLifecycle(services, (event) => {
        if (event.type === 'credential') this.request(0);
      }),
    );
  }

  /** A pass within `delayMs` (an earlier one already asked for stands). */
  request(delayMs: number): void {
    if (this.#closed || this.#services.schemaAccess === 'read-only') return;
    const due = Date.now() + Math.max(0, delayMs);
    if (this.#running) {
      // A reason while a pass runs: one more pass after it, with the shortest delay asked for.
      this.#again = Math.min(this.#again ?? delayMs, delayMs);
      return;
    }
    if (this.#timer && this.#dueAt !== null && this.#dueAt <= due) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#dueAt = due;
    // Asked for by a command (adding the connection, Sync now, a change to an entry): the pass commits as itself, never
    // as part of that command, whose receipt may be settled by then.
    this.#timer = outsideCommandScope(() => setTimeout(() => this.#fire(), Math.max(0, delayMs)));
    this.#timer.unref();
  }

  /** Runs the passes now and waits for them (tests, and Sync now's own wait when one is already running). */
  async runNow(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#dueAt = null;
    }
    if (this.#running) await this.#running;
    this.#running = this.#runAll().finally(() => {
      this.#running = null;
    });
    await this.#running;
  }

  /** Stops the reasons and the worker; a pass running finishes. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => {});
    this.#pool?.close();
  }

  #fire(): void {
    this.#timer = null;
    this.#dueAt = null;
    if (this.#running) {
      this.#again = 0;
      return;
    }
    this.#running = this.#runAll().finally(() => {
      this.#running = null;
      const again = this.#again;
      this.#again = null;
      if (again !== null) this.request(again);
    });
  }

  async #runAll(): Promise<void> {
    const services = this.#services;
    // A maintenance pause, a drain or a quarantine: no pass; the next reason after it runs one.
    if (services.schemaAccess === 'read-only' || services.maintenance.paused || services.maintenance.held)
      return;
    this.#seen.clear();
    const touched = new Set<string>();
    try {
      for (const connection of await onePasswordConnections(services.db)) {
        try {
          const outcome = await runOnePasswordPass(services, connection.id, { api: this.api, touched });
          if (outcome.ran && outcome.outcome === 'failing')
            services.log.info({ connectionId: connection.id }, '1Password sync: the pass couldn’t finish');
        } catch (err) {
          services.log.warn(
            { connectionId: connection.id, err: err instanceof Error ? err.name : 'error' },
            '1Password sync: the pass failed',
          );
        }
      }
    } finally {
      // Entries the person changed while the pass ran (not the pass's own changes) get a pass of their own.
      const theirs = [...this.#seen].some((id) => !touched.has(id));
      this.#seen.clear();
      if (theirs)
        this.#again = Math.min(this.#again ?? ONEPASSWORD_CHANGE_DELAY_MS, ONEPASSWORD_CHANGE_DELAY_MS);
    }
  }
}

const instances = new WeakMap<Services, OnePasswordSync>();

/** The process's 1Password sync (one per `Services`). */
export function onePasswordSyncFor(services: Services): OnePasswordSync {
  let found = instances.get(services);
  if (!found) {
    found = new OnePasswordSync(services);
    instances.set(services, found);
  }
  return found;
}
