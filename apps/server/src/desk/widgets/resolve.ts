/**
 * What each placed widget says (docs/decisions/desk-display.md DK-142, DK-148; desk-display-server.md “Screens of
 * widgets”): a screen's distinct widgets resolved into views, each kept until its own pace says to read it again.
 *
 * - **Never slower than the glance.** A view is answered from what's kept; one that's old is read again in the
 *   background while the old one shows. Only a widget never read waits, and at most `waitMs` (none for the box's own
 *   state): after that it has no view yet and the screen draws it empty until the next ask.
 * - **Whombat's own** (*{assistant}’s work*, *Coming up*, *Done today*) come from the glance's own read; a **server**'s
 *   figures from the glance's fleet, what it is and how long it's up from the fleet kept a minute, its line from the
 *   hosts service kept per range; a **server's part** (its storage, its guests, its memory over a week…) from what its
 *   own screen reads, once per server and range for all its parts; a **Home widget** from Home, a minute; a **connection's or device's** through
 *   `ThingWidgets`, in one call for all that are due, each kept its own `refreshS`; one of the **person's own
 *   accounts** (`account:` refs) through `AccountWidgets`, what it read kept and drawn for now at each widget's pace.
 * - **The lock** (DK-138): `trimView` leaves out what *A summary* hides.
 */
import {
  DESK_SCREEN_VIEWS_MAX,
  DESK_SCREEN_WORDS,
  type DeskCalmComing,
  type DeskCalmView,
  type DeskCalmWork,
  type DeskServerRange,
  type DeskWidgetSpec,
  type DeskWidgetView,
  DeskWidgetView as DeskWidgetViewSchema,
} from '@whombat/core';
import { hostsFor } from '../../hosts/service';
import type { Services } from '../../services';
import { CALM_SOURCE_WAIT_MS } from '../calm';
import { type DeskFleet, deskFleet } from '../glance';
import { readServerParts, type ServerParts } from '../server-page';
import type { DeskServer } from '../shapes';
import { type AccountReads, AccountWidgets, isAccountRef } from './accounts';
import { HOME_WIDGET_REFRESH_S, homeWidgetView, type ScreenHomeWidget, screenHomeWidgets } from './home';
import { comingView, doneView, workView } from './own';
import { SERVER_PARTS_KEEP_MS, serverPartOf, serverPartRange, serverPartView } from './server-parts';
import { readServerLine, SERVER_HISTORY_KEEP_MS, type ServerLine, serverRange, serverView } from './servers';
import type { Resolved, ThingWidgets, WidgetCtx } from './types';

/** What the glance read for the screen's person, which Whombat's own widgets and the servers' figures read. */
export interface GlanceFacts {
  work: DeskCalmWork | null;
  coming: readonly DeskCalmComing[];
  /** The tasks finished, newest first, and where the person's today begins (ms). */
  recent: readonly { text: string; at: string }[];
  startOfToday: number;
  /** Every server's card as the glance last read the fleet. */
  servers: readonly DeskServer[];
}

/** The fleet's rows are kept this long (what a server is and how long it's up). */
export const FLEET_KEEP_MS = 60_000;
/** A read that failed is tried again after this. */
export const RETRY_MS = 60_000;
/** The fewest seconds between reads of one widget (DK-148). */
export const REFRESH_MIN_S = 10;
/** Kept reads at most; past it the ones not asked for longest go. */
const KEPT_MAX = 1_000;

export const RESOLVE_WORDS = {
  failed: 'I can’t read this right now.',
} as const;

interface Entry {
  value: unknown;
  has: boolean;
  /** When it's to be read again (ms). */
  until: number;
  failed: boolean;
  pending: Promise<void> | null;
  used: number;
}

