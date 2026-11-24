/**
 * When the 1Password sync runs (docs/decisions/onepassword-sync.md): one pass at a time, when the server starts
 * read-write, every 10 minutes, 10 seconds after an entry is added, changed or removed (a few changes make one pass),
 * and on Sync now; reasons that come together make one pass. Only a change someone else made counts: the pass's own
 * changes carry the source `onepassword` in their signed events, and a use of an entry is no change. Even then the pass
 * asks 1Password nothing unless something waits in Whombat. Never in read-only mode, during a maintenance pause, drain
 * or quarantine: the next reason after it ends runs one. A disconnect and a drain wait for a write to 1Password going
 * on, and no pass writes after them. Home's health and the connection page read the stored state and never wait for a
 * pass.
 */
import { join } from 'node:path';
import { defaultWhombatHome } from '@whombat/agent-runtime/host';
import { ONEPASSWORD_CHANGE_DELAY_MS, ONEPASSWORD_PASS_EVERY_MS, type RealtimeEvent } from '@whombat/core';
import { outsideCommandScope } from '../../commit/scope';
import { onConnectionLifecycle } from '../../connections/lifecycle';
import { connectionRow } from '../../connections/store';
import type { Services } from '../../services';
import { onVaultReachChanged } from '../reach-changed';
import { ONEPASSWORD_SOURCE } from './commands';
import { type OnePasswordPassReason, type OnePasswordWriteGate, runOnePasswordPass } from './pass';
import { type OnePasswordApi, OnePasswordPool } from './pool';
import { ONEPASSWORD_CATALOG_ID, onePasswordConnections } from './store';
import { onePasswordStandInOn, StandInOnePassword } from './testing/standin';

const overrides = new WeakMap<Services, OnePasswordApi>();

/** Tests only: a stand-in 1Password instead of the worker. Refused outside `NODE_ENV=test`. */
export function useOnePasswordForTests(services: Services, api: OnePasswordApi): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The 1Password seam is for tests only.');
  overrides.set(services, api);
}

const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');

/** The signed events of an entry added, changed (its name, address, sign-in or key), given a new secret, or removed. */
const ENTRY_CHANGES = new Set([
  'vault.entry.added',
  'vault.entry.changed',
  'vault.entry.secret_replaced',
  'vault.entry.saved',
  'vault.entry.removed',
]);

/**
 * Whether a realtime frame is a change that asks for a pass: an entry added, changed or removed by anyone but the sync
 * itself (its own changes carry the source `onepassword`). A use of an entry, a refusal and every other event don't.
 */
export function changeStartsPass(frame: RealtimeEvent): boolean {
  if (frame.type !== 'audit.appended') return false;
  const event = frame.event;
  return ENTRY_CHANGES.has(event.type) && event.payload.source !== ONEPASSWORD_SOURCE;
}

export class OnePasswordSync implements OnePasswordWriteGate {
  readonly #services: Services;
  #pool: OnePasswordPool | null = null;
  #standIn: StandInOnePassword | null = null;
  #timer: NodeJS.Timeout | null = null;
  #dueAt: number | null = null;
  #running: Promise<void> | null = null;
  /** Another pass asked for while one ran: after how long (the shortest asked for). */
  #again: number | null = null;
  /** Why the next pass runs. */
  #asked = new Set<OnePasswordPassReason>();
  /** Writes to 1Password going on now, and those waiting for them to end (a disconnect, a drain's question). */
  #writes = 0;
  #holds = 0;
  #idle: (() => void)[] = [];
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

  /** Whether a write to 1Password is going on now (a drain waits for it). */
  get writing(): boolean {
    return this.#writes > 0;
  }

  /** A pass's write may start: not while something waits for the writes to end, nor while the box is paused. */
  enter(): boolean {
    const services = this.#services;
    if (
      this.#holds > 0 ||
      this.#closed ||
      services.schemaAccess === 'read-only' ||
      services.maintenance.paused ||
      services.maintenance.held
    )
      return false;
    this.#writes++;
    return true;
  }

  leave(): void {
    this.#writes = Math.max(0, this.#writes - 1);
    if (this.#writes === 0) for (const done of this.#idle.splice(0)) done();
  }

  /**
   * Runs `fn` once no write to 1Password is going on, and lets none start meanwhile (disconnecting: nothing is written
   * after the connection is gone). Called outside the database's write lock.
   */
  async withoutWrites<T>(fn: () => Promise<T>): Promise<T> {
    this.#holds++;
    try {
      while (this.#writes > 0) await new Promise<void>((resolve) => this.#idle.push(resolve));
      return await fn();
    } finally {
      this.#holds--;
    }
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
        // A change while a pass runs gets a pass after it.
        if (changeStartsPass(frame.event)) this.request(ONEPASSWORD_CHANGE_DELAY_MS, 'change');
      }),
    );
    // A new token or vault of the 1Password connection: a pass soon, reading in full. Other connections' don't matter.
    this.#stops.push(
      onConnectionLifecycle(services, async (event) => {
        if (event.type !== 'credential') return;
        const row = await connectionRow(services.db, event.connectionId);
        if (row?.catalogId === ONEPASSWORD_CATALOG_ID) this.request(0, 'now');
      }),
    );
    // The home networks changed: items and pairs held for an address Whombat may not reach are looked at again.
    this.#stops.push(onVaultReachChanged(services, () => this.request(0, 'network')));
  }

  /** A pass within `delayMs` (an earlier one already asked for stands), for `reason` (a regular pass by default). */
  request(delayMs: number, reason: OnePasswordPassReason = 'tick'): void {
    if (this.#closed || this.#services.schemaAccess === 'read-only') return;
    this.#asked.add(reason);
    this.#schedule(delayMs);
  }

  #schedule(delayMs: number): void {
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

  #take(): Set<OnePasswordPassReason> {
    const reasons = this.#asked;
    this.#asked = new Set();
    return reasons;
  }

  /** Runs the passes now and waits for them (tests, and Sync now's own wait when one is already running). */
  async runNow(reason: OnePasswordPassReason = 'tick'): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#dueAt = null;
    }
    if (this.#running) await this.#running;
    this.#asked.add(reason);
    await this.#start();
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
    void this.#start();
  }

  /** Runs the passes for the reasons asked; one asked for meanwhile follows it. */
  #start(): Promise<void> {
    const running = this.#runAll(this.#take()).finally(() => {
      this.#running = null;
      const again = this.#again;
      this.#again = null;
      if (again !== null) this.#schedule(again);
    });
    this.#running = running;
    return running;
  }

  /** The passes for these reasons. Never rejects: a failure is logged by its name, and the next reason tries again. */
  async #runAll(reasons: ReadonlySet<OnePasswordPassReason>): Promise<void> {
    const services = this.#services;
    try {
      // A maintenance pause, a drain or a quarantine: no pass; the next reason after it runs one.
      if (services.schemaAccess === 'read-only' || services.maintenance.paused || services.maintenance.held)
        return;
      for (const connection of await onePasswordConnections(services.db)) {
        try {
          const outcome = await runOnePasswordPass(services, connection.id, {
            api: this.api,
            reasons,
            gate: this,
          });
          if (outcome.ran && outcome.outcome === 'failing')
            services.log.info({ connectionId: connection.id }, '1Password sync: the pass couldn’t finish');
        } catch (err) {
          services.log.warn(
            { connectionId: connection.id, err: errName(err) },
            '1Password sync: the pass failed',
          );
        }
      }
    } catch (err) {
      services.log.warn({ err: errName(err) }, '1Password sync: the passes couldn’t start');
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
