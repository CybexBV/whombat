/**
 * The calm glance in the runtime (docs/decisions/desk-display.md DK-101…DK-124; desk-display-server.md DK-S122…DK-S126):
 * what's true, gathered into core's `DeskCalmInput` — the asks, looks, work, servers and widgets from the glance's one
 * read of Home (`buildFullGlance`), the rest from the calm sources (`calm-sources.ts`) — for core's planner
 * (`deskCalmFor`), which decides what shows. The runtime never decides it again: it only gathers, and trims by the lock.
 * The sources' slow reads are kept a while (`CalmReads`), and one that is late gives what it gave before, so a glance
 * read stays as cheap as it was.
 */
import {
  DESK_CALM_WORDS,
  DESK_SHOW_KEY_RE,
  DeskCalm,
  type DeskCalmActivity,
  type DeskCalmComing,
  type DeskCalmInput,
  type DeskCalmLook,
  type DeskCalmServer,
  type DeskCalmView,
  type DeskDigest,
  type DeskPreview,
  type DeskPreviewScenario,
  type DeskShow,
  deskCalmFor,
  deskPreviewInput,
} from '@whombat/core';
import type { DeskCalmSources, DeskCalmViewer } from './calm-sources';
import { type FullGlance, screenText } from './glance';

/** A server's last hour is read again after a minute (DK-116). */
export const SPARKS_KEEP_MS = 60_000;
/** A filling disk's forecast after ten minutes: a week's rate barely moves in that time (DK-114). */
export const DISK_DAYS_KEEP_MS = 10 * 60_000;
/** A down server's guests after a minute (DK-113). */
export const RUNS_ON_KEEP_MS = 60_000;
/** How long a glance read waits for one source; a late one gives what it gave before, or nothing. */
export const CALM_SOURCE_WAIT_MS = 2_000;
/** What's coming up is read a day ahead; the planner shows one within two hours, or any pinned (DK-115). */
export const COMING_WITHIN_S = 24 * 3_600;
/** A server's disk this full makes its look say how full and when it fills (DK-114). */
export const DISK_LOOK_PCT = 85;

/** Something kept for `keepMs`: read again after it, a read at a time; a read that fails or is late keeps the last. */
class Kept<V> {
  readonly #entries = new Map<
    string,
    { at: number | null; value: V | undefined; loading: Promise<V> | null }
  >();

  constructor(private readonly wait: number) {}

  async get(key: string, now: number, keepMs: number, load: () => Promise<V>, none: V): Promise<V> {
    let entry = this.#entries.get(key);
    if (entry && entry.at !== null && now - entry.at < keepMs) return entry.value ?? none;
    if (!entry) {
      // Ids come and go (servers, guests): the oldest go first past a few hundred.
      if (this.#entries.size >= 500) this.#entries.delete(this.#entries.keys().next().value as string);
      entry = { at: null, value: undefined, loading: null };
      this.#entries.set(key, entry);
    }
    const kept = entry;
    kept.loading ??= load()
      .then((value) => {
        kept.value = value;
        return value;
      })
      .finally(() => {
        // A failure counts as a read too: it is tried again after `keepMs`, not at every glance.
        kept.at = now;
        kept.loading = null;
      });
    return settle(kept.loading, this.wait, kept.value ?? none);
  }
}

/** `promise`, or `fallback` when it fails or takes longer than `ms`. */
async function settle<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The calm sources as the glance reads them: kept as long as they stay true enough, never waited for long. */
export class CalmReads {
  readonly #sparks: Kept<Map<string, number[]>>;
  readonly #diskDays: Kept<number | null>;
  readonly #runsOn: Kept<string[]>;
  readonly #activities: Kept<DeskCalmActivity[]>;
  readonly #coming: Kept<DeskCalmComing[]>;
  readonly #update: Kept<DeskCalmInput['update'] | null>;

  constructor(
    readonly sources: DeskCalmSources,
    wait = CALM_SOURCE_WAIT_MS,
  ) {
    this.#sparks = new Kept(wait);
    this.#diskDays = new Kept(wait);
    this.#runsOn = new Kept(wait);
    this.#activities = new Kept(wait);
    this.#coming = new Kept(wait);
    this.#update = new Kept(wait);
  }

  /** Every server's last hour in one read a minute (a new server reads them all again). */
  sparks(burrowId: string, ids: readonly string[], now: Date): Promise<Map<string, number[]>> {
    if (ids.length === 0) return Promise.resolve(new Map());
    const key = `${burrowId}\n${[...ids].sort().join('\n')}`;
    return this.#sparks.get(
      key,
      now.getTime(),
      SPARKS_KEEP_MS,
      () => this.sources.sparks(burrowId, ids, now),
      new Map(),
    );
  }