/** Reads kept until their own time, read again in the background, at most one read per key at a time. */
export class Kept {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly clock: () => number) {}

  #entry(key: string): Entry {
    let e = this.#entries.get(key);
    if (!e) {
      if (this.#entries.size >= KEPT_MAX) this.#evict();
      e = { value: undefined, has: false, until: 0, failed: false, pending: null, used: this.clock() };
      this.#entries.set(key, e);
    }
    e.used = this.clock();
    return e;
  }

  #evict(): void {
    const idle = [...this.#entries.entries()]
      .filter(([, e]) => !e.pending)
      .sort((a, b) => a[1].used - b[1].used)
      .slice(0, Math.ceil(KEPT_MAX / 4));
    for (const [key] of idle) this.#entries.delete(key);
  }

  /** Whether `key` should be read now: never read, or its time is up, and not being read. */
  due(key: string): boolean {
    const e = this.#entry(key);
    return !e.pending && (!e.has || this.clock() >= e.until);
  }

  /**
   * One read for `keys`: each gets its answer's value and keeps it its `keepMs`. A key the answer leaves out, or a read
   * that fails, keeps what it had (or `fallback`) and is read again within `RETRY_MS`.
   */
  start<T>(
    keys: readonly string[],
    read: () => Promise<Map<string, { value: T; keepMs: number }>>,
    fallback: (key: string) => T | undefined = () => undefined,
  ): void {
    if (keys.length === 0) return;
    const entries = keys.map((k) => this.#entry(k));
    const settle = (answers: Map<string, { value: T; keepMs: number }> | null) => {
      const now = this.clock();
      keys.forEach((key, i) => {
        const e = entries[i] as Entry;
        const answer = answers?.get(key);
        if (answer) {
          e.value = answer.value;
          e.has = true;
          e.failed = false;
          e.until = now + answer.keepMs;
        } else {
          if (!e.has) {
            const value = fallback(key);
            e.value = value;
            e.has = value !== undefined;
          }
          e.failed = true;
          e.until = now + RETRY_MS;
        }
        e.pending = null;
      });
    };
    const pending = Promise.resolve()
      .then(read)
      .then(settle, () => settle(null));
    for (const e of entries) e.pending = pending;
  }

  /** Waits at most `waitMs` for those of `keys` never read yet. */
  async settled(keys: readonly string[], waitMs: number): Promise<void> {
    if (waitMs <= 0) return;
    const waiting = keys.flatMap((k) => {
      const e = this.#entries.get(k);
      return e && !e.has && e.pending ? [e.pending] : [];
    });
    if (waiting.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(waiting), late]).finally(() => clearTimeout(timer));
  }

  /** Once every read going on now has ended. */
  async idle(): Promise<void> {
    await Promise.all([...this.#entries.values()].flatMap((e) => (e.pending ? [e.pending] : [])));
  }

  /** What `key` holds now, and whether its last read failed. */
  peek<T>(key: string): { value: T | undefined; has: boolean; failed: boolean } {
    const e = this.#entries.get(key);
    return { value: e?.value as T | undefined, has: e?.has ?? false, failed: e?.failed ?? false };
  }
}

/** A text view that says why a widget can't show. */
function failedView(spec: DeskWidgetSpec, title: string, text: string): Resolved {
  return {
    view: { kind: 'text', id: spec.id, title, tone: 'off', body: text, problem: { text } },
    private: false,
    refreshS: REFRESH_MIN_S,
  };
}

/** What a thing's widget is, as a cache key: the same widget on two pages is read once. */
export function widgetKey(viewer: string, spec: DeskWidgetSpec): string {
  const opts = Object.entries(spec.opts ?? {})
    .filter(([k]) => k !== 'lock')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `thing\n${viewer}\n${spec.type}\n${spec.ref ?? ''}\n${opts}`;
}

const idOf = (ref: string | undefined) => (ref ? ref.slice(ref.indexOf(':') + 1) : '');

/** The views of a screen's widgets, kept and read again at each widget's pace. */
export class WidgetResolver {
  readonly #kept: Kept;
  readonly #accounts: AccountWidgets;

  constructor(
    private readonly services: Services,
    private readonly things: () => ThingWidgets,
    private readonly reads: {
      fleet?: (burrowId: string) => Promise<DeskFleet | null>;
      line?: (serverId: string, range: DeskServerRange, now: Date) => Promise<ServerLine>;
      parts?: (serverId: string, range: DeskServerRange, now: Date) => Promise<ServerParts>;
      homeWidgets?: (ctx: WidgetCtx) => Promise<ScreenHomeWidget[]>;
      accounts?: Partial<AccountReads>;
    } = {},
  ) {
    this.#kept = new Kept(() => services.clock().getTime());
    this.#accounts = new AccountWidgets(services, reads.accounts);
  }

  /** The person's accounts' widgets (their catalogue groups too). */
  get accounts(): AccountWidgets {
    return this.#accounts;
  }

  /**
   * The widgets' resolutions now, by widget id (at most `DESK_SCREEN_VIEWS_MAX` different ones); widgets without a view
   * of their own (the clock, the calm glance's three) and widgets never read within `waitMs` have none.
   */
  async resolve(
    ctx: WidgetCtx,
    specs: readonly DeskWidgetSpec[],
    facts: GlanceFacts | null,
    waitMs = 0,
  ): Promise<Map<string, Resolved>> {
    const wanted = specs.slice(0, DESK_SCREEN_VIEWS_MAX);
    const viewer = `${ctx.viewer.burrowId}\n${ctx.viewer.principal.id}`;
    const keys = this.#start(ctx, wanted, viewer);
    await this.#kept.settled(keys, waitMs);
    const out = new Map<string, Resolved>();
    for (const spec of wanted) {
      const r = this.#now(ctx, spec, facts, viewer);
      if (r) out.set(spec.id, r);
    }
    return out;
  }

  /** Once the reads going on now have ended (what a test waits on instead of sleeping). */
  idle(): Promise<void> {
    return this.#kept.idle();
  }

  /** Starts the reads that are due; the keys they fill. */
  #start(ctx: WidgetCtx, specs: readonly DeskWidgetSpec[], viewer: string): string[] {
    const keys: string[] = [];
    const burrowId = ctx.viewer.burrowId;
    const fleetKey = `fleet\n${burrowId}`;
    const homeKey = `home\n${viewer}`;
    const things: DeskWidgetSpec[] = [];
    for (const spec of specs) {
      switch (spec.type) {
        case 'server': {
          const id = idOf(spec.ref);
          const part = serverPartOf(spec.opts);
          if (part) {
            // One of its parts: what its own screen reads, once per server and range for all its parts.
            const range = serverPartRange(part, spec.opts);
            const partsKey = `parts\n${burrowId}\n${id}\n${range}`;
            keys.push(fleetKey, partsKey);
            if (this.#kept.due(partsKey))
              this.#kept.start([partsKey], async () => {
                const parts = this.reads.parts
                  ? await this.reads.parts(id, range, ctx.now)
                  : await readServerParts(hostsFor(this.services), id, range, ctx.now);
                return new Map([[partsKey, { value: parts, keepMs: SERVER_PARTS_KEEP_MS[range] }]]);
              });
            break;
          }
          const range = serverRange(spec.opts);
          const lineKey = `line\n${burrowId}\n${id}\n${range}`;
          keys.push(fleetKey, lineKey);
          if (this.#kept.due(lineKey))
            this.#kept.start([lineKey], async () => {
              const line = this.reads.line
                ? await this.reads.line(id, range, ctx.now)
                : await readServerLine(hostsFor(this.services), id, range, ctx.now);
              return new Map([[lineKey, { value: line, keepMs: SERVER_HISTORY_KEEP_MS[range] }]]);
            });
          break;
        }
        case 'widget':
          keys.push(homeKey);
          break;
        case 'figures':
        case 'panel':
          if (isAccountRef(spec.ref)) {
            keys.push(...this.#accounts.start(this.#kept, ctx, spec, viewer));
            break;
          }
          keys.push(widgetKey(viewer, spec));
          things.push(spec);
          break;
        default:
          break;
      }
    }
    if (keys.includes(fleetKey) && this.#kept.due(fleetKey))
      this.#kept.start([fleetKey], async () => {
        const read = this.reads.fleet ?? ((b: string) => deskFleet(this.services, b, CALM_SOURCE_WAIT_MS));
        return new Map([[fleetKey, { value: await read(burrowId), keepMs: FLEET_KEEP_MS }]]);
      });
    if (keys.includes(homeKey) && this.#kept.due(homeKey))
      this.#kept.start([homeKey], async () => {
        const read =
          this.reads.homeWidgets ??
          ((c: WidgetCtx) => screenHomeWidgets(this.services.db, c.viewer.principal, c.now));
        return new Map([[homeKey, { value: await read(ctx), keepMs: HOME_WIDGET_REFRESH_S * 1000 }]]);
      });
    // Every thing's widget that's due, in one call: each thing's page is read once for all of them.
    const due = new Map<string, DeskWidgetSpec>();
    for (const spec of things) {
      const key = widgetKey(viewer, spec);
      if (!due.has(key) && this.#kept.due(key)) due.set(key, spec);
    }
    if (due.size > 0) {
      const batch = [...due.entries()];
      this.#kept.start(
        batch.map(([key]) => key),
        async () => {
          const answers = await this.things().resolve(
            ctx,
            batch.map(([, spec]) => spec),
          );
          const out = new Map<string, { value: Resolved; keepMs: number }>();
          for (const [key, spec] of batch) {
            const r = answers.get(spec.id);
            if (r) out.set(key, { value: r, keepMs: Math.max(REFRESH_MIN_S, r.refreshS) * 1000 });
          }
          return out;
        },
        (key) => {
          const spec = due.get(key);
          return spec ? failedView(spec, DESK_SCREEN_WORDS.figures.name, RESOLVE_WORDS.failed) : undefined;
        },
      );
    }
    return [...new Set(keys)];
  }

  /** A widget's resolution from what's kept and the glance; null when it has none (yet). */
  #now(ctx: WidgetCtx, spec: DeskWidgetSpec, facts: GlanceFacts | null, viewer: string): Resolved | null {
    switch (spec.type) {
      case 'work':
        return facts ? workView(spec.id, facts.work, ctx.assistant) : null;
      case 'coming':
        return facts ? comingView(spec.id, facts.coming, ctx.now, ctx.timeZone) : null;
      case 'done':
        return facts
          ? doneView(spec.id, facts.recent, facts.startOfToday, ctx.assistant, ctx.timeZone)
          : null;
      case 'server': {
        const id = idOf(spec.ref);
        const fleet = this.#kept.peek<DeskFleet | null>(`fleet\n${ctx.viewer.burrowId}`);
        // The fleet kept from before a read that failed would show old figures as now's: the glance's card, or none.
        const card =
          facts?.servers.find((s) => s.id === id) ??
          (fleet.failed ? undefined : fleet.value?.cards.find((s) => s.id === id));
        // Not known yet either way: no view until the fleet is read.
        if (!card && !fleet.has) return null;
        const part = serverPartOf(spec.opts);
        if (part) {
          const range = serverPartRange(part, spec.opts);
          const parts = this.#kept.peek<ServerParts>(`parts\n${ctx.viewer.burrowId}\n${id}\n${range}`);
          return serverPartView({
            id: spec.id,
            show: part,
            serverId: id,
            card,
            row: fleet.value?.rows.get(id),
            parts: parts.value ?? null,
            range,
            now: ctx.now,
            timeZone: ctx.timeZone,
            unreachable: !card && fleet.failed,
            failed: parts.failed && !parts.has,
          });
        }
        const range = serverRange(spec.opts);
        const line = this.#kept.peek<ServerLine>(`line\n${ctx.viewer.burrowId}\n${id}\n${range}`);
        return serverView({
          id: spec.id,
          serverId: id,
          card,
          row: fleet.value?.rows.get(id),
          line: line.value ?? null,
          range,
          timeZone: ctx.timeZone,
          unreachable: !card && fleet.failed,
        });
      }
      case 'widget': {
        const home = this.#kept.peek<ScreenHomeWidget[]>(`home\n${viewer}`);
        if (!home.has) return home.failed ? failedView(spec, 'Widget', RESOLVE_WORDS.failed) : null;
        return homeWidgetView(
          spec.id,
          (home.value ?? []).find((w) => w.id === idOf(spec.ref)),
        );
      }
      case 'figures':
      case 'panel': {
        if (isAccountRef(spec.ref)) return this.#accounts.now(this.#kept, ctx, spec, viewer);
        const kept = this.#kept.peek<Resolved>(widgetKey(viewer, spec));
        if (!kept.value) return null;
        // Kept by what it shows: the same widget elsewhere has its own id.
        return { ...kept.value, view: { ...kept.value.view, id: spec.id } as DeskWidgetView };
      }
      default:
        return null;
    }
  }
}

