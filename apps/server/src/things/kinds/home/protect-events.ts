/**
 * UniFi Protect's detections (service-slots.md, migration 0135 `connection_events`): Protect's API keeps no history,
 * so the server follows each active Protect connection's event stream (`/v1/subscribe/events`, a WebSocket under the
 * connection's policy, its API key on the handshake) while it runs, and keeps the detections of the last 14 days for
 * its page's Today and This week (a bar per day, and the change on the week before) and its card's Detections today.
 *
 * - **What is kept**: a doorbell ring, a smart detection in a zone, across a line or loitering (person, vehicle, animal,
 *   package, licence plate, face) and a smart audio detection (smoke or CO alarm, siren, glass breaking …), one row per
 *   Protect event id: its `add` and later `update`s (its end, what else it saw) replace it. Plain motion and sensor
 *   events aren't kept (hundreds a day; the page says nothing with them). Never video, snapshots or thumbnails.
 * - **Who follows**: one socket per active connection, opened by a housekeeping job every minute that also closes the
 *   ones of connections gone, switched to needs-reauth or with a new credential (the lifecycle event closes them at
 *   once). A socket that closes or fails is opened again after 5 seconds, doubling to 5 minutes while it keeps failing;
 *   one that stayed up a minute starts again from 5 seconds. Nothing is written while maintenance pauses the server.
 * - **Kept** 14 days: older rows go every hour (`pruneConnectionEvents`). Rows are operational state like
 *   `gateway_usage`: written here, never signed.
 * - The cameras' names come with the events' rows: read from `/v1/cameras` when the socket opens and every 10 minutes.
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { resolveCredential } from '../../../connections/credentials';
import { connectionPolicy } from '../../../connections/destination';
import { pinOf } from '../../../connections/http';
import { onConnectionLifecycle } from '../../../connections/lifecycle';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Db } from '../../../db/client';
import { type ConnectionEventPayload, catalogConnections, connectionEvents } from '../../../db/schema/index';
import { outboundConnectOptions } from '../../../lib/outbound';
import type { Services } from '../../../services';
import { dateOf, list, rec, str } from '../../words';
import { getJson } from '../read';

/** How long detections are kept: a week of bars and the week before it to compare with. */
export const EVENTS_KEEP_MS = 14 * 24 * 3600_000;
/** How often the followers are checked, and how often old rows go. */
export const FOLLOW_EVERY_MS = 60_000;
export const PRUNE_EVERY_MS = 3600_000;
/** Reconnecting: the first wait, the longest, and how long a socket must stay up to start from the first again. */
export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
const STEADY_MS = 60_000;
const NAMES_EVERY_MS = 10 * 60_000;
const MESSAGE_MAX = 1024 * 1024;

/** Protect's event types that are kept: rings and smart detections, video and audio. */
export const KEPT_TYPES = new Set([
  'ring',
  'smartDetectZone',
  'smartDetectLine',
  'smartDetectLoiterZone',
  'smartAudioDetect',
]);

/** One detection as Protect sent it. */
export interface Detection {
  eventId: string;
  at: Date;
  kind: string;
  device: string | null;
  detected: string[];
  end: Date | null;
}

/** A message of the event stream as a detection to keep, or null (another kind, another model, unreadable). */
export function detectionOf(message: unknown): Detection | null {
  const m = rec(message);
  if (m.type !== 'add' && m.type !== 'update') return null;
  const item = rec(m.item);
  if (item.modelKey !== undefined && item.modelKey !== 'event') return null;
  const kind = str(item.type);
  const eventId = str(item.id);
  const at = dateOf(item.start);
  if (!kind || !KEPT_TYPES.has(kind) || !eventId || !at) return null;
  return {
    eventId: eventId.slice(0, 200),
    at,
    kind,
    device: str(item.device)?.slice(0, 200) ?? null,
    detected: list(item.smartDetectTypes)
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 8)
      .map((t) => t.slice(0, 40)),
    end: dateOf(item.end),
  };
}

/** Keeps a detection (a later update of the same event replaces it). */
export async function recordDetection(
  db: Db,
  connectionId: string,
  d: Detection,
  title: string,
): Promise<void> {
  const payload: ConnectionEventPayload = {
    ...(d.detected.length ? { detected: d.detected } : {}),
    ...(d.end ? { end: d.end.toISOString() } : {}),
  };
  const row = {
    connectionId,
    eventId: d.eventId,
    at: d.at,
    kind: d.kind,
    device: d.device,
    title: title.slice(0, 120),
    payload,
  };
  await db
    .insert(connectionEvents)
    .values(row)
    .onConflictDoUpdate({
      target: [connectionEvents.connectionId, connectionEvents.eventId],
      // An update without what it saw keeps what the add said.
      set:
        d.detected.length || d.end ? { at: row.at, kind: row.kind, payload } : { at: row.at, kind: row.kind },
    });
}

