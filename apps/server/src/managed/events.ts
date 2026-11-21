/**
 * The session event log (MA-09; docs/decisions/managed-runtime.md MR-07).
 *
 * Every realtime frame the bus publishes after commit (outbox frames, unread badges, notifications) is appended
 * to `session_events` by one serialized writer, so ids grow in delivery order and a reader resuming `after` a
 * cursor never skips a row that commits later. Only `typing` and `presence` stay ephemeral (live, no cursor).
 *
 * Cursors are opaque: `c1.<epoch>.<generation>.<id>`. The epoch is random per server start: a frame can be lost
 * between a commit and its log append when the process dies, so after a restart every old cursor gets
 * `snapshot_required{restart}`. A cursor below the retention floor (age and count limits) gets
 * `snapshot_required{cursor_expired}`; one from another authorization generation of the account gets
 * `snapshot_required{authz_changed}`; a subscriber more than `MAX_PENDING_PER_SUBSCRIPTION` events behind is
 * dropped with `snapshot_required{overflow}`. `snapshot_required` carries the current head cursor: the client
 * refetches its authorized snapshots, then subscribes again `after` it (nothing is subscribed meanwhile).
 *
 * Authorization per topic is exactly `/ws`'s (`authorizeTopic`): topics of the account's person's burrow only, what a
 * frame's delivery fills in (`realtime/fill.ts`) and viewer-relative fields.
 */
import { randomBytes } from 'node:crypto';
import { parseTopic, type RealtimeEvent } from '@whombat/core';
import { and, asc, eq, gt, inArray, lte, max } from 'drizzle-orm';
import { canvases, conversations, principals, runs, sessionEvents } from '../db/schema/index';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import { fillFrame } from '../realtime/fill';
import { authorizeTopic, personalize } from '../realtime/hub';
import type { Services } from '../services';

export const EPHEMERAL_EVENTS: ReadonlySet<string> = new Set(['typing', 'presence']);
const REPLAY_PAGE = 500;

/** `@whombat/protocol` `SnapshotReason`. */
export type SnapshotReason = 'cursor_expired' | 'restart' | 'authz_changed' | 'overflow';
/** `@whombat/protocol` `TopicDenialReason`. */
export type TopicDenial = 'not_member' | 'forbidden' | 'not_found';

/** `/ws`'s reasons (`authorizeTopic`) as the protocol names them. */
export function denialOf(reason: string): TopicDenial {
  if (reason === 'other_burrow') return 'not_member';
  if (reason === 'unknown_run' || reason === 'unknown_canvas' || reason === 'bad_topic') return 'not_found';
  return 'forbidden';
}
/** Events waiting for one slow subscriber before it is dropped with `snapshot_required{overflow}`. */
export const MAX_PENDING_PER_SUBSCRIPTION = 1000;

export interface ParsedCursor {
  epoch: string;
  generation: number;
  id: number;
}

export function formatCursor(c: ParsedCursor): string {
  return `c1.${c.epoch}.${c.generation}.${c.id}`;
}

export function parseCursor(raw: string): ParsedCursor | null {
  const m = /^c1\.([A-Za-z0-9_-]{4,32})\.(\d{1,15})\.(\d{1,18})$/.exec(raw);
  if (!m) return null;
  return { epoch: m[1] as string, generation: Number(m[2]), id: Number(m[3]) };
}

/** Pure resume decision (unit-tested). */
export function resumeDecision(
  after: string | null,
  now: { epoch: string; generation: number; floor: number },
): { resume: number } | { snapshot: SnapshotReason } | { fresh: true } {
  if (after === null) return { fresh: true };
  const c = parseCursor(after);
  if (!c) return { snapshot: 'cursor_expired' };
  if (c.epoch !== now.epoch) return { snapshot: 'restart' };
  if (c.generation !== now.generation) return { snapshot: 'authz_changed' };
  if (c.id < now.floor) return { snapshot: 'cursor_expired' };
  return { resume: c.id };
}

/** One delivered event. Ephemeral events (typing, presence) are live only and carry no cursor (CT-17). */
export interface LogEvent {
  subscription: string;
  cursor: string | null;
  ephemeral: boolean;
  topic: string;
  event: RealtimeEvent;
  eventId: string | null;
  at: string;
}