/** The words that stand in for what's left out. */
const HIDDEN = DESK_SCREEN_WORDS.locked.hidden;

/**
 * A widget's view as the lock lets it show (DK-138): unlocked everything; in *A summary* a widget whose resolution
 * shows private words or pictures keeps only its title, what it belongs to, its mark and its colour, marked `locked`,
 * unless the person chose to show it on a locked screen (`opts.lock` `show`); in *Only the time* nothing.
 */
export function trimView(
  r: Resolved,
  opts: Readonly<Record<string, string>>,
  view: DeskCalmView,
): DeskWidgetView | null {
  if (view === 'time') return null;
  if (view === 'everything' || !r.private || opts.lock === 'show') return r.view;
  const v = r.view;
  const base = {
    id: v.id,
    title: v.title,
    ...(v.name ? { name: v.name } : {}),
    ...(v.mark ? { mark: v.mark } : {}),
    ...(v.tone ? { tone: v.tone } : {}),
    ...(v.problem ? { problem: v.problem } : {}),
    locked: true as const,
  };
  switch (v.kind) {
    case 'figures':
      return { kind: 'figures', ...base, items: [{ value: '—', label: HIDDEN }] };
    case 'list':
      return { kind: 'list', ...base, rows: [] };
    case 'posters':
      return { kind: 'posters', ...base, items: [], shape: v.shape };
    case 'chart':
      return { kind: 'chart', ...base, series: [{ points: [] }] };
    case 'camera':
      return { kind: 'camera', ...base };
    case 'server':
      return { kind: 'server', ...base, state: v.state, server: v.server };
    case 'text':
      return { kind: 'text', ...base, body: HIDDEN };
    case 'photo':
      return { kind: 'photo', ...base, items: [] };
    case 'board':
      return { kind: 'board', ...base, items: [] };
    case 'weather':
      return { kind: 'weather', ...base, unit: v.unit, hours: [], days: [], credit: v.credit };
  }
}

