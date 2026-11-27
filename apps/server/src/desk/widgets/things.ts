/**
 * Every connection's and device's widgets (docs/decisions/desk-display.md DK-138, DK-139, DK-142, DK-148;
 * desk-display-server.md “Every connection's widgets”): the screens' `ThingWidgets`, built on the things' pages.
 *
 * - **Groups** (`groups`, *Add a widget*): one per connection and device the viewer sees with a page (Home's things),
 *   designed kinds first then the rest, each by name: its figures and every panel of its page worth a screen
 *   (`thing-views.ts`, with the kind's hints from `thing-kinds.ts`). What a page offers is kept 10 minutes; a page not
 *   read within 3 seconds gives its figures and `partial` while its read goes on for the next time. Asked for one thing,
 *   its page is read now.
 * - **Resolving** (`resolve`): the specs grouped by thing and range, each page read once (`things.page`'s read and its
 *   caches; one read shared by every screen asking within 5 seconds), then mapped. A thing that is down says so, with
 *   the machine it runs on when that is down too; a page that can't be read now shows the last one of the past 10
 *   minutes, else says why; a panel the page leaves out now is empty when it was seen before or its kind says it
 *   comes and goes (pages leave out what has nothing to show), else says it's gone. Figures refresh every minute, a
 *   camera every 10 seconds, a panel at its page's pace (never under 10 seconds); a kind's hints may ask for slower. A
 *   photo view's pictures are the page's, made large (`largeImageRef`).
 * - **Private** (DK-138): cameras, controls that open, lock or watch the house, and what each kind marks
 *   (`thing-kinds.ts`): a panel, its whole page, or the figures that are money or a person.
 *
 * `createThingWidgets(services)` is the runtime's; tests pass their own reads (`ThingWidgetsDeps`).
 */
