/**
 * The fake hosts service's agent updates (agent-updates.md AU-03…AU-08; the build brief §2 “Agent and hub”): a signed
 * agent build, every server's agent one version older with the build's key — except shale and quartz, installed before
 * agents had one (shale lets Whombat run commands as root, so it can take its last install; quartz can't) — and the
 * offline ones not connected. `GET /agents` answers each row's `update` object with the 0.99 fields, `/agents/settings`
 * keeps “Keep server agents up to date”, and `POST /agents/update` updates a keyed agent or gives a keyless one its last
 * install, then the agent comes back on the build (at once, or when a test calls `finish`).
 *
 * Tests play the automatic round with `wait`, `finish` and `fail` (each emits `agent.update` as the hub does) and set a
 * row's fields directly. `GET /agents` is served only with `serve` on: without it the fleet's switches stay the cards'
 * as every other test expects (the hub's answer was a 404 here before).
 */
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';

/** The fixture world's build and the agents' version before it (John's agents on 2026-10-20). */
export const FAKE_AGENT_BUILD = '0.0.0-20261020080000.abc1234';
export const FAKE_AGENT_OLD = '0.0.0-20261018094703.5394c53';

/** One server's agent as the fake hub knows it. */
export interface FakeAgentRow {
  version: string;
  /** The update key it was built with: the build's (`build`), none, or another. */
  key: 'build' | 'none' | 'other';
  /** `[update] allow` in its agent.toml. */
  allow: boolean;
  state?: 'updating' | 'failed' | 'waiting' | 'halted';
  waitingFor?: 'packages' | 'console' | 'task';
  message?: string;
  failedVersion?: string;
  updatedAt?: string;
}

/** What the fake needs of the service: its fleet, details, events and clock. */
interface AgentsHost {
  fleet: Json;
  details: Record<string, Json>;
  emit(event: string, data: unknown): number;
  asOf(): string;
}

const timestampPart = (v: string) => /^0\.0\.0-(\d{14})\./.exec(v)?.[1] ?? null;

export class FakeAgents {
  /** Whether `GET /agents` answers (off by default, see the header). */
  serve = false;
  /** The hub's signed build; null: none (`no_build`). */
  build: string | null = FAKE_AGENT_BUILD;
  /** Whether an update or install comes back on the build at once (else a test calls `finish`). */
  autoFinish = true;
  readonly settings: { auto_update: boolean; halted_version: string | null } = {
    auto_update: true,
    halted_version: null,
  };
  readonly rows = new Map<string, FakeAgentRow>();
  /** A rollout running (manual or the round): another Update now is refused. */
  running = false;

  constructor(private readonly host: AgentsHost) {}

