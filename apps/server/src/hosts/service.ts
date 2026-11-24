/**
 * Servers inside Whombat (docs/decisions/one-whombat.md ONE-11…ONE-15; one-whombat-servers.md ONE-DH01…): the hosts
 * service as this server sees it — whether it is here and answers (`status`), its data mapped to the contracts with a
 * small cache (the fleet 5 s, the agents 30 s, the 24 h series 60 s), its event stream turned into change notices for
 * realtime and Home, and the console tickets the WebSocket proxy redeems.
 *
 * Absent (`WHOMBAT_HOSTS_SOCKET` unset) it is inert: `status` says so and nothing else starts. The servers belong to
 * this Whombat's oldest burrow (ONE-DH02); other burrows see none.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { HostAlert, HostFleet, HostHint, HostServerDetail } from '@whombat/core';
import { asc } from 'drizzle-orm';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { burrows } from '../db/schema/index';
import type { QuietWindowRow } from '../db/schema/quiet-windows';
import type { Logger } from '../services';
import { NO_QUIET, type QuietBook, quietBook, thingQuiet } from '../things/quiet/store';
import { activeWindow, keptQuiet as heldQuiet } from '../things/quiet/windows';
import { quietNames, quietOf } from '../things/quiet/wire';
import { untilWords } from '../things/quiet/words';
import { fleetHints } from './agent-updates';
import { asksIn, loadServerAsks } from './asks-store';
import {
  HOSTS_API,
  type HostsActor,
  HostsClient,
  HostsError,
  type HostsRequest,
  type HostsRole,
  HostsUnavailable,
  problemOf,
  seg,
} from './client';
import { HostsEventStream, type HostsSseEvent } from './events';
import { type HubInfo, type HubReconnecting, holdCovers, reconnectingOf, toHubInfo } from './hub';
import { arr, hintGuests, obj, toHostFleet, toHostWatchLimits, ts } from './map';
import { loadServerNames } from './names-store';
import {
  ackPeople,
  HEARTBEAT_RULE,
  HUB_LEVEL,
  keepVerdict,
  type MarkedHints,
  markAlertQuiet,
  markHints,
  serverThingId,
  serverVerdict,
} from './quiet-lines';
import { givenServerName, noteSelfServers, noteServerNames } from './self';

/** The actor of Whombat's own reads (the cache, Home, the pollers). */
export const WHOMBAT_ACTOR: HostsActor = { id: 'whombat', name: 'Whombat', role: 'viewer' };

/** What changed, from the hosts service's events (for realtime frames, Home and the Watch badge). */
export type HostsChange =
  | { kind: 'server'; serverId: string; event: string; data: Record<string, unknown> }
  | { kind: 'guest'; serverId: string; guestId: string; state: string | null }
  | { kind: 'alert'; event: 'opened' | 'updated' | 'resolved'; alert: Record<string, unknown> }
  | { kind: 'task'; serverId: string; guestId: string | null; data: Record<string, unknown> }
  | { kind: 'enrollment'; id: string; hostname: string | null }
  | { kind: 'fleet'; event: string; data?: Record<string, unknown> }
  | { kind: 'resync' };

/** A console the hosts service opened for a person, waiting for their WebSocket (single use, 30 s). */
export interface ConsoleTicket {
  token: string;
  burrowId: string;
  principalId: string;
  actor: HostsActor;
  hostsSessionId: string;
  hostsToken: string;
  protocol: string;
  serverId: string;
  guestId: string | null;
  expiresAt: number;
}

/** Plain words for the status line (`HostsStatus.reason`). */
export const HOSTS_TEXT = {
  absent: 'This Whombat doesn’t watch servers.',
  otherBurrow: 'Servers are watched for another account on this Whombat.',
  down: 'Whombat’s server monitoring isn’t answering right now. It usually comes back by itself.',
  noToken: 'Whombat’s server monitoring is still starting.',
} as const;

/** How old `hubLive` lets the hub's answer be. */
export const HUB_LIVE_MS = 5_000;

const TTL = {
  fleet: 5_000,
  agents: 30_000,
  series: 60_000,
  status: 10_000,
  home: 60_000,
  watch: 60_000,
} as const;

/** What a server's watch settings say (`GET /servers/{id}/watch`, hosts HS-195): the rules switched off. */
export interface HostWatchOff {
  rule: string;
  /** Absent: the whole rule for the server. */
  entity?: string;
  by: string;
  at: string;
}

