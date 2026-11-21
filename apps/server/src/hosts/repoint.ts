/**
 * Point servers at this Whombat (docs/decisions/backup-file.md BF-15, BF-16; backup-file.md BF-S35…BF-S38): for each
 * server, its address from the hosts service, the person's own Vault SSH servers with that host, then Sign in once
 * with that key (`install.ts`, `vault/ssh-signin.ts`) as a repoint — the installer updates the agent in place to this
 * Whombat's agents' address, keeps its identity and its own lock, and the hub's switches stay. A server without such a
 * key is `no_key` (the person points it by hand: Add a server, filled in). A server that is connected already is
 * `pointed` without signing in.
 *
 * Jobs live in this process's memory like install jobs (SI-S01): one running per burrow, kept 30 minutes after they
 * end, two servers at a time. Each change is a `hosts.repoint` frame on `hosts:<burrowId>`; each server's install has
 * its own `hosts.install` frames.
 */
import { randomBytes } from 'node:crypto';
import type {
  HostControlLevel,
  HostInstall,
  HostInstallErrorCode,
  HostRepointServerState,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { vaultEntries, vaultSshServers } from '../db/schema/index';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { vaultSecretAad } from '../vault/store';
import type { HostsActor } from './client';
import { addressText, levelOfSwitches, type SwitchSet } from './hub';
import { installsFor } from './install';
import { arr, obj, str } from './map';
import { HOSTS_TEXT, hostsFor } from './service';

/** Where one server is in a repoint. */
export type RepointServerState = HostRepointServerState;

export interface RepointServer {
  id: string;
  name: string;
  /** Its own address as its agent last reported it (for Add a server, filled in). */
  address: string | null;
  state: RepointServerState;
  error: { code: HostInstallErrorCode; message: string } | null;
  /** The install job that signed in to it, when one did. */
  installId: string | null;
}

/** A repoint job as the person reads it (contracts 0.117.0's `HostRepoint`). */
export interface RepointView {
  id: string;
  /** This Whombat's agents' address as people read it (“10.100.1.158”); null when the hub didn't say. */
  to: string | null;
  state: 'running' | 'done';
  servers: RepointServer[];
  startedAt: string;
  finishedAt: string | null;
}

export interface RepointPlan {
  burrowId: string;
  personId: string;
  actor: HostsActor;
  servers: readonly string[];
}

/** One repoint already runs in this burrow. */
export class RepointBusy extends Error {
  constructor() {
    super('repoint_running');
    this.name = 'RepointBusy';
  }
}

/** Words of a repoint the server knows better than the install's (BF-S38). */
export const REPOINT_TEXT = {
  busy: 'Whombat is pointing your servers here already. Wait for it to finish.',
  gone: (name: string) => `${name} isn’t one of your servers any more.`,
} as const;

export interface RepointTiming {
  /** Servers signed in to at once. */
  concurrency: number;
  /** How long a finished job stays readable. */
  keepMs: number;
}

export const REPOINT_TIMING: Readonly<RepointTiming> = { concurrency: 2, keepMs: 30 * 60_000 };

interface Job {
  view: RepointView;
  burrowId: string;
  personId: string;
  actor: HostsActor;
  finished: number | null;
  done: Promise<void>;
}

/** An agent row of `/agents`, the parts a repoint reads. */
export interface AgentRow {
  id: string;
  name: string;
  address: string | null;
  connected: boolean;
  hub: SwitchSet | null;
  agent: SwitchSet | null;
}

export function toAgentRow(raw: unknown): AgentRow | null {
  const a = obj(raw);
  const id = str(a.server_id);
  if (!id) return null;
  const address = str(a.address)?.trim() || null;
  return {
    id,
    name: str(a.hostname)?.trim() || id,
    address: address ? address.replace(/\/\d{1,3}$/, '') : null,
    connected: a.connected === true,
    hub: a.remote_control && typeof a.remote_control === 'object' ? (a.remote_control as SwitchSet) : null,
    agent: a.agent_policy && typeof a.agent_policy === 'object' ? (a.agent_policy as SwitchSet) : null,
  };
}

/** A Vault SSH server a repoint may sign in with. */
export interface KeyServer {
  entryId: string;
  host: string;
  port: number;
  username: string;
  trusted: boolean;
}

/**
 * The person's Vault SSH server for a server (BF-S37): the one whose host is the server's address, else its host name
 * (or a name under it, `pve-03.lan`); among those, one with a trusted host key first, then `root`. Null without one.
 */
export function pickKeyServer(
  candidates: readonly KeyServer[],
  server: { address: string | null; name: string; id: string },
): KeyServer | null {
  const address = server.address?.toLowerCase() ?? null;
  const names = [server.name.toLowerCase(), server.id.toLowerCase()];
  const rank = (k: KeyServer): number => {
    const host = k.host.toLowerCase();
    if (address && host === address) return 0;
    if (names.includes(host)) return 1;
    if (names.some((n) => host.startsWith(`${n}.`))) return 2;
    return -1;
  };
  const hits = candidates
    .map((k) => ({ k, r: rank(k) }))
    .filter((x) => x.r >= 0)
    .sort(
      (a, b) =>
        a.r - b.r ||
        Number(b.k.trusted) - Number(a.k.trusted) ||
        Number(b.k.username === 'root') - Number(a.k.username === 'root'),
    );
  return hits[0]?.k ?? null;
}

/** The address as Sign in once reads it: `host` or `host:port`, IPv6 in brackets with a port. */
export function signInAddress(host: string, port: number): string {
  if (port === 22) return host;
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export class HostRepoints {
  readonly #jobs = new Map<string, Job>();
  timing: RepointTiming = { ...REPOINT_TIMING };

  constructor(private readonly services: Services) {}

  #sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.#jobs)
      if (job.finished !== null && now - job.finished > this.timing.keepMs) this.#jobs.delete(id);
  }

  /** The running job of a burrow, if there is one. */
  running(burrowId: string): RepointView | null {
    this.#sweep();
    for (const job of this.#jobs.values())
      if (job.burrowId === burrowId && job.finished === null) return { ...job.view };
    return null;
  }

  /** The person's own job (another person's is missing, like an install's, SI-S09). */
  get(id: string, personId: string): RepointView | null {
    this.#sweep();
    const job = this.#jobs.get(id);
    return job && job.personId === personId ? snapshot(job.view) : null;
  }

  /** The job once it ended. */
  async finished(id: string): Promise<RepointView | null> {
    const job = this.#jobs.get(id);
    if (!job) return null;
    await job.done;
    return snapshot(job.view);
  }

  /**
   * Starts a job (it runs in the background) once it knows this Whombat's agents' address; `RepointBusy` when one runs
   * in the burrow.
   */
  async start(plan: RepointPlan): Promise<RepointView> {
    this.#sweep();
    if (this.running(plan.burrowId)) throw new RepointBusy();
    const hub = await hostsFor(this.services).hub();
    if (this.running(plan.burrowId)) throw new RepointBusy();
    const now = iso(this.services.clock());
    const ids = [...new Set(plan.servers.map((s) => s.trim()).filter(Boolean))];
    const job: Job = {
      view: {
        id: `hrp_${randomBytes(12).toString('base64url')}`,
        to: hub.agentUrl ? addressText(hub.agentUrl) : null,
        state: 'running',
        servers: ids.map((id) => ({
          id,
          name: id,
          address: null,
          state: 'waiting',
          error: null,
          installId: null,
        })),
        startedAt: now,
        finishedAt: null,
      },
      burrowId: plan.burrowId,
      personId: plan.personId,
      actor: plan.actor,
      finished: null,
      done: Promise.resolve(),
    };
    this.#jobs.set(job.view.id, job);
    job.done = this.#run(job).catch((err: unknown) => {
      this.services.log.warn({ err: err instanceof Error ? err.message : 'error' }, 'hosts: a repoint broke');
      for (const s of job.view.servers)
        if (s.state === 'waiting' || s.state === 'pointing')
          Object.assign(s, { state: 'failed', error: { code: 'failed', message: HOSTS_TEXT.down } });
      this.#finish(job);
    });
    return snapshot(job.view);
  }

  #publish(job: Job): void {
    this.services.bus.publish({
      topic: `hosts:${job.burrowId}`,
      // The apps refetch the job (CT-911).
      event: { type: 'hosts.repoint', repointId: job.view.id, state: job.view.state },
      eventId: null,
      at: iso(this.services.clock()),
      outboxId: null,
    });
  }

  #set(job: Job, server: RepointServer, change: Partial<RepointServer>): void {
    Object.assign(server, change);
    this.#publish(job);
  }

  #finish(job: Job): void {
    if (job.finished !== null) return;
    job.view.state = 'done';
    job.view.finishedAt = iso(this.services.clock());
    job.finished = Date.now();
    this.#publish(job);
  }

  async #run(job: Job): Promise<void> {
    const hosts = hostsFor(this.services);
    hosts.forget('agents');
    const agents = new Map(
      arr(await hosts.agentsRaw())
        .map(toAgentRow)
        .filter((a): a is AgentRow => a !== null)
        .map((a) => [a.id.toLowerCase(), a] as const),
    );
    const keys = await this.#keyServers(job);
    const queue = [...job.view.servers];
    const worker = async () => {
      for (let server = queue.shift(); server; server = queue.shift())
        await this.#one(job, server, agents.get(server.id.toLowerCase()) ?? null, keys);
    };
    await Promise.all(Array.from({ length: Math.max(1, this.timing.concurrency) }, worker));
    hosts.forget('fleet', 'agents');
    this.#finish(job);
  }

  /** The person's own Vault SSH servers whose keys can sign in (sealed SSH entries of theirs, in this burrow). */
  async #keyServers(job: Job): Promise<KeyServer[]> {
    const rows = await this.services.db
      .select({
        entryId: vaultSshServers.entryId,
        host: vaultSshServers.host,
        port: vaultSshServers.port,
        username: vaultSshServers.username,
        trustedAt: vaultSshServers.hostKeyTrustedAt,
        sealed: vaultEntries.sealed,
        kind: vaultEntries.kind,
      })
      .from(vaultSshServers)
      .innerJoin(vaultEntries, eq(vaultEntries.id, vaultSshServers.entryId))
      .where(and(eq(vaultSshServers.burrowId, job.burrowId), eq(vaultEntries.ownerId, job.personId)));
    return rows
      .filter((r) => r.kind === 'ssh' && !!r.sealed)
      .map((r) => ({
        entryId: r.entryId,
        host: r.host,
        port: r.port,
        username: r.username,
        trusted: r.trustedAt !== null,
      }));
  }

  async #one(
    job: Job,
    server: RepointServer,
    agent: AgentRow | null,
    keys: readonly KeyServer[],
  ): Promise<void> {
    if (!agent) {
      this.#set(job, server, {
        state: 'failed',
        error: { code: 'failed', message: REPOINT_TEXT.gone(server.id) },
      });
      return;
    }
    server.name = agent.name;
    server.address = agent.address;
    // It found this Whombat already (its agent looked for it, BF-17): nothing to do.
    if (agent.connected) {
      this.#set(job, server, { state: 'pointed' });
      return;
    }
    const key = pickKeyServer(keys, server);
    if (!key) {
      this.#set(job, server, { state: 'no_key' });
      return;
    }
    const [entry] = await this.services.db
      .select({ id: vaultEntries.id, sealed: vaultEntries.sealed })
      .from(vaultEntries)
      .where(eq(vaultEntries.id, key.entryId));
    if (!entry?.sealed) {
      this.#set(job, server, { state: 'no_key' });
      return;
    }
    const level: HostControlLevel = levelOfSwitches(agent.hub, agent.agent);
    const privateKey = this.services.custody.open(vaultSecretAad(entry.id), entry.sealed);
    const installs = installsFor(this.services);
    const started = installs.start({
      burrowId: job.burrowId,
      personId: job.personId,
      actor: job.actor,
      body: {
        address: signInAddress(key.host, key.port),
        username: key.username,
        auth: { kind: 'vault', entryId: entry.id },
        control: level,
      },
      host: key.host,
      port: key.port,
      privateKey,
      keyEntryId: entry.id,
      keep: null,
      repoint: true,
    });
    this.#set(job, server, { state: 'pointing', installId: started.id });
    const ended: HostInstall | null = await installs.finished(started.id);
    if (ended?.state === 'ready') this.#set(job, server, { state: 'pointed', error: null });
    else
      this.#set(job, server, {
        state: 'failed',
        error: ended?.error ?? { code: 'failed', message: HOSTS_TEXT.down },
      });
  }
}

function snapshot(view: RepointView): RepointView {
  return { ...view, servers: view.servers.map((s) => ({ ...s, error: s.error ? { ...s.error } : null })) };
}

const instances = new WeakMap<object, HostRepoints>();

/** The process's repoint jobs (one set per `Services`). */
export function repointsFor(services: Services): HostRepoints {
  let jobs = instances.get(services);
  if (!jobs) {
    jobs = new HostRepoints(services);
    instances.set(services, jobs);
  }
  return jobs;
}