/** What a page shows of the kept events. */
export interface KeptEvent {
  eventId: string;
  at: Date;
  kind: string;
  device: string | null;
  title: string;
  payload: ConnectionEventPayload;
}

/** The connection's kept events since `since`, newest first. */
export async function recentEvents(
  db: Db,
  connectionId: string,
  since: Date,
  limit = 100,
): Promise<KeptEvent[]> {
  const rows = await db
    .select()
    .from(connectionEvents)
    .where(and(eq(connectionEvents.connectionId, connectionId), gte(connectionEvents.at, since)))
    .orderBy(desc(connectionEvents.at))
    .limit(limit);
  return rows.map((r) => ({
    eventId: r.eventId,
    at: r.at,
    kind: r.kind,
    device: r.device,
    title: r.title,
    payload: r.payload,
  }));
}

/** The kept events per day in the burrow's zone (`2026-11-04`), and when the oldest kept one happened. */
export interface EventDays {
  days: Map<string, { all: number; rings: number }>;
  /** The oldest kept event: days before it weren't followed (null: nothing kept yet). */
  oldest: Date | null;
}

/** How many events the connection kept per day since `since`, counted by the database (a week is thousands). */
export async function eventDays(
  db: Db,
  connectionId: string,
  since: Date,
  timeZone: string,
): Promise<EventDays> {
  const day = sql<string>`to_char(${connectionEvents.at} at time zone ${timeZone}, 'YYYY-MM-DD')`;
  const [rows, oldest] = await Promise.all([
    db
      .select({
        day,
        all: sql<number>`count(*)::int`,
        rings: sql<number>`(count(*) filter (where ${connectionEvents.kind} = 'ring'))::int`,
      })
      .from(connectionEvents)
      .where(and(eq(connectionEvents.connectionId, connectionId), gte(connectionEvents.at, since)))
      .groupBy(sql`1`),
    db
      .select({ at: connectionEvents.at })
      .from(connectionEvents)
      .where(eq(connectionEvents.connectionId, connectionId))
      .orderBy(connectionEvents.at)
      .limit(1),
  ]);
  return {
    days: new Map(rows.map((r) => [r.day, { all: Number(r.all), rings: Number(r.rings) }])),
    oldest: oldest[0]?.at ?? null,
  };
}

/** Removes events older than 14 days; answers how many went. */
export async function pruneConnectionEvents(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(connectionEvents)
    .where(lt(connectionEvents.at, new Date(now.getTime() - EVENTS_KEEP_MS)))
    .returning({ id: connectionEvents.eventId });
  return gone.length;
}

/** The next wait after a failure: doubled, at most five minutes. */
export function nextBackoff(previous: number | null): number {
  return previous === null ? BACKOFF_FIRST_MS : Math.min(BACKOFF_MAX_MS, previous * 2);
}

/** How a follower is doing, for the page (“Whombat can’t follow Protect’s detections”). */
export interface FollowState {
  connected: boolean;
  /** Since when it has been failing; null while it follows. */
  failingSince: Date | null;
}

/** One connection's event stream: opened, reconnected with backoff, closed. */
class Follower {
  #ws: WebSocket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #backoff: number | null = null;
  #openedAt = 0;
  #closed = false;
  #names = new Map<string, string>();
  #namesAt = 0;
  state: FollowState = { connected: false, failingSince: null };

  constructor(
    private readonly services: Services,
    readonly row: CatalogConnectionRow,
    /** The credential it was opened with: a new one opens a new follower. */
    readonly version: string,
  ) {}

  start(): void {
    void this.#open();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#ws?.terminate();
    this.#ws = null;
  }

  async #cameraNames(): Promise<void> {
    if (Date.now() - this.#namesAt < NAMES_EVERY_MS) return;
    try {
      const cameras = await getJson(this.services, this.row, 'UniFi Protect', '/v1/cameras');
      const names = new Map<string, string>();
      for (const c of list(cameras).map(rec)) {
        const id = str(c.id);
        if (id) names.set(id, str(c.name) ?? 'A camera');
      }
      this.#names = names;
      this.#namesAt = Date.now();
    } catch {
      // Without names the rows say “A camera”; the page reads the cameras' names itself.
    }
  }