/** The hub's watch settings answer as rows (lenient: what can't be read is left out). */
export function watchOffsOf(raw: unknown): HostWatchOff[] {
  return arr(obj(raw).rules).flatMap((r) => {
    const o = obj(r);
    if (typeof o.rule !== 'string' || !o.rule || o.off === false) return [];
    const entity = typeof o.entity === 'string' && o.entity ? o.entity : undefined;
    return [
      {
        rule: o.rule,
        ...(entity ? { entity } : {}),
        by: typeof o.by === 'string' ? o.by : '',
        at: typeof o.at === 'string' && Number.isFinite(Date.parse(o.at)) ? o.at : new Date(0).toISOString(),
      },
    ];
  });
}

export interface HostsDeps {
  config: Pick<Config, 'WHOMBAT_HOSTS_SOCKET' | 'WHOMBAT_HOSTS_TOKEN_FILE'>;
  db: Database;
  log: () => Logger;
  clock: () => Date;
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export class HostsService {
  readonly present: boolean;
  readonly client: HostsClient | null;
  #stream: HostsEventStream | null = null;
  #listeners = new Set<(change: HostsChange) => void>();
  #cache = new Map<string, Cached<unknown>>();
  #status: Cached<{ healthy: boolean; reason: string | null }> | null = null;
  #home: Cached<{ id: string; timeZone: string } | null> | null = null;
  #tickets = new Map<string, ConsoleTicket>();
  #hintSources = new Set<(serverId: string | null) => HostHint[]>();
  #closed = false;

  constructor(
    private readonly deps: HostsDeps,
    client?: HostsClient | null,
  ) {
    const socket = deps.config.WHOMBAT_HOSTS_SOCKET;
    this.client =
      client !== undefined
        ? client
        : socket
          ? new HostsClient({ socket, tokenFile: deps.config.WHOMBAT_HOSTS_TOKEN_FILE ?? null })
          : null;
    this.present = this.client !== null;
  }

  /** Follows the event stream (when the service is here). */
  start(): void {
    if (!this.client || this.#stream || this.#closed) return;
    this.#stream = new HostsEventStream(this.client, {
      onEvent: (e) => this.#onEvent(e),
      onState: (up) => {
        // Back after a break: what was cached may be old.
        if (up) this.forget();
        this.#status = null;
      },
    });
    this.#stream.start();
  }

  close(): void {
    this.#closed = true;
    this.#stream?.close();
    this.#stream = null;
    this.#listeners.clear();
    this.#tickets.clear();
  }

  /**
   * Whombat's own hints about servers from elsewhere in the server (a backup place's, backup-places.md BPL-11): asked for
   * every server (`null`) or one; returns the way to stop.
   */
  addHintSource(source: (serverId: string | null) => HostHint[]): () => void {
    this.#hintSources.add(source);
    return () => this.#hintSources.delete(source);
  }