import {
  DESK_WIDGET_RANGES,
  DESK_WIDGET_REF_RE,
  type DeskCatalogGroup,
  type DeskWidgetRef,
  type DeskWidgetSpec,
  DeskWidgetView,
  type DeskWidgetViewKind,
  deskScreenWords,
  deskWidgetLimits,
  type ThingPage,
  thingId,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { catalogConnections } from '../../db/schema/index';
import { deviceThings } from '../../devices/home';
import { DEVICE_CATALOG_ID } from '../../devices/store';
import { homeShowsConnection } from '../../home/overview';
import { type ServerMessageKey, tServer } from '../../i18n/catalog';
import { onLocaleChange } from '../../i18n/locale';
import { ApiError } from '../../lib/errors';
import type { Services } from '../../services';
import { largeImageRef } from '../../things/images';
import { kindOf } from '../../things/kinds/index';
import { thingPageInEnglish } from '../../things/page';
import { displayName } from '../../things/part-of';
import type { PageRange } from '../../things/series';
import { calmMark } from '../calm';
import { deskFleet } from '../glance';
import { kindHints } from './thing-kinds';
import {
  catalogItems,
  emptyView,
  figuresPrivate,
  figuresView,
  HEAD_FIGURES,
  headFigures,
  isCameraGallery,
  largePhotos,
  type Panel,
  pagePanels,
  panelHint,
  panelPrivate,
  panelView,
  screenPanels,
  screenViewOf,
  textView,
  type ViewBase,
  words,
} from './thing-views';
import type { Resolved, ThingWidgets, WidgetCtx } from './types';

/** What a page offers *Add a widget* is kept this long. */
export const PANELS_KEEP_MS = 10 * 60_000;
/** *Add a widget* waits this long for a page before it lists the thing's figures alone (`partial`). */
export const GROUPS_WAIT_MS = 3_000;
/** *Add a widget* reads at most this many pages at once (a burrow with forty services mustn't read forty at once). */
export const GROUPS_READS_AT_ONCE = 6;
/** A page read is shared by every screen asking within this long. */
export const PAGE_SHARE_MS = 5_000;
/** A page read gets this long; past it the widgets show the last page or say why. */
export const PAGE_DEADLINE_MS = 12_000;
/** A page that couldn't be read again stands in for this long. */
export const LAST_PAGE_KEEP_MS = 10 * 60_000;
/** How often each kind of widget is read again (DK-148), in seconds. */
export const FIGURES_REFRESH_S = 60;
export const CAMERA_REFRESH_S = 10;
export const PROBLEM_REFRESH_S = 30;
export const MIN_REFRESH_S = 10;
export const PAGE_REFRESH_DEFAULT_S = 60;
/** What the runtime remembers of pages it read (names, panels' views), at most. */
const MEMORY_MAX = 4096;

/** A thing the viewer sees with a page of its own. */
export interface ThingEntry {
  ref: DeskWidgetRef;
  name: string;
  catalogId: string | null;
}

/** What the widgets read; the runtime's from `createThingWidgets(services)`, tests' their own. */
export interface ThingWidgetsDeps {
  /** The connections and devices the viewer sees that have a page. */
  things(ctx: WidgetCtx): Promise<ThingEntry[]>;
  /** A thing's page as `things.page` reads it, over `range`. */
  page(ctx: WidgetCtx, thing: DeskWidgetRef, range: PageRange): Promise<ThingPage>;
  /** Whether a server of the fleet is down now; null when that can't be told. */
  serverDown(ctx: WidgetCtx): Promise<(serverId: string) => boolean | null>;
  /** Milliseconds now, for what is kept. */
  clock(): number;
  /** Something that can't be shown, for the log. */
  warn?(message: string, fields: Record<string, unknown>): void;
  /** A page's picture as a large one, for a photo view ('' when it can't be); without it the page's own. */
  largeImage?(ref: string): string;
}

/** The things of Home with a page (`things.page` finds them): connections the agent uses and switched-on devices. */
async function homeThings(services: Services, ctx: WidgetCtx): Promise<ThingEntry[]> {
  const [rows, devices] = await Promise.all([
    services.db
      .select({
        id: catalogConnections.id,
        catalogId: catalogConnections.catalogId,
        label: catalogConnections.label,
        fields: catalogConnections.fields,
      })
      .from(catalogConnections)
      .where(eq(catalogConnections.burrowId, ctx.viewer.burrowId)),
    deviceThings({
      db: services.db,
      burrowId: ctx.viewer.burrowId,
      personId: ctx.viewer.principal.id,
      now: ctx.now,
      services,
    }).catch(() => []),
  ]);
  return [
    ...rows
      .filter((r) => r.catalogId !== DEVICE_CATALOG_ID && homeShowsConnection(r.catalogId))
      .map((r) => ({ ref: thingId('connection', r.id), name: displayName(r), catalogId: r.catalogId })),
    // A device still being learned has no readings to show yet.
    ...devices
      .filter((d) => d.status !== 'learning')
      .map((d) => ({ ref: d.id, name: d.name, catalogId: d.catalogId ?? DEVICE_CATALOG_ID })),
  ].filter((t) => DESK_WIDGET_REF_RE.test(t.ref));
}

/** The runtime's reads. */
export function runtimeDeps(services: Services): ThingWidgetsDeps {
  return {
    things: (ctx) => homeThings(services, ctx),
    // In English: the views below read its words, and the screen says the finished view in the person's language.
    page: (ctx, thing, range) => thingPageInEnglish(services, ctx.viewer, thing, ctx.timeZone, range),
    async serverDown(ctx) {
      const fleet = await deskFleet(services, ctx.viewer.burrowId, 3_000).catch(() => null);
      const rows = fleet ? [...fleet.rows.values()] : null;
      return (id) => {
        if (!rows) return null;
        const row = rows.find((s) => s.id === id);
        return row ? row.status === 'offline' : null;
      };
    },
    clock: () => services.clock().getTime(),
    warn: (message, fields) => services.log.warn(fields, message),
    largeImage: (ref) => largeImageRef(services.custody, ref, services.clock()),
  };
}

/** `promise`, or `fallback` after `ms` (the promise goes on). */
function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  promise.catch(() => undefined);
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const LATE = Symbol('late');

/** Runs at most `n` of the works given at once, the rest in the order they came. */
function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        work()
          .then(resolve, reject)
          .finally(() => {
            running--;
            waiting.shift()?.();
          });
      };
      if (running < n) start();
      else waiting.push(start);
    });
}