  init(): void {
    for (const s of this.host.fleet.servers as Json[]) {
      const id = String(s.id);
      this.rows.set(id, {
        version: FAKE_AGENT_OLD,
        key: id === 'shale' || id === 'quartz' ? 'none' : 'build',
        allow: true,
      });
    }
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    const api = '/api/v1';
    return [
      { method: 'GET', path: `${api}/agents`, handler: () => (this.serve ? ok(this.list()) : null) },
      { method: 'GET', path: `${api}/agents/settings`, handler: (r) => this.#settings(r) },
      { method: 'PATCH', path: `${api}/agents/settings`, handler: (r) => this.#patchSettings(r) },
      { method: 'POST', path: `${api}/agents/update`, handler: (r) => this.#update(r) },
    ];
  }

  /** `GET /agents`' rows (switches as `/servers/{id}/settings` has them, the version and the update). */
  list(): Json[] {
    return (this.host.fleet.servers as Json[]).map((s) => {
      const id = String(s.id);
      const rc = this.#switches(id);
      return {
        server_id: id,
        hostname: id,
        group: s.group,
        version: this.rows.get(id)?.version ?? null,
        connected: s.agent_connected === true,
        status: s.status,
        last_seen: s.last_seen ?? null,
        // Its first reported address (the hub's `address`), when a test gave the card one.
        address: typeof s.address === 'string' ? s.address : null,
        remote_control: rc.hub,
        agent_policy: rc.agent,
        arch: 'amd64',
        install: 'systemd',
        update: this.updateOf(id),
      };
    });
  }

  /** One server's `update` object, as the hub computes it (hosts `updateInfoFor`, 0.99). */
  updateOf(id: string): Json {
    const row = this.rows.get(id);
    const card = (this.host.fleet.servers as Json[]).find((s) => s.id === id);
    const connected = card?.agent_connected === true;
    const u: Json = {};
    const code = (() => {
      if (!this.build) return 'no_build';
      if (!row || !connected) return 'not_connected';
      if (row.version === this.build) return 'up_to_date';
      if (row.key === 'none') return 'no_key';
      if (row.key === 'other') return 'other_key';
      if (!row.allow) return 'turned_off';
      const [a, b] = [timestampPart(row.version), timestampPart(this.build)];
      if (a && b && a > b) return 'newer_running';
      return null;
    })();
    u.available = code === null;
    if (this.build) u.version = this.build;
    if (code) {
      u.reason_code = code;
      u.reason = `(${code})`;
    }
    const failedHere = row?.failedVersion !== undefined && row.failedVersion === this.build;
    const halted = this.settings.halted_version !== null && this.settings.halted_version === this.build;
    u.auto = code === null && this.settings.auto_update && !failedHere && !halted;
    if (row?.state) u.state = row.state;
    else if (halted && code === null && !failedHere) u.state = 'halted';
    if (row?.state === 'waiting' && row.waitingFor) u.waiting_for = row.waitingFor;
    if (row?.message) u.message = row.message;
    if (row?.failedVersion) u.failed_version = row.failedVersion;
    if (row?.updatedAt) u.updated_at = row.updatedAt;
    const rc = this.#switches(id);
    u.can_install =
      (code === 'no_key' || code === 'other_key') &&
      rc.hub.host_shell === true &&
      rc.agent.host_shell === true;
    return u;
  }

  /** The round found the server busy (AU-04). */
  wait(id: string, waitingFor: 'packages' | 'console' | 'task'): void {
    const row = this.rows.get(id);
    if (!row) return;
    Object.assign(row, { state: 'waiting', waitingFor });
    this.host.emit('agent.update', { server: id, state: 'waiting', message: '', waiting_for: waitingFor });
  }

  /** The agent came back on the build (an update or the last install, AU-07, which also gives it the key). */
  finish(id: string): void {
    const row = this.rows.get(id);
    if (!row || !this.build) return;
    const from = row.version;
    Object.assign(row, {
      version: this.build,
      key: 'build',
      state: undefined,
      waitingFor: undefined,
      message: undefined,
      failedVersion: undefined,
      updatedAt: this.host.asOf(),
    });
    this.running = false;
    this.host.emit('agent.update', { server: id, state: 'updated', message: '', from, to: this.build });
  }

  /** The update failed (AU-05); `halt`: it didn't come back, so automatic updates to the build stop everywhere. */
  fail(id: string, options: { halt?: boolean } = {}): void {
    const row = this.rows.get(id);
    if (!row || !this.build) return;
    Object.assign(row, {
      state: 'failed',
      failedVersion: this.build,
      message: 'the agent did not come back with the new version (it rolls back on its own)',
    });
    if (options.halt) this.settings.halted_version = this.build;
    this.running = false;
    this.host.emit('agent.update', { server: id, state: 'failed', message: row.message });
    if (options.halt) this.host.emit('agent.update', { server: id, state: 'halted', message: '' });
  }

  /** The hub's switches and the agent's policy of a server (`/servers/{id}/settings`' defaults). */
  #switches(id: string): { hub: Json; agent: Json } {
    const rc = (this.host.details[id]?.server as Json | undefined)?.remote_control as Json | undefined;
    const t = (prefix: string): Json => ({
      console: rc?.[`${prefix}console`] ?? true,
      power: rc?.[`${prefix}power`] ?? true,
      host_shell: rc?.[`${prefix}host_shell`] ?? false,
      host_power: rc?.[`${prefix}host_power`] ?? false,
      manage: rc?.[`${prefix}manage`] ?? false,
      diagnose: rc?.[`${prefix}diagnose`] ?? true,
    });
    return { hub: t(''), agent: t('agent_') };
  }

  #settings(r: FakeRequest): FakeAnswer {
    if (r.role !== 'admin') return problem(403, 'forbidden', 'Admins only.');
    return ok({ ...this.settings });
  }

  #patchSettings(r: FakeRequest): FakeAnswer {
    if (r.role !== 'admin') return problem(403, 'forbidden', 'Admins only.');
    const body = (r.body ?? {}) as Json;
    if (typeof body.auto_update !== 'boolean')
      return problem(400, 'invalid_request', 'auto_update must be true or false.');
    this.settings.auto_update = body.auto_update;
    return ok({ ...this.settings });
  }

  #update(r: FakeRequest): FakeAnswer {
    if (r.role !== 'admin') return problem(403, 'forbidden', 'Admins only.');
    if (!this.build) return problem(409, 'no_build', 'The hub has no signed agent build.');
    const asked = ((r.body ?? {}) as Json).servers;
    const ids = Array.isArray(asked) && asked.length ? asked.map(String) : [...this.rows.keys()];
    const targets: string[] = [];
    let keyless: string | null = null;
    for (const id of ids) {
      const u = this.updateOf(id);
      if (u.available === true || u.can_install === true) targets.push(id);
      else if (u.reason_code === 'no_key' || u.reason_code === 'other_key') keyless = id;
    }
    if (targets.length === 0)
      return keyless
        ? problem(409, 'needs_install', 'This agent needs its installer once, and commands are off there.')
        : problem(409, 'nothing_to_update', 'No agent can be updated.');
    if (this.running) return problem(409, 'update_running', 'An update is already running.');
    this.running = true;
    // Update now clears the server's failed mark and the halt (the brief §2).
    this.settings.halted_version = null;
    for (const id of targets) {
      const row = this.rows.get(id) as FakeAgentRow;
      Object.assign(row, { state: 'updating', failedVersion: undefined, waitingFor: undefined });
      this.host.emit('agent.update', { server: id, state: 'updating', message: `Sending ${this.build}` });
    }
    if (this.autoFinish)
      setImmediate(() => {
        for (const id of targets) this.finish(id);
      });
    return ok({ servers: targets, version: this.build }, 202);
  }
}