  #ownHints(serverId: string | null): HostHint[] {
    return [...this.#hintSources].flatMap((source) => {
      try {
        return source(serverId).filter((h) => serverId === null || h.serverId === serverId);
      } catch {
        return [];
      }
    });
  }

  /** Listens to changes; returns the way to stop. */
  onChange(listener: (change: HostsChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The burrow the servers belong to: this Whombat's oldest (ONE-DH02); null when there is none. */
  async homeBurrowId(): Promise<string | null> {
    return (await this.homeBurrow())?.id ?? null;
  }

  /** That burrow with its time zone (the words of a snooze, QN-12). */
  homeBurrow(): Promise<{ id: string; timeZone: string } | null> {
    const now = Date.now();
    if (!this.#home || now - this.#home.at > TTL.home) {
      const value = this.deps.db
        .select({ id: burrows.id, timeZone: burrows.timeZone })
        .from(burrows)
        .orderBy(asc(burrows.createdAt), asc(burrows.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      this.#home = { at: now, value };
      value.catch(() => {
        this.#home = null;
      });
    }
    return this.#home.value;
  }

  /** Whether the burrow sees servers: the service is here and the burrow is the one they belong to. */
  async serves(burrowId: string): Promise<boolean> {
    return this.present && (await this.homeBurrowId()) === burrowId;
  }

  /** Health of the service (cached 10 s): `/healthz`, or why not. */
  health(): Promise<{ healthy: boolean; reason: string | null }> {
    const client = this.client;
    if (!client) return Promise.resolve({ healthy: false, reason: HOSTS_TEXT.absent });
    const now = Date.now();
    if (!this.#status || now - this.#status.at > TTL.status) {
      const value = client
        .healthy()
        .then((h) => ({ healthy: h.ok, reason: h.ok ? null : HOSTS_TEXT.down }))
        .catch((err: unknown) => ({
          healthy: false,
          reason:
            err instanceof HostsUnavailable && err.reason === 'no_token'
              ? HOSTS_TEXT.noToken
              : HOSTS_TEXT.down,
        }));
      this.#status = { at: now, value };
    }
    return this.#status.value;
  }

  /** A call on the service; a missing service is `HostsUnavailable('not_configured')`. */
  call<T>(req: HostsRequest): Promise<T> {
    if (!this.client) return Promise.reject(new HostsUnavailable('not_configured', HOSTS_TEXT.absent));
    return this.client.json<T>(req);
  }

  /** A text answer (the agent installer, `GET /agent-install.sh`); a non-2xx status throws `HostsError`. */
  async text(req: HostsRequest): Promise<string> {
    if (!this.client) throw new HostsUnavailable('not_configured', HOSTS_TEXT.absent);
    const res = await this.client.send(req);
    if (res.status < 200 || res.status >= 300) throw problemOf(res.status, res.body);
    return res.body.toString('utf8');
  }

  /** A cached read with Whombat as the actor. */
  #cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.#cache.get(key) as Cached<T> | undefined;
    if (hit && now - hit.at <= ttl) return hit.value;
    const value = load();
    this.#cache.set(key, { at: now, value });
    value.catch(() => {
      if (this.#cache.get(key)?.value === value) this.#cache.delete(key);
    });
    return value;
  }

  /** Drops cached reads (all of them without keys) after a change. */
  forget(...keys: string[]): void {
    if (keys.length === 0) this.#cache.clear();
    else for (const k of keys) this.#cache.delete(k);
  }

  /** `/hub` (version, the agents' URL; admins only on the service; cached a minute). */
  hubInfo(): Promise<Record<string, unknown>> {
    return this.#cached('hub', 60_000, () =>
      this.call<Record<string, unknown>>({
        path: `${HOSTS_API}/hub`,
        actor: { ...WHOMBAT_ACTOR, role: 'admin' },
      }),
    );
  }

  /**
   * `/hub` at most `HUB_LIVE_MS` old: while the hub reconnects to its servers (network-move.md NM-06) and while servers
   * move with the box (NM-07), its answer changes within seconds.
   */
  hubLive(): Promise<Record<string, unknown>> {
    return this.#cached('hub', HUB_LIVE_MS, () =>
      this.call<Record<string, unknown>>({
        path: `${HOSTS_API}/hub`,
        actor: { ...WHOMBAT_ACTOR, role: 'admin' },
      }),
    );
  }

  /** The hub's hold while it reconnects to its servers (NM-06), or null (none, an older service, or no answer). */
  async reconnecting(): Promise<HubReconnecting | null> {
    const hub = await this.hubLive().catch(() => null);
    return hub ? reconnectingOf(hub.reconnecting) : null;
  }

  /**
   * Asks every connected agent to move to `url` (`POST /hub/agents/move`, admin; network-move.md NM-05): one of
   * the hub's own addresses. Null from a hosts service without the route (404): its agents find the box themselves.
   */
  async moveAgents(url: string): Promise<{ asked: number; already: number } | null> {
    try {
      const answer = obj(
        await this.call<unknown>({
          method: 'POST',
          path: `${HOSTS_API}/hub/agents/move`,
          body: { url },
          actor: { ...WHOMBAT_ACTOR, role: 'admin' },
          timeoutMs: 10_000,
        }),
      );
      this.forget('hub', 'fleet', 'agents');
      const n = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);
      return { asked: n(answer.asked), already: n(answer.already) };
    } catch (err) {
      if (err instanceof HostsError && err.status === 404) return null;
      throw err;
    }
  }

  /** `/hub` read now (the cache refreshed), mapped (BF-13…BF-16). */
  async hub(): Promise<HubInfo> {
    this.forget('hub');
    return toHubInfo(await this.hubInfo());
  }

  /**
   * `GET /hub/backup` (admin; it carries the certificate authority's key): the service's own backup, a `.tar.gz`
   * streamed — the caller reads the answer to its end or destroys it (BF-13). Quiet for a minute is a broken answer.
   */
  async hubBackup(): Promise<IncomingMessage> {
    if (!this.client) throw new HostsUnavailable('not_configured', HOSTS_TEXT.absent);
    const { res } = await this.client.open({
      path: `${HOSTS_API}/hub/backup`,
      actor: { ...WHOMBAT_ACTOR, role: 'admin' },
      timeoutMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    return res;
  }

  /**
   * `POST /hub/restore` (admin, BF-14): hands the service a backup of its own kind; it answers 202 and restarts with it
   * within seconds. Refusals throw `HostsError` (`hub_not_empty`, `same_hub`, `bad_backup`, `newer_schema`).
   */
  async restoreHub(
    body: AsyncIterable<Uint8Array>,
    size: number,
    actor: HostsActor,
  ): Promise<{ caSha256: string | null; servers: number; agentUrl: string | null }> {
    if (!this.client) throw new HostsUnavailable('not_configured', HOSTS_TEXT.absent);
    const res = await this.client.upload({
      path: `${HOSTS_API}/hub/restore`,
      body,
      size,
      contentType: 'application/gzip',
      actor: { ...actor, role: 'admin' },
    });
    if (res.status < 200 || res.status >= 300) throw problemOf(res.status, res.body);
    this.forget();
    let answer: Record<string, unknown> = {};
    try {
      answer = obj(JSON.parse(res.body.toString('utf8')));
    } catch {
      // A 202 without a body still means it took it.
    }
    const servers = typeof answer.servers === 'number' && answer.servers > 0 ? Math.floor(answer.servers) : 0;
    return {
      caSha256: typeof answer.ca_sha256 === 'string' ? answer.ca_sha256.toLowerCase() : null,
      servers,
      agentUrl: typeof answer.agent_url === 'string' && answer.agent_url ? answer.agent_url : null,
    };
  }

  /**
   * Reads `/hub` every `pollMs` (after the service restarted) until `check` says `ready` or `failed`, or `deadlineMs`
   * passed; the answer it stopped at, or null when it never got that far.
   */
  async waitForHub(
    check: (hub: HubInfo) => 'ready' | 'failed' | 'wait',
    options: { deadlineMs: number; pollMs: number },
  ): Promise<{ hub: HubInfo; outcome: 'ready' | 'failed' } | null> {
    const until = Date.now() + options.deadlineMs;
    for (;;) {
      const hub = await this.hub().catch(() => null);
      const outcome = hub ? check(hub) : 'wait';
      if (hub && outcome !== 'wait') {
        this.forget();
        return { hub, outcome };
      }
      const left = until - Date.now();
      if (left <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs, left)));
    }
  }

  /** Reads the names people gave the servers into memory (`serverLabel`); nothing when there's no burrow yet. */
  async noteNames(): Promise<void> {
    const burrow = await this.homeBurrow().catch(() => null);
    if (!burrow) return;
    noteServerNames(await loadServerNames(this.deps.db, burrow.id).catch(() => new Map<string, string>()));
  }

  /** `/fleet` as the service answers it (cached). */
  fleetRaw(): Promise<Record<string, unknown>> {
    return this.#cached('fleet', TTL.fleet, () =>
      this.call<Record<string, unknown>>({ path: `${HOSTS_API}/fleet`, actor: WHOMBAT_ACTOR }).then(
        async (f) => {
          // The names people gave the servers, then which servers run this Whombat, for the words of a question about
          // their power (IU-02) and the names messages give servers.
          await this.noteNames();
          noteSelfServers(f);
          return f;
        },
      ),
    );
  }

  /** `/agents` (admins only on the service, so Whombat asks as admin; cached). */
  agentsRaw(): Promise<unknown[]> {
    return this.#cached('agents', TTL.agents, () =>
      this.call<unknown[]>({ path: `${HOSTS_API}/agents`, actor: { ...WHOMBAT_ACTOR, role: 'admin' } }).then(
        arr,
      ),
    );
  }

  /** `/fleet/series?range=24h` for the table's sparklines (cached). */
  seriesRaw(): Promise<Record<string, unknown>> {
    return this.#cached('series', TTL.series, () =>
      this.call<Record<string, unknown>>({
        path: `${HOSTS_API}/fleet/series`,
        query: { range: '24h' },
        actor: WHOMBAT_ACTOR,
      }),
    );
  }

  /** One server's guests as the service lists them (cached 30 s; Watch's hint links name a guest by its id). */
  guestsRaw(serverId: string): Promise<unknown[]> {
    return this.#cached(`guests:${serverId}`, TTL.agents, () =>
      this.call<unknown>({
        path: `${HOSTS_API}/servers/${seg(serverId)}/guests`,
        query: { limit: 500 },
        actor: WHOMBAT_ACTOR,
      }).then((page) => arr(obj(page).guests)),
    );
  }

  /** The agents row of one server (switches, version), or null. */
  async agentOf(serverId: string): Promise<unknown> {
    const agents = await this.agentsRaw().catch(() => []);
    return agents.find((a) => obj(a).server_id === serverId) ?? null;
  }

  async watchRaw(serverId: string): Promise<HostWatchOff[]> {
    return (await this.watchSettingsRaw(serverId)).rules;
  }

  /** A server's watch settings, cached a minute or until the hub reports a change. */
  watchSettingsRaw(serverId: string) {
    return this.#cached(`watch:${serverId}`, TTL.watch, () =>
      this.call<unknown>({
        path: `${HOSTS_API}/servers/${seg(serverId)}/watch`,
        actor: WHOMBAT_ACTOR,
      }).then((raw) => ({ rules: watchOffsOf(raw), limits: toHostWatchLimits(raw) })),
    );
  }

  /**
   * Switches one rule off or on again for a server or one item (`PUT /servers/{id}/watch`, operator; HS-195), as the
   * person; the server's settings after it. Refusals are the service's (`invalid_rule`, `too_many`, …).
   */
  async setWatch(
    serverId: string,
    body: { rule: string; entity?: string; off: boolean },
    actor: HostsActor,
  ): Promise<HostWatchOff[]> {
    const raw = await this.call<unknown>({
      method: 'PUT',
      path: `${HOSTS_API}/servers/${seg(serverId)}/watch`,
      body: { rule: body.rule, ...(body.entity ? { entity: body.entity } : {}), off: body.off },
      actor: { ...actor, role: actor.role === 'admin' ? 'admin' : 'operator' },
    });
    this.forget(`watch:${serverId}`, `watch-dot:${serverId}`, 'fleet');
    return watchOffsOf(raw);
  }

  async setWatchLimit(
    serverId: string,
    body: { rule: string; entity?: string; limit: number | null; expectedLimit: number | null },
    actor: HostsActor,
  ) {
    await this.call({
      method: 'PUT',
      path: `${HOSTS_API}/servers/${seg(serverId)}/watch`,
      body: { rule: body.rule, entity: body.entity, limit: body.limit, expected_limit: body.expectedLimit },
      actor: { ...actor, role: actor.role === 'admin' ? 'admin' : 'operator' },
    });
    this.forget(`watch:${serverId}`, `watch-dot:${serverId}`, 'fleet');
  }

  /**
   * The fleet in the contract's shape; the series and agents are optional extras. `shared`: what is quiet for a burrow
   * as the caller read it already (one Home read's), used when that burrow is the one the servers belong to.
   */
  async fleet(shared?: { burrowId: string; quiet: () => Promise<QuietBook> }): Promise<HostFleet> {
    const [fleet, series, agents] = await Promise.all([
      this.fleetRaw(),
      this.seriesRaw().catch(() => undefined),
      this.agentsRaw().catch(() => undefined),
    ]);
    const now = this.deps.clock();
    const out = toHostFleet({ fleet, series, agents }, now);
    out.hints = [...out.hints, ...this.#ownHints(null)];
    // “Asks you first” is Whombat's, not the service's (server-asks.md SA-04): every row says it.
    const burrow = await this.homeBurrow().catch(() => null);
    if (burrow) {
      const asks = await loadServerAsks(this.deps.db, burrow.id);
      for (const s of out.servers) s.asksFirst = asksIn(asks, s.id);
    }
    // So is the name a person gave a server (names.ts), noted by the fleet read.
    for (const s of out.servers) s.name = givenServerName(s.id) ?? s.name;
    await this.#quiet(out, fleet, agents ?? [], burrow, now, shared);
    return out;
  }

  /** One alert with its quiet (QN-14): a realtime frame's, as the fleet and the page mark theirs. */
  async withQuiet(alert: HostAlert): Promise<HostAlert> {
    if (alert.state !== 'open') return alert;
    const now = this.deps.clock();
    const burrow = await this.homeBurrow().catch(() => null);
    const zone = burrow?.timeZone ?? 'UTC';
    // Its server kept quiet holds it too, also while the hub still asks for attention (monitoring.md MON-04).
    const window =
      burrow && alert.serverId && !HUB_LEVEL(alert.rule)
        ? activeWindow(
            (await thingQuiet(this.deps.db, burrow.id, serverThingId(alert.serverId)).catch(() => null))
              ?.windows,
            now,
          )
        : null;
    if (alert.attention && !window) return alert;
    const names = await quietNames(this.deps.db, [
      ...ackPeople([alert]).map((byId) => ({ byId })),
      ...(window ? [window] : []),
    ]).catch(() => new Map<string, string>());
    const marked = { ...alert };
    markAlertQuiet(marked, window, { now, names, untilWords: (until) => untilWords(until, now, zone) });
    return marked;
  }

  /** Whether the hosts service doesn't watch whether a server is online (a failed read: it does). */
  #heartbeatOff(serverId: string): Promise<boolean> {
    return this.#cached(`watch-dot:${serverId}`, TTL.watch, () =>
      this.watchRaw(serverId)
        .then((offs) => offs.some((o) => o.rule === HEARTBEAT_RULE && !o.entity))
        .catch(() => false),
    );
  }

  /**
   * One server's page with what is quiet (QN-14, QN-23; QN-S53): its alerts and hints marked (`quiet`), hints Whombat
   * doesn't watch left out, the banner gone when its alert is quiet, and the head's status and reason from what asks
   * for attention, as the fleet's row.
   */
  async quietDetail(read: HostServerDetail): Promise<HostServerDetail> {
    // The name a person gave it (names.ts), as the fleet's row.
    await this.noteNames();
    const name = givenServerName(read.server.id);
    const given = name ? { ...read, server: { ...read.server, name } } : read;
    const own = this.#ownHints(given.server.id);
    const detail = own.length ? { ...given, hints: [...given.hints, ...own] } : given;
    const now = this.deps.clock();
    const burrow = await this.homeBurrow().catch(() => null);
    const id = detail.server.id;
    const quiet = burrow
      ? await thingQuiet(this.deps.db, burrow.id, serverThingId(id)).catch(() => null)
      : null;
    const marked = markHints(detail.hints, quiet ?? NO_QUIET, now, hintGuests);
    const alerts = detail.alerts ?? [];
    // Kept quiet until a time (monitoring.md MON-04): every open alert of it is held with the window.
    const window = activeWindow(quiet?.windows, now);
    const names = await quietNames(this.deps.db, [
      ...ackPeople(alerts).map((byId) => ({ byId })),
      ...marked.hints.map((m) => ({ byId: m.row?.byId ?? null })),
      ...(window ? [window] : []),
    ]).catch(() => new Map<string, string>());
    const zone = burrow?.timeZone ?? 'UTC';
    const words = (until: Date) => untilWords(until, now, zone);
    const verdictAlerts = alerts.map((a) => ({ ...a }));
    for (const a of alerts)
      markAlertQuiet(a, a.serverId === id ? window : null, { now, names, untilWords: words });
    const hints = marked.hints.map((m) =>
      m.row ? { ...m.hint, quiet: quietOf(m.row, names, now, zone) } : m.hint,
    );
    const status = detail.server.status;
    const verdict = serverVerdict({
      card: {
        id,
        status: status === 'offline' ? 'offline' : status === 'ok' ? 'online' : 'warning',
        statusNote: detail.server.statusNote,
      },
      pending: status === 'pending',
      alerts: verdictAlerts,
      hints: detail.hints,
      quiet: quiet ?? NO_QUIET,
      now,
      guestsOf: hintGuests,
    });
    const banner = detail.banner;
    const bannerAlert = banner?.alertId ? alerts.find((a) => a.id === banner.alertId) : undefined;
    // The page says so with End now (servers are the person's).
    const keptQuiet = window ? heldQuiet(window, { now, timeZone: zone, names, canEnd: true }) : null;
    return {
      ...detail,
      ...(keptQuiet ? { keptQuiet } : {}),
      server:
        status === 'pending' || status === 'offline'
          ? detail.server
          : { ...detail.server, status: verdict.status, statusNote: verdict.note },
      banner: (bannerAlert && bannerAlert.attention === false) || keptQuiet ? null : banner,
      hints,
    };
  }

  /**
   * What is quiet about the fleet (quiet-notices.md QN-14, QN-22, QN-23; QN-S51): every row's status and reason from
   * the alerts that ask for attention and the hints nobody quieted (kept beside the row for the desk, `verdictOf`);
   * the alerts and hints marked with their quiet, hints Whombat doesn't watch left out. Without the burrow's rows (none
   * yet, or the database didn't answer) only the alerts count.
   */
  async #quiet(
    out: HostFleet,
    raw: Record<string, unknown>,
    agents: unknown[],
    burrow: { id: string; timeZone: string } | null,
    now: Date,
    shared?: { burrowId: string; quiet: () => Promise<QuietBook> },
  ): Promise<void> {
    const rows = burrow
      ? shared?.burrowId === burrow.id
        ? shared.quiet()
        : quietBook(this.deps.db, [burrow.id])
      : null;
    const book = rows ? await rows.catch(() => null) : null;
    const zone = burrow?.timeZone ?? 'UTC';
    const hints = fleetHints(out.hints, agents);
    // While the hub reconnects to its servers after its own address changed (or most dropped at once, or a planned
    // move), the servers it covers aren't “offline” to anyone: one event, not one per server (network-move.md NM-06).
    const hold = out.servers.some((s) => s.status === 'offline') ? await this.reconnecting() : null;
    const kept: typeof out.hints = [];
    const hintRows: MarkedHints['hints'] = [];
    // Servers kept quiet now, by id (monitoring.md MON-04): their open alerts are held with the window.
    const windows = new Map<string, QuietWindowRow>();
    for (const s of out.servers) {
      const quiet = book?.of(serverThingId(s.id)) ?? NO_QUIET;
      const window = activeWindow(quiet.windows, now);
      if (window) windows.set(s.id, window);
      const mine = hints.filter((h) => h.serverId === s.id);
      const marked = markHints(mine, quiet, now, hintGuests);
      for (const m of marked.hints) {
        kept.push(m.hint);
        if (m.row) hintRows.push(m);
      }
      const card = obj(arr(raw.servers).find((c) => obj(c).id === s.id));
      const held =
        s.status === 'offline' &&
        holdCovers(
          hold,
          { agentConnected: card.agent_connected === true, lastSeen: ts(card.last_seen) },
          now,
        );
      // An offline server whose “offline” alert is switched off (HS-196) isn't a dot: only offline ones are asked.
      const heartbeatOff = held || (s.status === 'offline' ? await this.#heartbeatOff(s.id) : false);
      const verdict = serverVerdict({
        card: {
          id: s.id,
          status: typeof card.status === 'string' ? card.status : '',
          statusNote: typeof card.status_note === 'string' ? card.status_note : null,
        },
        pending: s.status === 'pending',
        alerts: out.alerts,
        hints: mine,
        quiet,
        now,
        heartbeatOff,
        guestsOf: hintGuests,
      });
      if (s.status !== 'pending' && s.status !== 'offline') {
        s.status = verdict.status;
        s.statusNote = verdict.note;
      }
      keepVerdict(s, window ? { ...verdict, quietUntil: window.endsAt.toISOString() } : verdict);
    }
    // Hints of servers the fleet doesn't list (another group) stay as they are.
    const listed = new Set(out.servers.map((s) => s.id));
    out.hints = [...kept, ...hints.filter((h) => !listed.has(h.serverId))];
    const names = await quietNames(this.deps.db, [
      ...ackPeople(out.alerts).map((byId) => ({ byId })),
      ...hintRows.map((m) => ({ byId: m.row?.byId ?? null })),
      ...windows.values(),
    ]).catch(() => new Map<string, string>());
    const words = (until: Date) => untilWords(until, now, zone);
    for (const a of out.alerts)
      markAlertQuiet(a, a.serverId ? windows.get(a.serverId) : null, { now, names, untilWords: words });
    for (const m of hintRows) if (m.row) m.hint.quiet = quietOf(m.row, names, now, zone);
  }

  /** A server's row changed in Whombat (its “Asks you first”): realtime sends it again (`hosts.server`). */
  touched(serverId: string): void {
    this.#emit({ kind: 'server', serverId, event: 'whombat.asks_changed', data: {} });
  }

  /** Open alerts (from the fleet, cached), for details and sources. */
  async openAlertsRaw(): Promise<unknown[]> {
    return arr((await this.fleetRaw()).alerts);
  }

  /* Consoles ------------------------------------------------------------------------------------------------------ */

  /** Keeps a console the service opened for a person; returns Whombat's own token for it. */
  issueConsole(ticket: Omit<ConsoleTicket, 'token' | 'expiresAt'>, ttlMs = 30_000): ConsoleTicket {
    const now = Date.now();
    for (const [k, t] of this.#tickets) if (t.expiresAt < now) this.#tickets.delete(k);
    const full: ConsoleTicket = {
      ...ticket,
      token: randomBytes(24).toString('base64url'),
      expiresAt: now + ttlMs,
    };
    this.#tickets.set(full.token, full);
    return full;
  }

  /** Takes a console ticket once, for the same person in the same burrow, in time. */
  redeemConsole(
    token: string,
    burrowId: string,
    principalId: string,
    sessionId: string,
  ): ConsoleTicket | null {
    const t = this.#tickets.get(token);
    if (!t) return null;
    this.#tickets.delete(token);
    if (t.expiresAt < Date.now() || t.burrowId !== burrowId || t.principalId !== principalId) return null;
    if (t.hostsSessionId !== sessionId) return null;
    return t;
  }

  /* Events -------------------------------------------------------------------------------------------------------- */

  #emit(change: HostsChange): void {
    for (const l of this.#listeners) {
      try {
        l(change);
      } catch (err) {
        this.deps.log().warn({ err: String(err) }, 'hosts: a change listener failed');
      }
    }
  }

  #onEvent(e: HostsSseEvent): void {
    const d = obj(e.data);
    const name = e.event;
    if (name === 'resync') {
      this.forget();
      this.#emit({ kind: 'resync' });
      return;
    }
    if (name.startsWith('server.')) {
      this.forget(
        'fleet',
        name === 'server.settings_changed' || name === 'server.deleted' ? 'agents' : 'fleet',
      );
      const id = typeof d.id === 'string' ? d.id : null;
      if (id) this.#emit({ kind: 'server', serverId: id, event: name, data: d });
      return;
    }
    if (name === 'guest.state_changed') {
      this.forget('fleet');
      if (typeof d.server === 'string' && typeof d.id === 'string')
        this.#emit({
          kind: 'guest',
          serverId: d.server,
          guestId: d.id,
          state: typeof d.state === 'string' ? d.state : null,
        });
      return;
    }
    if (name === 'alert.opened' || name === 'alert.updated' || name === 'alert.resolved') {
      this.forget('fleet');
      this.#emit({ kind: 'alert', event: name.slice(6) as 'opened' | 'updated' | 'resolved', alert: d });
      return;
    }
    if (name === 'action.finished' || name === 'task.finished') {
      this.forget('fleet');
      if (typeof d.server === 'string')
        this.#emit({
          kind: 'task',
          serverId: d.server,
          guestId: typeof d.guest === 'string' ? d.guest : null,
          data: { ...d, event: name },
        });
      return;
    }
    // A pre-approved server was let in as its agent asked (server-signin.md SI-07): the fleet and the agents changed,
    // and an install waiting for it wakes (the hub's usual server events follow).
    if (name === 'enrollment.approved') {
      this.forget('fleet', 'agents');
      if (typeof d.server_id === 'string' && d.server_id)
        this.#emit({ kind: 'server', serverId: d.server_id, event: name, data: d });
      return;
    }
    if (name === 'enrollment.pending') {
      this.forget('fleet');
      if (typeof d.id === 'string')
        this.#emit({
          kind: 'enrollment',
          id: d.id,
          hostname: typeof d.hostname === 'string' ? d.hostname : null,
        });
      return;
    }
    // A server's watch settings changed (hosts HS-195): its rules and the fleet are read again.
    if (name === 'watch.changed') {
      const server = typeof d.server === 'string' ? d.server : null;
      this.forget('fleet', ...(server ? [`watch:${server}`, `watch-dot:${server}`] : []));
      if (server) this.#emit({ kind: 'server', serverId: server, event: name, data: d });
      return;
    }
    if (name === 'maintenance.changed' || name === 'checks.changed' || name === 'agent.update') {
      this.forget('fleet', 'agents');
      // An agent's update carries its server and state (agent-updates.md AU-08): `updated` goes in Done recently.
      this.#emit({ kind: 'fleet', event: name, ...(name === 'agent.update' ? { data: d } : {}) });
    }
    // Console closes and the assistant's events (off in headless mode) aren't Whombat's.
  }
}

/** The person (or Whombat) a call is for, with the hosts role Whombat gives the call (ONE-DH03). */
export function actorOf(
  who: { id: string; name: string; shortName?: string | null },
  role: HostsRole,
  clientIp?: string | null,
): HostsActor {
  return { id: who.id, name: who.name || who.shortName || 'Someone', role, clientIp: clientIp ?? null };
}

/** Whether an error means the service isn't reachable (vs. a refusal it gave). */
export function isUnavailable(err: unknown): err is HostsUnavailable {
  return err instanceof HostsUnavailable;
}

export { HostsError, HostsUnavailable };

const instances = new WeakMap<object, HostsService>();

/** The process's hosts service (one per `Services`). */
export function hostsFor(services: {
  config: Config;
  db: Database;
  log: Logger;
  clock: () => Date;
}): HostsService {
  let s = instances.get(services);
  if (!s) {
    s = new HostsService({
      config: services.config,
      db: services.db,
      log: () => services.log,
      clock: () => services.clock(),
    });
    instances.set(services, s);
  }
  return s;
}

/** Tests: a hosts service of their own for these services (a fake's client, or none). */
export function setHostsFor(services: object, service: HostsService): void {
  instances.get(services)?.close();
  instances.set(services, service);
}