/** A map that forgets its oldest entries past `max`. */
class Memory<V> {
  readonly #m = new Map<string, V>();
  constructor(readonly max = MEMORY_MAX) {}
  get(key: string): V | undefined {
    return this.#m.get(key);
  }
  set(key: string, value: V): void {
    this.#m.delete(key);
    this.#m.set(key, value);
    for (const k of this.#m.keys()) {
      if (this.#m.size <= this.max) break;
      this.#m.delete(k);
    }
  }
  delete(key: string): void {
    this.#m.delete(key);
  }
  clear(): void {
    this.#m.clear();
  }
}

/** What a page offered *Add a widget*, and when. */
interface Offered {
  at: number;
  group: DeskCatalogGroup;
}

/** A panel of a page as it was last seen: what it became, so a panel left out for a while stays itself. */
interface SeenPanel {
  view: DeskWidgetViewKind;
  shape?: 'poster' | 'wide' | 'square';
}

const isThingRef = (ref: string | undefined): ref is DeskWidgetRef =>
  !!ref && DESK_WIDGET_REF_RE.test(ref) && (ref.startsWith('connection:') || ref.startsWith('device:'));

/** The page range a widget's `range` asks for; the page gives its default for one it doesn't offer. */
function rangeOf(spec: DeskWidgetSpec): PageRange {
  const r = spec.opts?.range;
  return (DESK_WIDGET_RANGES as readonly string[]).includes(r ?? '') ? (r as PageRange) : '24h';
}

const isGone = (err: unknown) => err instanceof ApiError && err.code === 'not_found';

export function createThingWidgets(
  services: Services,
  deps: ThingWidgetsDeps = runtimeDeps(services),
): ThingWidgets {
  const offered = new Memory<Offered>();
  const reading = new Map<string, { at: number; page: Promise<ThingPage> }>();
  const lastPages = new Memory<{ at: number; page: ThingPage }>(256);
  const seen = new Memory<SeenPanel>();
  const names = new Memory<string>();
  const gate = limiter(GROUPS_READS_AT_ONCE);
  const localeKey = (ctx: WidgetCtx) => ctx.locale ?? 'en';
  onLocaleChange(services, () => {
    offered.clear();
    reading.clear();
    lastPages.clear();
  });

  /** Remembers what a page showed: its name, its panels' views, what it offers *Add a widget*. */
  function learn(ctx: WidgetCtx, thing: DeskWidgetRef, page: ThingPage, at: number): DeskCatalogGroup {
    const scope = `${ctx.viewer.burrowId}|${thing}`;
    const langScope = `${scope}|${localeKey(ctx)}`;
    names.set(scope, page.name);
    const hints = kindHints(page.catalogId);
    for (const p of screenPanels(page, hints, ctx)) {
      const view = screenViewOf(p, panelHint(hints, p.id));
      if (view) seen.set(`${scope}|${p.id}`, { view, ...(p.kind === 'gallery' ? { shape: p.shape } : {}) });
    }
    const mark = calmMark(page.catalogId);
    const group: DeskCatalogGroup = {
      key: words(thing, 120),
      label: words(page.name, 80) || words(thing, 80),
      ...(mark ? { mark } : {}),
      thing,
      items: catalogItems(page, thing, hints, mark, ctx),
    };
    offered.set(langScope, { at, group });
    return group;
  }

  /** One read of a page shared by every widget and screen asking within `PAGE_SHARE_MS`; the outcome is learnt. */
  function readPage(ctx: WidgetCtx, thing: DeskWidgetRef, range: PageRange): Promise<ThingPage> {
    const key = `${ctx.viewer.principal.id}|${thing}|${range}|${localeKey(ctx)}`;
    const now = deps.clock();
    for (const [k, v] of reading) if (now - v.at > PAGE_SHARE_MS) reading.delete(k);
    const shared = reading.get(key);
    if (shared) return shared.page;
    const page = deps.page(ctx, thing, range).then((p) => {
      const at = deps.clock();
      lastPages.set(key, { at, page: p });
      learn(ctx, thing, p, at);
      return p;
    });
    page.catch(() => reading.delete(key));
    reading.set(key, { at: now, page });
    return page;
  }

  /** A group of *Add a widget* from what is kept, else the page read within `ms` (then its figures and `partial`). */
  async function groupOf(ctx: WidgetCtx, t: ThingEntry, ms: number): Promise<DeskCatalogGroup | null> {
    const langScope = `${ctx.viewer.burrowId}|${t.ref}|${localeKey(ctx)}`;
    const kept = offered.get(langScope);
    if (kept && deps.clock() - kept.at <= PANELS_KEEP_MS) return kept.group;
    // The wait counts from the ask: a read still waiting for its turn is as slow as one under way.
    const read = gate(() => readPage(ctx, t.ref, '24h'));
    try {
      const page = await within(read, ms, LATE);
      if (page !== LATE) return offered.get(langScope)?.group ?? null;
    } catch (err) {
      if (isGone(err)) return null;
    }
    // Not read in time, or not readable now: its figures, and the rest when the page answers.
    const mark = calmMark(t.catalogId);
    const figureWords = deskScreenWords(ctx.locale).figures;
    return {
      key: words(t.ref, 120),
      label: words(t.name, 80) || words(t.ref, 80),
      ...(mark ? { mark } : {}),
      thing: t.ref,
      items: [
        {
          type: 'figures',
          ref: t.ref,
          opts: {},
          name: figureWords.name,
          line: figureWords.line,
          ...(mark ? { mark } : {}),
          view: 'figures',
        },
      ],
      partial: true,
    };
  }

  async function groups(ctx: WidgetCtx, thing?: DeskWidgetRef): Promise<DeskCatalogGroup[]> {
    if (thing !== undefined) {
      if (!isThingRef(thing)) return [];
      const one = (await deps.things(ctx)).find((t) => t.ref === thing);
      if (!one) return [];
      // Asked alone: read it now, whatever is kept.
      offered.delete(`${ctx.viewer.burrowId}|${thing}|${localeKey(ctx)}`);
      const group = await groupOf(ctx, one, PAGE_DEADLINE_MS);
      return group ? [group] : [];
    }
    const things = (await deps.things(ctx)).sort(
      (a, b) =>
        Number(!kindOf(a.catalogId ?? '')) - Number(!kindOf(b.catalogId ?? '')) ||
        a.name.localeCompare(b.name),
    );
    const out = await Promise.all(things.map((t) => groupOf(ctx, t, GROUPS_WAIT_MS).catch(() => null)));
    return out.filter((g): g is DeskCatalogGroup => g !== null);
  }

  async function resolve(ctx: WidgetCtx, specs: readonly DeskWidgetSpec[]): Promise<Map<string, Resolved>> {
    const out = new Map<string, Resolved>();
    const mine = specs.filter((s) => (s.type === 'figures' || s.type === 'panel') && isThingRef(s.ref));
    const byPage = new Map<string, { thing: DeskWidgetRef; range: PageRange; specs: DeskWidgetSpec[] }>();
    for (const s of mine) {
      const range = s.type === 'panel' ? rangeOf(s) : '24h';
      const key = `${s.ref}|${range}`;
      const entry = byPage.get(key) ?? { thing: s.ref as DeskWidgetRef, range, specs: [] };
      entry.specs.push(s);
      byPage.set(key, entry);
    }
    let fleet: Promise<(id: string) => boolean | null> | null = null;
    const downServer = (id: string) => {
      fleet ??= deps.serverDown(ctx).catch(() => () => null);
      return fleet.then((f) => f(id));
    };
    await Promise.all(
      [...byPage.values()].map(async ({ thing, range, specs: group }) => {
        const answered = await pageFor(ctx, thing, range);
        const down = answered.page ? await downProblem(answered.page, downServer, ctx.locale) : null;
        for (const spec of group)
          out.set(spec.id, checked(ctx, spec, answer(ctx, spec, thing, answered, down)));
      }),
    );
    return out;
  }

  /** The page now, else the last of the past 10 minutes, else why there is none. */
  async function pageFor(
    ctx: WidgetCtx,
    thing: DeskWidgetRef,
    range: PageRange,
  ): Promise<{ page: ThingPage | null; gone?: boolean }> {
    try {
      const page = await within(readPage(ctx, thing, range), PAGE_DEADLINE_MS, LATE);
      if (page !== LATE) return { page };
    } catch (err) {
      if (isGone(err)) return { page: null, gone: true };
    }
    const last = lastPages.get(`${ctx.viewer.principal.id}|${thing}|${range}|${localeKey(ctx)}`);
    return last && deps.clock() - last.at <= LAST_PAGE_KEEP_MS ? { page: last.page } : { page: null };
  }

  /** A thing that is down: “Plex isn’t answering”, and “It runs on pve-02, which is down.” when that is down too. */
  async function downProblem(
    page: ThingPage,
    downServer: (id: string) => Promise<boolean | null>,
    locale?: string,
  ): Promise<{ text: string; detail?: string } | null> {
    if (page.status !== 'offline') return null;
    const text = tServer(locale, 'desk.widget.notAnswering', { name: page.name });
    const server = page.runsOn ? (page.runsOn.name.split(' · ')[0] ?? page.runsOn.name) : null;
    if (page.runsOn && server && (await downServer(page.runsOn.serverId)))
      return { text, detail: tServer(locale, 'desk.widget.runsOnDown', { server }) };
    return { text };
  }

  function answer(
    ctx: WidgetCtx,
    spec: DeskWidgetSpec,
    thing: DeskWidgetRef,
    answered: { page: ThingPage | null; gone?: boolean },
    down: { text: string; detail?: string } | null,
  ): Resolved {
    const scope = `${ctx.viewer.burrowId}|${thing}`;
    const page = answered.page;
    const name = page?.name ?? names.get(scope) ?? '';
    const panelId = spec.type === 'panel' ? (spec.opts?.panel ?? '') : HEAD_FIGURES;
    const hints = kindHints(page?.catalogId);
    const hint = panelHint(hints, panelId);
    const known = seen.get(`${scope}|${panelId}`);
    const mark = calmMark(page?.catalogId);
    // A kind's name for a panel is the widget's title too, so the screen says what *Add a widget* said.
    const title = spec.type === 'figures' ? name : (hint?.name ?? panelTitle(page, panelId) ?? name);
    const say = (key: ServerMessageKey, vars?: Record<string, string>) => tServer(ctx.locale, key, vars);
    const b: ViewBase = {
      id: spec.id,
      title: title || name || say('desk.widget.figures'),
      ...(name && spec.type === 'panel' ? { name } : {}),
      ...(mark ? { mark } : {}),
      ...(page?.readAt ? { at: page.readAt } : {}),
    };
    const problem = (text: string, detail?: string, tone: 'bad' | 'warn' = 'warn'): Resolved => ({
      view: textView(b, text, { text, ...(detail ? { detail } : {}) }, tone),
      private: false,
      refreshS: PROBLEM_REFRESH_S,
    });
    if (answered.gone) return problem(say('desk.widget.gone'));
    if (!page)
      return problem(name ? say('desk.widget.couldntReadName', { name }) : say('desk.widget.couldntRead'));
    if (down) return problem(down.text, down.detail, 'bad');
    const isPrivate = (p: Panel | null, view: DeskWidgetView) =>
      !!hints.private ||
      !!hint?.private ||
      view.kind === 'camera' ||
      (p !== null && panelPrivate(p, spec.opts?.item, hints.guards, !!hint?.poster));

    if (spec.type === 'figures') {
      const head = headFigures(page, hints);
      // A kind that couldn't read leaves the page its generic figures (“Status · Working”): why it couldn't says more.
      const unread = !!page.problem && !!kindOf(page.catalogId ?? '') && head.some((k) => k.key === 'status');
      const view = unread ? null : figuresView(b, head, hints.figure);
      if (!view)
        return page.problem
          ? problem(page.problem)
          : {
              view: textView(b, say('desk.widget.noFigures')),
              private: false,
              refreshS: FIGURES_REFRESH_S,
            };
      return {
        view,
        private: figuresPrivate(hints, head),
        refreshS: Math.max(FIGURES_REFRESH_S, hints.refreshS ?? 0),
      };
    }

    const panel = screenPanels(page, hints, ctx).find((p) => p.id === panelId) ?? null;
    // A panel's own pace (a photo frame's) wins; a kind's wins where the page's is more than its widgets need
    // (storage and backups change slowly), but not while the page shows something moving or an old reading.
    const pace =
      hint?.refreshS !== undefined
        ? Math.max(MIN_REFRESH_S, hint.refreshS)
        : paceOf(hints.refreshS ?? page.refreshS ?? PAGE_REFRESH_DEFAULT_S, page.refreshS);
    if (!panel) {
      // A kind's read that failed takes its panels with it: why is the page's problem.
      if (page.problem) return problem(page.problem);
      const empty = hint?.always ? { view: hint.always } : known;
      if (empty && ['list', 'posters', 'photo', 'board'].includes(empty.view))
        return {
          view: emptyView(b, empty, hint?.empty),
          private: !!hints.private || !!hint?.private,
          refreshS: pace,
        };
      return problem(
        name ? say('desk.widget.noLongerShownName', { name }) : say('desk.widget.noLongerShown'),
      );
    }
    const drawn = panelView({
      b,
      thing,
      page,
      panel,
      item: spec.opts?.item,
      hint,
      limits: deskWidgetLimits(spec.opts),
      now: ctx.now,
      timeZone: ctx.timeZone,
    });
    const view = drawn && deps.largeImage ? largePhotos(drawn, deps.largeImage) : drawn;
    if (!view) {
      if (spec.opts?.item !== undefined)
        return problem(
          isCameraGallery(panel) || panel.kind === 'controls'
            ? name
              ? say('desk.widget.noLongerInName', { name })
              : say('desk.widget.noLongerIn')
            : name
              ? say('desk.widget.noLongerShownName', { name })
              : say('desk.widget.noLongerShown'),
        );
      return { view: textView(b, say('desk.widget.nothing')), private: false, refreshS: pace };
    }
    return {
      view,
      private: isPrivate(panel, view),
      refreshS: view.kind === 'camera' ? CAMERA_REFRESH_S : pace,
    };
  }

  /** A view the contract takes, or why it can't be shown (logged): a bad view must never cost the screen its grid. */
  function checked(ctx: WidgetCtx, spec: DeskWidgetSpec, r: Resolved): Resolved {
    if (DeskWidgetView.safeParse(r.view).success) return r;
    deps.warn?.('A thing widget gave a view the screen can’t take', {
      widget: spec.id,
      ref: spec.ref,
      panel: spec.opts?.panel,
      burrowId: ctx.viewer.burrowId,
    });
    const text = tServer(ctx.locale, 'desk.widget.couldntShow');
    return {
      view: textView(
        { id: spec.id, title: words(r.view.title, 60) || tServer(ctx.locale, 'desk.widget.widget') },
        text,
        { text },
        'warn',
      ),
      private: r.private,
      refreshS: PROBLEM_REFRESH_S,
    };
  }

  return { groups, resolve };
}

/**
 * How long a widget keeps what it drew: its own pace, but no longer than its page's while the page asks again sooner
 * than usual, because something moves (a download, a scrub) or it showed an older reading while a newer one was on its
 * way. Otherwise a slow kind's widget would stay one read behind for its whole pace.
 */
export function paceOf(own: number, pageS: number | undefined): number {
  const pace = pageS !== undefined && pageS < PAGE_REFRESH_DEFAULT_S ? Math.min(own, pageS) : own;
  return Math.max(MIN_REFRESH_S, pace);
}

/** A panel's title on the page, when it has one. */
function panelTitle(page: ThingPage | null, panelId: string): string | null {
  if (!page) return null;
  const p = pagePanels(page).find((x) => x.id === panelId);
  return p && 'title' in p && p.title ? p.title : null;
}
