/**
 * What the agent's commands may reach (docs/decisions/one-person.md OP-07, OP-S106): the runner keeps the policy of the
 * commands-network daemon (`whombat-agent-net`) and sets it over its `control.sock` whenever it changes, and again every
 * half minute (the daemon lets nothing through until it has one: a restarted daemon gets it back within that).
 *
 * - The person's home networks and “Agents may reach your local network”: the latest turn's (the burrow's settings).
 * - Production servers: every address a turn named stays closed for as long as the runner runs — a background job keeps
 *   running after its turn, and must not reach one either.
 * - Openings: a person's yes opens a production server for the command (until a minute after it ended, AC-DR16) or for
 *   the rest of the turn; they go with the turn. Each goes to the daemon with a time limit, at most `OPENING_LEASE_MS`,
 *   that every policy renews: the daemon closes it by itself when the runner stops renewing it or a removal is lost.
 *   A removal the daemon didn't take is a failure for whoever asked for it.
 */
import { type ControlAnswer, controlRequest, type NetPolicy, type Opening } from '@whombat/agent-net';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** How often the policy is set again whether it changed or not. */
const REPEAT_MS = 30_000;
/**
 * The longest an opening holds at the daemon without being renewed: three renewals, so one lost update doesn't cut a
 * command off, and a runner that stopped leaves nothing open for longer than this.
 */
export const OPENING_LEASE_MS = 3 * REPEAT_MS;

interface TurnOpenings {
  open: Map<string, Opening & { until: number | null }>;
}

export class AgentNet {
  readonly control: string;
  readonly #log: Log;
  readonly #now: () => number;
  #homeNetworks: string[] = [];
  #lan = false;
  readonly #production = new Set<string>();
  readonly #turns = new Map<string, TurnOpenings>();
  #pushing: Promise<ControlAnswer> | null = null;
  #again = false;
  #failing = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: { control: string; log: Log; now?: () => number }) {
    this.control = options.control;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
  }

  /** Sets the policy now and every half minute after. */
  start(): void {
    void this.push();
    this.#timer ??= setInterval(() => void this.push(), REPEAT_MS);
    this.#timer.unref?.();
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** A turn's network settings (its dispatch's): the home networks, the local network, its production servers. */
  async turn(
    id: string,
    settings: { homeNetworks: readonly string[]; lan: boolean; production: readonly string[] },
  ) {
    this.#homeNetworks = [...new Set(settings.homeNetworks)];
    this.#lan = settings.lan;
    for (const a of settings.production) this.#production.add(a);
    if (!this.#turns.has(id)) this.#turns.set(id, { open: new Map() });
    await this.push();
  }

  /**
   * More production addresses to keep closed (a server name that answered after its turn started). Only adds: the
   * latest turn's home networks and local network stay as they are.
   */
  async closeProduction(addresses: readonly string[]): Promise<void> {
    const before = this.#production.size;
    for (const a of addresses) this.#production.add(a);
    if (this.#production.size !== before) await this.push();
  }

  /** Opens production addresses for a turn's command (`until`: when a “once” opening closes; null: with the turn). */
  async open(id: string, openings: readonly Opening[], until: number | null = null): Promise<string[]> {
    const t = this.#turns.get(id) ?? { open: new Map() };
    this.#turns.set(id, t);
    const keys: string[] = [];
    for (const o of openings) {
      const key = `${o.address}:${o.port ?? '*'}`;
      const had = t.open.get(key);
      // A wider scope already holds it: leave it.
      if (had && had.until === null) continue;
      t.open.set(key, { ...o, until });
      keys.push(key);
    }
    if (keys.length) await this.push();
    return keys;
  }

  /**
   * A “once” opening closes a while after its command ended: the daemon is told when, and closes it then by itself.
   * Rejects when the daemon didn't take that.
   */
  async closeAt(id: string, keys: readonly string[], until: number): Promise<void> {
    const t = this.#turns.get(id);
    if (!t) return;
    for (const k of keys) {
      const o = t.open.get(k);
      if (o) t.open.set(k, { ...o, until });
    }
    await this.#revoke();
    const timer = setTimeout(() => void this.push(), Math.max(0, until - this.#now()) + 10);
    timer.unref?.();
  }

  /** The turn ended: its openings go. Rejects when the daemon didn't take that (they lapse there within the lease). */
  async drop(id: string): Promise<void> {
    if (!this.#turns.delete(id)) return;
    await this.#revoke();
  }

  /** The policy as the daemon gets it now. */
  policy(): NetPolicy {
    const now = this.#now();
    const open = new Map<string, NetPolicy['open'][number]>();
    for (const t of this.#turns.values())
      for (const [k, o] of t.open) {
        if (o.until !== null && o.until <= now) continue;
        // With the turn or while its command runs: the lease, renewed with every policy; else until it closes.
        const ttlMs = Math.ceil(Math.min(OPENING_LEASE_MS, (o.until ?? Number.POSITIVE_INFINITY) - now));
        const had = open.get(k);
        if (!had || had.ttlMs < ttlMs) open.set(k, { address: o.address, port: o.port, ttlMs });
      }
    return {
      homeNetworks: this.#homeNetworks,
      lan: this.#lan,
      production: [...this.#production],
      open: [...open.values()],
    };
  }

  /** Sets the policy (one request at a time; a change meanwhile sends it once more). Logs a failure, never rejects. */
  async push(): Promise<void> {
    await this.#send();
  }

  /** Sets the policy after something closed: rejects when the daemon didn't take it. */
  async #revoke(): Promise<void> {
    const answer = await this.#send();
    if (!answer.ok) throw new Error(`the commands' network didn't take the change (${answer.error})`);
  }

  /** The daemon's answer to the latest policy sent (the one carrying every change made before this call). */
  #send(): Promise<ControlAnswer> {
    if (this.#pushing) {
      this.#again = true;
      return this.#pushing;
    }
    const pushing = (async () => {
      let answer: ControlAnswer;
      do {
        this.#again = false;
        answer = await controlRequest(this.control, { op: 'policy', policy: this.policy() }).catch(
          (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
        );
        if (!answer.ok && !this.#failing)
          this.#log('warn', `commands' network · the policy couldn't be set (${answer.error})`);
        if (answer.ok && this.#failing) this.#log('info', `commands' network · the policy is set again`);
        this.#failing = !answer.ok;
      } while (this.#again);
      return answer;
    })().finally(() => {
      this.#pushing = null;
    });
    this.#pushing = pushing;
    return pushing;
  }
}