  async #open(): Promise<void> {
    if (this.#closed) return;
    const services = this.services;
    const httpUrl = `${this.row.baseUrl.replace(/\/+$/, '')}/v1/subscribe/events`;
    try {
      const { credential } = await resolveCredential(services, this.row);
      await this.#cameraNames();
      const policy = await connectionPolicy(services, httpUrl, { ...pinOf(this.row), deadlineMs: 15_000 });
      const { url, lookup, agent } = outboundConnectOptions(httpUrl, policy);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (this.#closed) return;
      const ws = new WebSocket(url, {
        lookup,
        ...(agent ? { agent } : {}),
        followRedirects: false,
        maxPayload: MESSAGE_MAX,
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
        headers: { 'User-Agent': 'Whombat', ...credential.headers },
      });
      this.#ws = ws;
      ws.on('open', () => {
        this.#openedAt = Date.now();
        this.state = { connected: true, failingSince: null };
      });
      ws.on('message', (data) => void this.#message(String(data)));
      ws.on('unexpected-response', () => ws.terminate());
      ws.on('error', () => undefined);
      ws.on('close', () => this.#again());
    } catch {
      this.#again();
    }
  }

  async #message(text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const d = detectionOf(parsed);
    if (!d || this.#closed || this.services.maintenance.paused) return;
    if (d.device && !this.#names.has(d.device)) await this.#cameraNames();
    const title = (d.device && this.#names.get(d.device)) || 'A camera';
    await recordDetection(this.services.db, this.row.id, d, title).catch((err: unknown) =>
      this.services.log.warn({ err: String(err), connectionId: this.row.id }, 'protect events: not kept'),
    );
  }

  #again(): void {
    this.#ws = null;
    if (this.#closed || this.#timer) return;
    const steady = this.#openedAt && Date.now() - this.#openedAt >= STEADY_MS;
    this.#backoff = steady ? BACKOFF_FIRST_MS : nextBackoff(this.#backoff);
    this.#openedAt = 0;
    this.state = {
      connected: false,
      failingSince: this.state.failingSince ?? this.services.clock(),
    };
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#open();
    }, this.#backoff);
    this.#timer.unref?.();
  }
}

const versionOf = (row: Pick<CatalogConnectionRow, 'credentialVersion' | 'updatedAt'>) =>
  `${row.credentialVersion}:${row.updatedAt.getTime()}`;

/** The followers of a server's Protect connections: started with the server's background work, closed with it. */
export class ProtectEventStreams {
  readonly #followers = new Map<string, Follower>();
  #stops: (() => void)[] = [];
  #closed = false;
  #ticking: Promise<void> | null = null;

  constructor(private readonly services: Services) {}

  start(): void {
    if (this.#stops.length || this.#closed) return;
    const hk = this.services.housekeeping;
    this.#stops.push(
      hk.add('protect events', FOLLOW_EVERY_MS, () => this.tick(), { first: 'tick' }),
      hk.add('protect events prune', PRUNE_EVERY_MS, async () => {
        if (this.services.maintenance.paused) return;
        await pruneConnectionEvents(this.services.db, this.services.clock());
      }),
      onConnectionLifecycle(this.services, (event) => {
        if (event.type === 'tiers') return;
        this.#followers.get(event.connectionId)?.close();
        this.#followers.delete(event.connectionId);
        if (event.type === 'credential') void this.tick();
      }),
    );
  }

  /** Opens a follower for every active Protect connection that has none, and closes those no longer wanted. */
  tick(): Promise<void> {
    this.#ticking ??= this.#tick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    const rows = await this.services.db
      .select()
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.catalogId, 'unifi_protect'),
          inArray(catalogConnections.status, ['active']),
        ),
      );
    const wanted = new Map(rows.map((r) => [r.id, r]));
    for (const [id, f] of this.#followers)
      if (!wanted.has(id) || f.version !== versionOf(wanted.get(id) as CatalogConnectionRow)) {
        f.close();
        this.#followers.delete(id);
      }
    if (this.#closed) return;
    for (const row of rows)
      if (!this.#followers.has(row.id)) {
        const f = new Follower(this.services, row, versionOf(row));
        this.#followers.set(row.id, f);
        f.start();
      }
  }

  /** How the connection's follower is doing; null when there is none (the server doesn't follow, or not yet). */
  stateOf(connectionId: string): FollowState | null {
    return this.#followers.get(connectionId)?.state ?? null;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const stop of this.#stops) stop();
    this.#stops = [];
    await this.#ticking?.catch(() => undefined);
    for (const f of this.#followers.values()) f.close();
    this.#followers.clear();
  }
}

const streams = new WeakMap<Services, ProtectEventStreams>();

/** The server's Protect followers (one per services). */
export function protectEventsFor(services: Services): ProtectEventStreams {
  let s = streams.get(services);
  if (!s) {
    s = new ProtectEventStreams(services);
    streams.set(services, s);
  }
  return s;
}