  diskDays(burrowId: string, id: string, now: Date): Promise<number | null> {
    return this.#diskDays.get(
      `${burrowId}\n${id}`,
      now.getTime(),
      DISK_DAYS_KEEP_MS,
      () => this.sources.diskDays(burrowId, id, now),
      null,
    );
  }

  runsOn(burrowId: string, id: string, now: Date): Promise<string[]> {
    return this.#runsOn.get(
      `${burrowId}\n${id}`,
      now.getTime(),
      RUNS_ON_KEEP_MS,
      () => this.sources.runsOn(burrowId, id),
      [],
    );
  }

  /** What's going on, coming up and Whombat updating itself: read at every glance read, the last one when late. */
  activities(viewer: DeskCalmViewer, now: Date): Promise<DeskCalmActivity[]> {
    const key = `${viewer.burrowId}\n${viewer.personId}`;
    return this.#activities.get(key, now.getTime(), 0, () => this.sources.activities(viewer, now), []);
  }

  coming(viewer: DeskCalmViewer, now: Date): Promise<DeskCalmComing[]> {
    const key = `${viewer.burrowId}\n${viewer.personId}`;
    return this.#coming.get(
      key,
      now.getTime(),
      0,
      () => this.sources.coming(viewer, now, COMING_WITHIN_S),
      [],
    );
  }

  update(now: Date): Promise<DeskCalmInput['update'] | null> {
    return this.#update.get('update', now.getTime(), 0, () => this.sources.update(), null);
  }
}

/* What the sources give, as the screen may draw it ------------------------------------------------------------- */

const MARK_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** A mark the screen can draw (`@whombat/brand` slugs), or none. */
export function calmMark(mark: string | null | undefined): string | undefined {
  return mark && MARK_RE.test(mark) && mark !== 'device' ? mark : undefined;
}

/** A source's activity as the planner takes it: one line each, its key a choice's; none without a name or a value. */
export function calmActivity(a: DeskCalmActivity): DeskCalmActivity | null {
  const name = screenText(a.name, 40);
  const value = screenText(a.value, 40);
  if (!name || !value || !DESK_SHOW_KEY_RE.test(a.key)) return null;
  const detail = screenText(a.detail, 80);
  const mark = calmMark(a.mark);
  const progress = typeof a.progress === 'number' && Number.isFinite(a.progress) ? a.progress : undefined;
  return {
    key: a.key,
    name,
    value,
    active: a.active,
    ...(mark ? { mark } : {}),
    ...(detail ? { detail } : {}),
    ...(progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(progress))) } : {}),
  };
}

/** An automation's next run, named on one line, at a time the screen reads (RFC 3339). */
export function calmComing(c: DeskCalmComing): DeskCalmComing | null {
  const name = screenText(c.name, 40);
  const at = Date.parse(c.at);
  return name && Number.isFinite(at) ? { name, at: new Date(at).toISOString() } : null;
}

const UPDATING_RE = /updat|restart|install/i;

/** When a look began: a down server since it was last seen, else when this runtime saw it begin (`since`). */
type SinceOf = (key: string) => string | undefined;

/**
 * Everything the planner reads for the person (DK-112…DK-118), from the glance's read of Home (`full`) and the calm
 * sources. Not the digest: *Welcome back* is the moment's, added when the state is made.
 */