/** A picture as `viewPictures` keeps it: what it belongs to and its signed ref. */
export function pictureKey(thing: string, ref: string): string {
  return `${thing}\n${ref}`;
}

/**
 * Every picture the views name (`DeskImage`'s `{thing, ref}`, wherever a view keeps one), as `pictureKey`s: what a
 * screen showing these views may load, and nothing else (DK-142). A view the lock trimmed names none.
 */
export function viewPictures(views: readonly DeskWidgetView[]): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const o = value as Record<string, unknown>;
    if (typeof o.thing === 'string' && typeof o.ref === 'string') out.add(pictureKey(o.thing, o.ref));
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  for (const v of views) walk(v, 0);
  return out;
}

/** The views a screen may show now: trimmed by the lock, each checked against the contract (a bad one is left out). */
export function screenViews(
  specs: readonly DeskWidgetSpec[],
  resolved: ReadonlyMap<string, Resolved>,
  view: DeskCalmView,
  warn: (message: string, id: string) => void = () => {},
): DeskWidgetView[] {
  const out: DeskWidgetView[] = [];
  for (const spec of specs) {
    const r = resolved.get(spec.id);
    if (!r) continue;
    const trimmed = trimView(r, spec.opts ?? {}, view);
    if (!trimmed) continue;
    const parsed = DeskWidgetViewSchema.safeParse(trimmed);
    if (parsed.success) out.push(parsed.data);
    else warn('desk: a widget’s view isn’t one the screen takes', spec.id);
    if (out.length >= DESK_SCREEN_VIEWS_MAX) break;
  }
  return out;
}