export interface LogSubscriber {
  accountId: string;
  generation: number;
  send(event: LogEvent): void;
  /** The subscription fell too far behind and was dropped: answer `snapshot_required{overflow}`. */
  overflow(subscription: string, cursor: string): void;
}

interface Row {
  id: number | null;
  topic: string;
  event: RealtimeEvent;
  eventId: string | null;
  at: string;
}

interface Subscription {
  id: string;
  subscriber: LogSubscriber;
  /** topic → the account's person principal in that topic's burrow */
  topics: Map<string, { principal: PrincipalRow }>;
  /** Live rows that arrived while the replay ran. */
  buffer: Row[] | null;
  lastId: number;
  closed: boolean;
  chain: Promise<void>;
  pending: number;
}

export type SubscribeResult = {
  cursor: string;
  denied: { topic: string; reason: TopicDenial }[];
  /** Set: nothing was subscribed; refetch snapshots, then subscribe `after: cursor`. */
  snapshotRequired: SnapshotReason | null;
  close(): void;
};

export class SessionEventLog {
  readonly epoch = randomBytes(6).toString('base64url');
  /** A cursor below this can't resume (rows after it were pruned, or predate this process's epoch). */
  private floor = Number.MAX_SAFE_INTEGER;
  private head = 0;
  private writer: Promise<void> = Promise.resolve();
  private readonly subs = new Set<Subscription>();
  private readonly off: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly services: Services,
    private readonly options: { maxAgeMs: number; maxCount: number; sweepMs?: number },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const [row] = await this.services.db.select({ id: max(sessionEvents.id) }).from(sessionEvents);
    this.head = Number(row?.id ?? 0);
    // Nothing from before this start is replayable (a new epoch): resuming needs a cursor at or after the head.
    this.floor = this.head;
    this.off.push(this.services.bus.onFrame((frame) => this.onFrame(frame)));
    const every = this.options.sweepMs ?? 60_000;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.services.log.warn({ err: String(err) }, 'session event sweep failed'));
    }, every);
    this.timer.unref?.();
  }

  close(): void {
    for (const off of this.off.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const sub of this.subs) this.closeSubscription(sub);
  }

  /** Resolves once every frame published so far is in the log and handed to subscribers. */
  flushed(): Promise<void> {
    return this.writer.then(async () => {
      await Promise.all([...this.subs].map((s) => s.chain));
    });
  }

  get currentFloor(): number {
    return this.floor;
  }

  cursor(generation: number, id = this.head): string {
    return formatCursor({ epoch: this.epoch, generation, id });
  }

  private onFrame(frame: BusFrame): void {
    if (EPHEMERAL_EVENTS.has(frame.event.type)) {
      this.deliverAll({ id: null, ...frameRow(frame) });
      return;
    }
    this.writer = this.writer
      .then(async () => {
        const [row] = await this.services.db
          .insert(sessionEvents)
          .values({
            burrowId: burrowOfTopic(frame.topic),
            topic: frame.topic,
            event: frame.event as unknown as Record<string, unknown>,
            eventId: frame.eventId,
            at: frame.at,
          })
          .returning({ id: sessionEvents.id });
        if (!row) return;
        this.head = row.id;
        this.deliverAll({ id: row.id, ...frameRow(frame) });
      })
      .catch((err) => {
        this.services.log.error({ err: String(err) }, 'session event append failed');
        // Never delivered and never replayable: everyone who follows its topic gets a fresh snapshot instead.
        for (const sub of this.subs) if (sub.topics.has(frame.topic)) this.overflow(sub);
      });
  }

  private deliverAll(row: Row): void {
    for (const sub of this.subs) {
      if (sub.closed || !sub.topics.has(row.topic)) continue;
      if (sub.buffer) {
        if (sub.buffer.length >= MAX_PENDING_PER_SUBSCRIPTION) this.overflow(sub);
        else sub.buffer.push(row);
        continue;
      }
      this.enqueue(sub, row);
    }
  }

  private closeSubscription(sub: Subscription): void {
    sub.closed = true;
    sub.buffer = null;
    this.subs.delete(sub);
  }

  private overflow(sub: Subscription): void {
    if (sub.closed) return;
    this.closeSubscription(sub);
    sub.subscriber.overflow(sub.id, this.cursor(sub.subscriber.generation));
  }

  private enqueue(sub: Subscription, row: Row): void {
    if (sub.closed) return;
    if (sub.pending >= MAX_PENDING_PER_SUBSCRIPTION) {
      this.overflow(sub);
      return;
    }
    sub.pending += 1;
    sub.chain = sub.chain
      .then(() => this.deliver(sub, row))
      .catch((err) => {
        this.services.log.warn({ err: String(err) }, 'session event delivery failed');
        // A later cursor would conceal the missed event. Refetch before following any more.
        this.overflow(sub);
      })
      .finally(() => {
        sub.pending -= 1;
      });
  }

  private async deliver(sub: Subscription, row: Row): Promise<void> {
    if (sub.closed) return;
    const t = sub.topics.get(row.topic);
    if (!t) return;
    if (row.id !== null) {
      if (row.id <= sub.lastId) return;
      sub.lastId = row.id;
    }
    const viewer = t.principal.id;
    const event = await fillFrame(this.services.db, row.event, viewer);
    // Enrichment can wait on a read while the replay overflows or the subscription closes.
    if (sub.closed || !sub.topics.has(row.topic)) return;
    sub.subscriber.send({
      subscription: sub.id,
      cursor: row.id === null ? null : this.cursor(sub.subscriber.generation, row.id),
      ephemeral: row.id === null,
      topic: row.topic,
      event: personalize(event, viewer),
      eventId: row.eventId,
      at: row.at,
    });
  }

  /** `subscribe{topics, after}` for an enrolled account. */
  async subscribe(
    subscriber: LogSubscriber,
    input: { id: string; topics: readonly string[]; after: string | null },
  ): Promise<SubscribeResult> {
    const nothing = () => {};
    await this.writer;
    const decision = resumeDecision(input.after, {
      epoch: this.epoch,
      generation: subscriber.generation,
      floor: this.floor,
    });
    if ('snapshot' in decision)
      return {
        cursor: this.cursor(subscriber.generation),
        denied: [],
        snapshotRequired: decision.snapshot,
        close: nothing,
      };
    const topics = new Map<string, { principal: PrincipalRow }>();
    const denied: { topic: string; reason: TopicDenial }[] = [];
    for (const topic of new Set(input.topics)) {
      const found = await this.principalFor(subscriber.accountId, topic);
      if (!found.principal) {
        denied.push({ topic, reason: found.reason });
        continue;
      }
      const principal = found.principal;
      const authz = await authorizeTopic(this.services, { principal, burrowId: principal.burrowId }, topic);
      if (authz.ok) topics.set(topic, { principal });
      else denied.push({ topic, reason: denialOf(authz.reason) });
    }
    const sub: Subscription = {
      id: input.id,
      subscriber,
      topics,
      buffer: [],
      lastId: 0,
      closed: false,
      chain: Promise.resolve(),
      pending: 0,
    };
    // Registered before reading, so nothing committed from now on is missed (the buffer holds it).
    this.subs.add(sub);
    try {
      await this.writer;
      const from = 'resume' in decision ? decision.resume : this.head;
      sub.lastId = from;
      let snapshotRequired: SnapshotReason | null = null;
      if ('resume' in decision && topics.size) {
        while (!sub.closed) {
          const rows = await this.services.db
            .select()
            .from(sessionEvents)
            .where(and(gt(sessionEvents.id, sub.lastId), inArray(sessionEvents.topic, [...topics.keys()])))
            .orderBy(asc(sessionEvents.id))
            .limit(REPLAY_PAGE);
          for (const r of rows) {
            if (sub.closed) break;
            await this.deliver(sub, {
              id: r.id,
              topic: r.topic,
              event: r.event as unknown as RealtimeEvent,
              eventId: r.eventId,
              at: r.at,
            });
          }
          if (rows.length < REPLAY_PAGE) break;
        }
        // Rows the retention sweep removed while we read would be a silent gap: say so instead.
        if (from < this.floor) snapshotRequired = 'cursor_expired';
      }
      if (sub.closed) snapshotRequired = 'overflow';
      if (snapshotRequired) {
        this.closeSubscription(sub);
        return { cursor: this.cursor(subscriber.generation), denied, snapshotRequired, close: nothing };
      }
      const buffered = sub.buffer ?? [];
      sub.buffer = null;
      for (const row of buffered) this.enqueue(sub, row);
      return {
        cursor: this.cursor(subscriber.generation, Math.max(sub.lastId, from)),
        denied,
        snapshotRequired: null,
        close: () => this.closeSubscription(sub),
      };
    } catch (err) {
      // A replay that fails never hands its caller a close function.
      this.closeSubscription(sub);
      throw err;
    }
  }

  /** The account's person principal in the burrow a topic belongs to. */
  private async principalFor(
    accountId: string,
    topic: string,
  ): Promise<{ principal: PrincipalRow; reason?: never } | { principal: null; reason: TopicDenial }> {
    const parsed = parseTopic(topic);
    if (!parsed) return { principal: null, reason: 'not_found' };
    const db = this.services.db;
    let burrowId: string | null = null;
    switch (parsed.kind) {
      case 'burrow':
        burrowId = parsed.id;
        break;
      case 'me': {
        const row = await loadPrincipalRow(db, parsed.id);
        if (!row) return { principal: null, reason: 'not_found' };
        if (row.accountId !== accountId) return { principal: null, reason: 'forbidden' };
        burrowId = row.burrowId;
        break;
      }
      case 'conv': {
        const [row] = await db
          .select({ b: conversations.burrowId })
          .from(conversations)
          .where(eq(conversations.id, parsed.id));
        burrowId = row?.b ?? null;
        break;
      }
      case 'run': {
        const [row] = await db.select({ b: runs.burrowId }).from(runs).where(eq(runs.id, parsed.id));
        burrowId = row?.b ?? null;
        break;
      }
      case 'canvas': {
        const [row] = await db
          .select({ b: canvases.burrowId })
          .from(canvases)
          .where(eq(canvases.id, parsed.id));
        burrowId = row?.b ?? null;
        break;
      }
    }
    if (!burrowId) return { principal: null, reason: 'not_found' };
    const [person] = await db
      .select()
      .from(principals)
      .where(
        and(
          eq(principals.burrowId, burrowId),
          eq(principals.accountId, accountId),
          eq(principals.kind, 'person'),
        ),
      );
    return person ? { principal: person as PrincipalRow } : { principal: null, reason: 'not_member' };
  }

  /** Retention: older than the age limit, or beyond the count limit, goes; the floor moves past it. */
  async sweep(now = this.services.clock()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.options.maxAgeMs);
    let removed = 0;
    const byAge = await this.services.db
      .delete(sessionEvents)
      .where(lte(sessionEvents.createdAt, cutoff))
      .returning({ id: sessionEvents.id });
    removed += byAge.length;
    let top = byAge.reduce((m, r) => Math.max(m, r.id), 0);
    const [head] = await this.services.db.select({ id: max(sessionEvents.id) }).from(sessionEvents);
    const limit = Number(head?.id ?? 0) - this.options.maxCount;
    if (limit > 0) {
      const byCount = await this.services.db
        .delete(sessionEvents)
        .where(lte(sessionEvents.id, limit))
        .returning({ id: sessionEvents.id });
      removed += byCount.length;
      top = Math.max(top, limit);
    }
    // A cursor below the newest removed id would miss rows: it needs a snapshot.
    if (removed > 0) this.floor = Math.max(this.floor, top);
    return removed;
  }
}

function frameRow(frame: BusFrame): Omit<Row, 'id'> {
  return {
    topic: frame.topic,
    event: frame.event,
    eventId: frame.eventId,
    at: frame.at,
  };
}

function burrowOfTopic(topic: string): string | null {
  const parsed = parseTopic(topic);
  return parsed?.kind === 'burrow' ? parsed.id : null;
}