export async function deskCalmInput(
  full: FullGlance,
  reads: CalmReads,
  place: { viewer: DeskCalmViewer; assistant: string },
  now: Date,
  since: SinceOf = () => undefined,
): Promise<DeskCalmInput> {
  const { viewer } = place;
  const ids = full.servers.flatMap((s) => (s.id ? [s.id] : []));
  const cards = new Map(full.servers.flatMap((s) => (s.id ? [[s.id, s] as const] : [])));
  const filling = (look: FullGlance['everyLook'][number]) => {
    const disk = look.server ? cards.get(look.server)?.disk?.value : undefined;
    return look.kind === 'server' && look.server && disk !== undefined && disk >= DISK_LOOK_PCT ? disk : null;
  };
  const [sparks, activities, coming, update, looks] = await Promise.all([
    reads.sparks(viewer.burrowId, ids, now),
    reads.activities(viewer, now),
    reads.coming(viewer, now),
    reads.update(now),
    Promise.all(
      full.everyLook.map(async (look): Promise<DeskCalmLook> => {
        const pct = filling(look);
        const server = look.kind === 'server' ? look.server : undefined;
        const [runsOn, days] = await Promise.all([
          server && look.state === 'down' ? reads.runsOn(viewer.burrowId, server, now) : null,
          server && pct !== null ? reads.diskDays(viewer.burrowId, server, now) : null,
        ]);
        const began = (server ? full.downSince[server] : undefined) ?? since(look.key);
        const guests = (runsOn ?? []).map((g) => screenText(g, 40)).filter(Boolean);
        return {
          key: look.key,
          kind: look.kind,
          name: look.name,
          state: look.state,
          ...(look.reason ? { reason: look.reason } : {}),
          ...(look.server ? { server: look.server } : {}),
          ...(began ? { since: new Date(began).toISOString() } : {}),
          ...(guests.length > 0 ? { runsOn: guests } : {}),
          ...(pct !== null ? { disk: { pct, days } } : {}),
          // What the assistant found out (look-research.md LR-09): the planner puts its words on the hero.
          ...(look.research ? { research: look.research } : {}),
        };
      }),
    ),
  ]);
  const servers: DeskCalmServer[] = full.servers.map((s) => {
    const spark = s.id ? sparks.get(s.id) : undefined;
    return {
      ...(s.id ? { id: s.id } : {}),
      name: s.name,
      mark: s.mark,
      state: s.state,
      note: s.note,
      ...(s.cpu ? { cpu: s.cpu.value } : {}),
      ...(s.memory ? { memory: s.memory.value } : {}),
      ...(s.disk ? { disk: s.disk.value } : {}),
      ...(spark && spark.length > 0 ? { spark } : {}),
      ...(UPDATING_RE.test(s.note) ? { updating: true } : {}),
    };
  });
  return {
    assistant: place.assistant,
    now,
    timeZone: viewer.timeZone,
    asks: full.asks.map((a) => ({ number: a.number, title: a.title })),
    askCount: full.askCount,
    looks,
    work: full.work ? { ...full.work, ...(full.doing ? { doing: full.doing } : {}) } : null,
    servers,
    activities: activities.map(calmActivity).filter((a): a is DeskCalmActivity => a !== null),
    figures: full.figures,
    coming: coming
      .map(calmComing)
      .filter((c): c is DeskCalmComing => c !== null)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    services: full.services,
    doneCount: full.doneToday,
    ...(update ? { update } : {}),
  };
}

/* The calm glance now ----------------------------------------------------------------------------------------- */

/** Settings' *Try it on the screen* while it lasts (DK-124): the scenario, with the choices on Settings' page. */
export interface CalmSample {
  scenario: DeskPreviewScenario;
  show: DeskShow;
  until: number;
}

/**
 * The calm glance the screen shows now (DK-101…DK-124): the planner's, for the person's choices and what the lock lets
 * show (`view`: `everything` unlocked). While Settings tries a scenario on the screen it is that scenario's, with its
 * banner, still trimmed by the lock; *Welcome back* then waits. Null when what came out isn't one the screen takes (a
 * bug, logged by the caller): the screen then draws the glance beside it.
 */
export function calmNow(
  input: DeskCalmInput,
  show: DeskShow,
  view: DeskCalmView,
  now: Date,
  extra: { digest?: DeskDigest | null; sample?: CalmSample | null } = {},
): DeskCalm | null {
  const at = { ...input, now };
  const sample = extra.sample && extra.sample.until > now.getTime() ? extra.sample : null;
  const calm = sample
    ? {
        ...deskCalmFor(
          deskPreviewInput(at, sample.show, sample.scenario, DESK_CALM_WORDS),
          sample.show,
          view,
        ),
        sample: { scenario: sample.scenario, until: new Date(sample.until).toISOString() },
      }
    : deskCalmFor({ ...at, ...(extra.digest ? { digest: extra.digest } : {}) }, show, view);
  const parsed = DeskCalm.safeParse(calm);
  return parsed.success ? parsed.data : null;
}

/**
 * Settings' preview (`desk.preview`, DK-123): the calm glance for `show` and `scenario` as the person sees it at the
 * screen unlocked, with the name the top bar shows.
 */
export function calmPreview(
  input: DeskCalmInput,
  show: DeskShow,
  scenario: DeskPreviewScenario,
  name: string,
  now: Date,
): DeskPreview {
  const at = deskPreviewInput({ ...input, now }, show, scenario, DESK_CALM_WORDS);
  return { name, calm: DeskCalm.parse(deskCalmFor(at, show, 'everything')) };
}
