/**
 * A connection's or device's widgets from its page (docs/decisions/desk-display.md DK-139, DK-142;
 * desk-display-server.md “Every connection's widgets”): every panel of a thing's page can be a widget, so a service has
 * widgets the day it has a page. Pure: a page in, *Add a widget*'s items and the widgets' views out.
 *
 * - **What can be a widget**: the head figures (`figures`) and every panel of every tab but the ones about Whombat itself
 *   (what it may do, what it changed, “Show more here”) and “Part of …”. A gallery of camera snapshots and a camera
 *   among the controls are a camera each; a sensor or thermostat among the controls is a figure of its own.
 * - **Views**: figures → figures (four at most); a chart → a chart (three lines, 120 points); a list, table, bar list,
 *   controls, facts and Worth a look → a list; a gallery → posters; text → text. A kind's hint may draw a gallery as a
 *   photo (one big picture at a time, `PanelHint.view`) or a table, list or bar list as a board (a small named tile each,
 *   up to 48, coloured by the row). Words become one line of the screen's
 *   length (no markdown, no odd spaces), times “21:00”, “Thu” or “14 Nov”, shares whole percents.
 * - **Pictures** keep the page's signed ref with the thing they belong to, so whoever draws them loads them through the
 *   checks the page's pictures have; a photo view's are made large by the runtime (`largePhotos`).
 * - A kind's hints (`KindHints`, `thing-kinds.ts`) put its best panels first, name them better, keep listing a panel the
 *   page leaves out while it has nothing to show, and add a big line where a list needs one.
 */
import {
  DESK_PHOTO_EVERY_S,
  DESK_SCREEN_WORDS,
  DESK_VIEW_PHOTOS_MAX,
  DESK_VIEW_POINTS_MAX,
  DESK_VIEW_ROWS_MAX,
  DESK_VIEW_TILES_MAX,
  type DeskCatalogItem,
  type DeskImage,
  type DeskViewFigure,
  type DeskViewPhoto,
  type DeskViewPoster,
  type DeskViewRow,
  type DeskViewTile,
  type DeskViewTone,
  type DeskWidgetRef,
  type DeskWidgetView,
  type DeskWidgetViewKind,
  deskText,
  type ThingControl,
  type ThingGalleryItem,
  type ThingImage,
  type ThingLine,
  type ThingPage,
  type ThingPageCell,
  type ThingPageItem,
  type ThingPageKpi,
  type ThingPagePanel,
  type ThingPageRow,
} from '@whombat/core';
import { isSnapshotRef } from '../../things/images';
import { clock, dateWords, dayMonth } from '../../things/words';

export type Panel = ThingPagePanel;
export { dateWords };

type PanelOf<K extends Panel['kind']> = Extract<Panel, { kind: K }>;

/* A kind's hints --------------------------------------------------------------------------------------------------- */

/** What a kind says about one panel of its page as a widget, where the generic mapping falls short. */
export interface PanelHint {
  panel: string;
  /** *Add a widget*'s name and line instead of the panel's title and the words made from what it shows. */
  name?: string;
  line?: string;
  /**
   * Listed and drawn even while the page leaves it out (a page leaves out a panel with nothing to show: Plex's *Now
   * playing* while nobody watches): drawn as this view, empty, with `empty`.
   */
  always?: Extract<DeskWidgetViewKind, 'list' | 'posters'>;
  /** Its words when there's nothing in it. */
  empty?: string;
  /** The big line over its rows (“3 left · about 20 min”, “2 watching”), from the page. */
  head?: (page: ThingPage, panel: Panel | null) => string | null;
  /**
   * A table's columns for a row's words on the right (`meta`), under it (`detail`) and as its time (`time`, “2 h ago”),
   * where the first ones say little; `note: false` leaves the title's own note out (a release's file name under its
   * episode).
   */
  columns?: {
    meta?: string;
    detail?: readonly string[];
    time?: string;
    note?: false;
    /** A column's words in a sentence, `{text}` its cell's (“{text} left” for a time that's left). */
    say?: Readonly<Record<string, string>>;
  };
  /** A row's title as a person reads it (a release's file name as its show and episode). */
  title?: (text: string) => string;
  /** A poster's words where the gallery's own say two things in one (“2024 · John · Living room TV”). */
  poster?: (item: ThingGalleryItem) => Partial<Pick<DeskViewPoster, 'detail' | 'who' | 'time'>>;
  /** It shows words or pictures a locked screen leaves out (DK-138). */
  private?: boolean;
  /** Not offered: it says little on a screen. */
  skip?: boolean;
  /** How often its widget is read again, in seconds, where the page's pace is more than it needs. */
  refreshS?: number;
  /**
   * A panel the screen makes from the page itself, under `panel` as its id (a calmer form of one of its panels, figures
   * from a chart): offered and drawn like the page's own while it gives one, so only where this one has the data.
   */
  from?: (page: ThingPage, at: PanelsAt) => Panel | null;
  /** A gallery of camera snapshots is offered as one widget too: every camera's picture side by side, as posters. */
  mosaic?: boolean;
  /**
   * Drawn as a photo (a gallery: one big picture at a time with its words under it) or a board (a table, list or bar
   * list: a small named tile each, up to 48) instead of posters or a list, or a gallery as a list (its rows have no
   * pictures: SABnzbd's downloads). With `from`, a widget beside the page's own.
   */
  view?: 'photo' | 'board' | 'list';
  /** A board's tiles, where the rows' own words and colours say them badly. */
  board?: BoardHint;
  /** A photo view shows its next picture after this many seconds (two minutes unless said). */
  every?: number;
}

/** How a board makes its tiles from a panel's rows. */
export interface BoardHint {
  /** The column whose words a tile shows (a list's and a bar list's: the words on the right). */
  value?: string;
  /** Every tile says its words; otherwise only one that isn't fine (a wall of “Running” says nothing). */
  values?: 'all';
  /** The columns whose dots and tones colour a tile; otherwise every cell's. */
  tone?: readonly string[];
  /** A tile's words or colour from its row's cells, where the columns say them badly (“Update” for an older version). */
  tile?: (
    cells: Readonly<Record<string, ThingPageCell>>,
  ) => Partial<Pick<DeskViewTile, 'value' | 'tone'>> | null;
  /** The worst first: red, amber, grey, then the fine ones; otherwise the page's order. */
  worstFirst?: boolean;
}

/** When the screen asks: what a made panel calls “today”. */
export interface PanelsAt {
  now: Date;
  timeZone: string;
}

export interface KindHints {
  /** Its panels' hints, best widget first: *Add a widget* lists these before the rest, in this order. */
  panels?: readonly PanelHint[];
  /** The head figure that leads its *Figures* widget (its line and small line are the widget's). */
  figure?: string;
  /** Everything it shows is private (money, the person's tasks). */
  private?: boolean;
  /** Head figures that are money or a person: the *Figures* widget is private while one of them is among its four. */
  privateFigures?: readonly string[];
  /**
   * Live rows (by panel id) that are each a figure of their own rather than counted: Fusebox's limits, each row's bar
   * its share used (“Claude · week 62 %”) under the row's id.
   */
  rowFigures?: readonly string[];
  /** A control of its page that watches the house or says who is home, beyond locks, alarms, doors and cameras. */
  guards?: (control: ThingControl) => boolean;
  /** Whether a Home widget the assistant made from one of its tools shows what a locked screen leaves out, by its arguments. */
  privateSource?: (args: Record<string, unknown>) => boolean;
  /** How often its widgets are read again, in seconds, where the page's pace is more than they need. */
  refreshS?: number;
}

export const NO_HINTS: KindHints = {};

export function panelHint(hints: KindHints, panel: string): PanelHint | undefined {
  return hints.panels?.find((h) => h.panel === panel);
}

/* Words ------------------------------------------------------------------------------------------------------------ */

/** One line as a screen draws it: plain words without markdown, at most `max` code points; '' when nothing is left. */
export function words(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return deskText(text.normalize('NFC').replace(/[*`]+/g, ''), max);
}

const RANGE_WORDS: Record<string, string> = {
  '1h': 'hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

const lineText = (l: ThingLine) => l.map((p) => p.text).join('');

/** “Dune, The Bear and 10 more”: a few names of what a panel shows. */
function sample(names: readonly string[]): string {
  const all = names.filter(Boolean);
  const shown = all.slice(0, 2);
  if (!shown.length) return '';
  const rest = all.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : (shown[0] as string);
}

/** “Movies, Shows and Watching now”. */
function andList(names: readonly string[]): string {
  const xs = names.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const pct = (share: number | null | undefined) =>
  typeof share === 'number' && Number.isFinite(share)
    ? Math.max(0, Math.min(100, Math.round(share * 100)))
    : undefined;

const TONES: Record<string, DeskViewTone | undefined> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  off: 'off',
  muted: 'off',
};
const toneOf = (t: string | null | undefined): DeskViewTone | undefined => (t ? TONES[t] : undefined);
const tone = (t: string | null | undefined) => {
  const v = toneOf(t);
  return v ? { tone: v } : {};
};

/** A series' colour as a tone: amber and red are warnings, grey is off; the chart colours are the drawing's own. */
const SERIES_TONE: Record<string, DeskViewTone | undefined> = { amber: 'warn', red: 'bad', grey: 'off' };

/** A row's time: “21:00” today, “Thu” within the week either way, else “14 Nov”. */
export function rowTime(at: string | undefined, now: Date, timeZone: string): string | undefined {
  if (!at) return undefined;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return undefined;
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  if (day(when) === day(now)) return clock(when, timeZone);
  if (Math.abs(when.getTime() - now.getTime()) < 6 * 86_400_000)
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(when);
  return dayMonth(when, timeZone);
}

/** A page's picture as a screen names it: the thing it belongs to and the page's signed ref. */
export function deskImage(thing: DeskWidgetRef, image: ThingImage | undefined): DeskImage | undefined {
  if (!image) return undefined;
  const alt = image.alt.slice(0, 120);
  return { thing, ref: image.ref, shape: image.shape, ...(alt ? { alt } : {}) };
}

/** At most `max` points, each the average of the ones it stands for (a bucket with none read stays null). */
export function squeeze(values: readonly (number | null)[], max = DESK_VIEW_POINTS_MAX): (number | null)[] {
  const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  if (values.length <= max) return values.map(round);
  const out: (number | null)[] = [];
  for (let g = 0; g < max; g++) {
    const xs = values
      .slice(Math.floor((g * values.length) / max), Math.floor(((g + 1) * values.length) / max))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    out.push(xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  }
  return out;
}

/* What a page has ------------------------------------------------------------------------------------------------- */

/** Panels about Whombat itself, not the thing: never a widget. */
const NOT_WIDGETS = new Set<Panel['kind']>(['access', 'changes', 'widgets']);
const NOT_WIDGET_IDS = new Set(['part-of']);
/** The head figures' panel on every page (`things/page.ts`, `devices.ts`). */
export const HEAD_FIGURES = 'figures';

/** Every panel of a page that can be a widget, the Summary's first; the first of an id wins. */
export function pagePanels(page: ThingPage): Panel[] {
  const seen = new Set<string>();
  const out: Panel[] = [];
  for (const tab of page.tabs)
    for (const p of tab.panels) {
      if (seen.has(p.id) || NOT_WIDGETS.has(p.kind) || NOT_WIDGET_IDS.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  return out;
}

/** The page's panels and the ones its kind's hints make from it (`PanelHint.from`); the page's own win an id. */
export function screenPanels(page: ThingPage, hints: KindHints, at: PanelsAt): Panel[] {
  const out = pagePanels(page);
  for (const h of hints.panels ?? []) {
    if (!h.from || out.some((p) => p.id === h.panel)) continue;
    const made = h.from(page, at);
    if (made) out.push({ ...made, id: h.panel });
  }
  return out;
}

/**
 * The head figures: the Summary's figures panel, else its first row of figures. A service in slots has no row of
 * figures (docs/decisions/service-slots.md): its figures are what its live rows count (Plex's Now playing) and each
 * line of its counts (Movies 1,284).
 */
export function headFigures(page: ThingPage, hints?: Pick<KindHints, 'rowFigures'>): ThingPageKpi[] {
  const panels = page.tabs[0]?.panels ?? [];
  const head =
    panels.find((p): p is PanelOf<'kpis'> => p.kind === 'kpis' && p.id === HEAD_FIGURES) ??
    panels.find((p): p is PanelOf<'kpis'> => p.kind === 'kpis');
  return head?.items ?? slotFigures(panels, hints?.rowFigures);
}

/** A figure's key from a title: “TV Shows” → `tv-shows`. */
const keyOf = (title: string) =>
  `f-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`.slice(0, 40);

/** A line's colour on a desk: amber or red from the line itself or its count (a 92 % full pool stays amber). */
function lineTone(i: ThingPageItem): 'warn' | 'bad' | null {
  if (i.tone === 'bad' || i.figure?.tone === 'bad') return 'bad';
  if (i.tone === 'warn' || i.figure?.tone === 'warn') return 'warn';
  return null;
}

/**
 * A slots page's figures: each live gallery's count under its id (or, for the galleries `rows` names, each row's share
 * under the row's id, its tag's colour kept), each line of a live list with a figure under the line's id (Pi-hole's
 * Blocked, red while blocking is off), then each line of its counts, each keeping its colour.
 */
export function slotFigures(panels: readonly Panel[], rows: readonly string[] = []): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  for (const p of panels)
    if (p.kind === 'gallery' && p.look === 'rows' && rows.includes(p.id))
      for (const i of p.items) {
        if (i.progress === undefined) continue;
        const sub = i.noteEnd ?? i.note;
        const tone = i.badge?.tone === 'bad' || i.badge?.tone === 'warn' ? i.badge.tone : null;
        out.push({
          key: i.id.slice(0, 40),
          label: i.title.slice(0, 30),
          value: `${Math.round(i.progress * 100)} %`,
          ...(sub ? { sub: sub.slice(0, 80) } : {}),
          ...(tone ? { tone } : {}),
        });
      }
    else if (p.kind === 'gallery' && p.look === 'rows')
      out.push({
        key: p.id,
        label: p.title.slice(0, 30),
        value: String(p.total ?? p.items.length),
        ...(p.meta ? { sub: p.meta.slice(0, 80) } : {}),
      });
  for (const p of panels)
    if (p.kind === 'list' && !p.look && p.place === 'chart')
      for (const i of p.items)
        if (i.figure) {
          const sub = i.figure.note ?? i.detail;
          const tone = lineTone(i);
          out.push({
            key: i.id.slice(0, 40),
            label: i.title.slice(0, 30),
            value: i.figure.value,
            ...(sub ? { sub: sub.slice(0, 80) } : {}),
            ...(tone ? { tone } : {}),
          });
        }
  for (const p of panels)
    if (p.kind === 'list' && p.look === 'counts')
      for (const i of p.items)
        if (i.figure) {
          const tone = lineTone(i);
          out.push({
            key: keyOf(i.title),
            label: i.title.slice(0, 30),
            value: i.figure.value,
            ...(i.figure.note ? { sub: i.figure.note.slice(0, 80) } : {}),
            ...(tone ? { tone } : {}),
          });
        }
  return out.slice(0, 6);
}

/** A gallery of camera snapshots: each item is a camera (a camera widget each). */
export function isCameraGallery(p: Panel): p is PanelOf<'gallery'> {
  return p.kind === 'gallery' && p.items.some((i) => i.image && isSnapshotRef(i.image.ref));
}

const isCameraControl = (c: ThingControl) => !!c.image;
/** A control that only reads (a sensor) or a thermostat: a figure of its own. */
const isFigureControl = (c: ThingControl) =>
  !c.image &&
  !c.toggle &&
  !c.buttons?.length &&
  (c.icon === 'sensor' || c.icon === 'thermostat' || !!c.stepper);

/** The view a panel becomes on a screen, with its kind's hint: a photo or a board where the hint asks and it can. */
export function screenViewOf(p: Panel, hint?: PanelHint): DeskWidgetViewKind | null {
  if (hint?.view === 'photo' && p.kind === 'gallery' && !isCameraGallery(p)) return 'photo';
  if (hint?.view === 'board' && (p.kind === 'table' || p.kind === 'list' || p.kind === 'bars'))
    return 'board';
  if (hint?.mosaic && isCameraGallery(p)) return 'posters';
  if (hint?.view === 'list' && p.kind === 'gallery') return 'list';
  return viewKindOf(p);
}

/**
 * The page's panel `id` with the most in it: a Summary that shows the first 15 containers of 41 has them all on a tab of
 * its own, under the same id. As a hint's `from`, a board or photo of it beside the page's own widget.
 */
export function wholePanel(id: string) {
  return (page: ThingPage): Panel | null => fullest(page, id);
}

function fullest(page: ThingPage, id: string): Panel | null {
  const size = (x: Panel) =>
    x.kind === 'table'
      ? x.rows.length
      : x.kind === 'list' || x.kind === 'bars' || x.kind === 'gallery'
        ? x.items.length
        : 0;
  let best: Panel | null = null;
  let meta: string | undefined;
  for (const tab of page.tabs)
    for (const p of tab.panels) {
      if (p.id !== id) continue;
      if (!best || (p.kind === best.kind && size(p) > size(best))) best = p;
      meta ??= 'meta' in p ? (p.meta ?? undefined) : undefined;
    }
  if (!best || NOT_WIDGETS.has(best.kind)) return null;
  // A tab's whole list often goes without the Summary's line over it (“41 containers”): it keeps that line.
  const listed =
    best.kind === 'table' || best.kind === 'list' || best.kind === 'bars' || best.kind === 'gallery';
  return listed && !(best as { meta?: string }).meta && meta ? ({ ...best, meta } as Panel) : best;
}

/** The view a panel becomes; null for one that is no widget. */
export function viewKindOf(p: Panel): DeskWidgetViewKind | null {
  if (NOT_WIDGETS.has(p.kind) || NOT_WIDGET_IDS.has(p.id)) return null;
  switch (p.kind) {
    case 'kpis':
      return 'figures';
    case 'chart':
      return 'chart';
    case 'gallery':
      return isCameraGallery(p) ? 'camera' : 'posters';
    case 'text':
      return 'text';
    default:
      return 'list';
  }
}

/** A widget's item on a panel: a camera of a gallery, a control (`opts.item`). */
export interface PanelItem {
  id: string;
  title: string;
  line: string;
  view: 'camera' | 'figures';
}

/** At most this many of a panel's items are offered as widgets of their own. */
export const PANEL_ITEMS_MAX = 12;
const CAMERA_LINE = 'Its latest picture, every few seconds';

/** The items of a panel that are widgets of their own: its cameras, and the controls that are a figure. */
export function panelItems(p: Panel): PanelItem[] {
  const ok = (id: string) => words(id, 120) === id;
  if (p.kind === 'gallery' && isCameraGallery(p))
    return p.items
      .filter((i) => i.image && ok(i.id))
      .slice(0, PANEL_ITEMS_MAX)
      .map((i) => ({ id: i.id, title: i.title, line: CAMERA_LINE, view: 'camera' as const }));
  if (p.kind === 'controls')
    return p.groups
      .flatMap((g) => g.items.map((c) => ({ g, c })))
      .filter(({ c }) => ok(c.id) && (isCameraControl(c) || isFigureControl(c)))
      .slice(0, PANEL_ITEMS_MAX)
      .map(({ g, c }) =>
        isCameraControl(c)
          ? { id: c.id, title: c.label, line: CAMERA_LINE, view: 'camera' as const }
          : {
              id: c.id,
              title: c.label,
              line: [g.id !== 'other' && g.title !== c.label ? g.title : null, c.state]
                .filter(Boolean)
                .join(' · '),
              view: 'figures' as const,
            },
      );
  return [];
}

/** Controls that open, lock or watch the house: a locked screen leaves them out (DK-138), and what the kind adds. */
const GUARDED = new Set<ThingControl['icon']>(['lock', 'alarm', 'door', 'camera']);
export const guardsHouse = (p: Panel, item?: string, guards?: KindHints['guards']): boolean => {
  const guarded = (c: ThingControl) => GUARDED.has(c.icon) || !!guards?.(c);
  return (
    p.kind === 'controls' &&
    p.groups.some((g) =>
      g.items.some((c) =>
        item === undefined ? !isCameraControl(c) && guarded(c) : c.id === item && guarded(c),
      ),
    )
  );
};

/** The head figures its *Figures* widget shows, its lead first; a version number only when there is nothing else. */
export function shownFigures(kpis: readonly ThingPageKpi[], lead?: string): ThingPageKpi[] {
  const ordered = lead
    ? [...kpis.filter((k) => k.key === lead), ...kpis.filter((k) => k.key !== lead)]
    : kpis;
  const said = ordered.filter((k) => figureOf(k) !== null);
  const more = said.filter((k) => k.key !== 'version');
  return (more.length ? more : said).slice(0, 4);
}

/** Whether its *Figures* widget shows what a locked screen leaves out: everything is, or one of its four figures. */
export function figuresPrivate(hints: KindHints, kpis: readonly ThingPageKpi[]): boolean {
  if (hints.private) return true;
  const secret = hints.privateFigures ?? [];
  return shownFigures(kpis, hints.figure).some((k) => secret.includes(k.key));
}

/* Add a widget ----------------------------------------------------------------------------------------------------- */

/** A few words about what a panel shows, from what it shows now. */
export function panelLine(p: Panel, page: ThingPage): string {
  switch (p.kind) {
    case 'kpis':
      return andList(p.items.map((k) => k.label));
    case 'chart':
      return `${andList(p.series.slice(0, 3).map((s) => s.label))} over the last ${RANGE_WORDS[page.range ?? '24h'] ?? '24 h'}`;
    case 'list':
      return sample(p.items.map((i) => i.title)) || (p.empty ?? '');
    case 'table': {
      const first = p.columns[0]?.key;
      return sample(p.rows.map((r) => (first ? (r.cells[first]?.text ?? '') : ''))) || (p.empty ?? '');
    }
    case 'bars':
      return sample(p.items.map((b) => b.label)) || (p.empty ?? '');
    case 'gallery':
      return sample(p.items.map((i) => i.title)) || (p.empty ?? '');
    case 'controls': {
      const all = p.groups.flatMap((g) => g.items).filter((c) => !isCameraControl(c));
      return sample(all.map((c) => c.label)) || (p.empty ?? '');
    }
    case 'facts':
      return andList(p.items.slice(0, 3).map((f) => f.label));
    case 'notices': {
      const open = p.items.filter((n) => !n.quiet);
      return open.length ? sample(open.map((n) => n.title)) : (p.empty ?? 'Nothing needs a look.');
    }
    case 'text':
      return p.body.split(/(?<=[.!?])\s/)[0] ?? p.body;
    default:
      return '';
  }
}

/** A panel's name: its title, else its figures' labels. */
function panelName(p: Panel): string {
  if ('title' in p && p.title) return p.title;
  if (p.kind === 'kpis') return andList(p.items.slice(0, 3).map((k) => k.label));
  return '';
}

/** What a page offers *Add a widget*: its figures, its hinted panels (best first), then every other panel in order. */
export function catalogItems(
  page: ThingPage,
  thing: DeskWidgetRef,
  hints: KindHints,
  mark: string | undefined,
  at?: PanelsAt,
): DeskCatalogItem[] {
  const out: DeskCatalogItem[] = [];
  const base = { ref: thing, ...(mark ? { mark } : {}) };
  const head = headFigures(page, hints);
  out.push({
    type: 'figures',
    ...base,
    opts: {},
    name: DESK_SCREEN_WORDS.figures.name,
    line:
      words(andList(shownFigures(head, hints.figure).map((k) => k.label)), 120) ||
      DESK_SCREEN_WORDS.figures.line,
    view: 'figures',
    ...(figuresPrivate(hints, head) ? { private: true } : {}),
  });
  const panels = (at ? screenPanels(page, hints, at) : pagePanels(page)).filter((p) => p.id !== HEAD_FIGURES);
  const order = (hints.panels ?? []).map((h) => h.panel);
  // Hinted panels first, in the hint's order; then the page's order, with Worth a look last.
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i >= 0 ? i : id === 'notices' ? order.length + 1 : order.length;
  };
  const listed = new Set<string>();
  const items: { at: number; item: DeskCatalogItem }[] = [];
  // The same rule as resolving's: what a locked screen leaves out unless the person chose to show it.
  const secret = (p: Panel, view: string, item?: string) =>
    !!hints.private ||
    !!panelHint(hints, p.id)?.private ||
    view === 'camera' ||
    guardsHouse(p, item, hints.guards);
  for (const [i, p] of panels.entries()) {
    const hint = panelHint(hints, p.id);
    const view = screenViewOf(p, hint);
    listed.add(p.id);
    if (!view || hint?.skip) continue;
    const cameras = panelItems(p);
    if (view !== 'camera') {
      const name = words(hint?.name ?? panelName(p), 60);
      if (name)
        items.push({
          at: rank(p.id) * 1000 + i,
          item: {
            type: 'panel',
            ...base,
            opts: { panel: p.id },
            name,
            line: words(hint?.line ?? panelLine(p, page), 120) || name,
            view,
            ...(secret(p, view) ? { private: true } : {}),
          },
        });
    }
    for (const [j, c] of cameras.entries()) {
      const name = words(c.title, 60);
      if (!name) continue;
      items.push({
        at: rank(p.id) * 1000 + i + (j + 1) / 100,
        item: {
          type: 'panel',
          ...base,
          opts: { panel: p.id, item: c.id },
          name,
          line: words(c.line, 120) || name,
          view: c.view,
          ...(secret(p, c.view, c.id) ? { private: true } : {}),
        },
      });
    }
  }
  // A panel the page leaves out while it has nothing to show is still offered.
  for (const h of hints.panels ?? [])
    if (h.always && !listed.has(h.panel) && !h.skip && h.name)
      items.push({
        at: rank(h.panel) * 1000,
        item: {
          type: 'panel',
          ...base,
          opts: { panel: h.panel },
          name: words(h.name, 60),
          line: words(h.line ?? h.empty ?? h.name, 120),
          view: h.always,
          ...(hints.private || h.private ? { private: true } : {}),
        },
      });
  out.push(...items.sort((a, b) => a.at - b.at).map((x) => x.item));
  return out.slice(0, CATALOG_ITEMS_MAX);
}

/** A group of *Add a widget* lists at most this many (the contract's). */
export const CATALOG_ITEMS_MAX = 48;

/* The views -------------------------------------------------------------------------------------------------------- */

/** What every view of a thing's widget carries. */
export interface ViewBase {
  id: string;
  title: string;
  name?: string;
  mark?: string;
  at?: string;
}

const base = (b: ViewBase) => ({
  id: b.id,
  title: words(b.title, 60) || '·',
  ...(b.name && words(b.name, 40) && words(b.name, 40) !== words(b.title, 60)
    ? { name: words(b.name, 40) }
    : {}),
  ...(b.mark ? { mark: b.mark } : {}),
  ...(b.at ? { at: b.at } : {}),
});

/** A text view: a few sentences, and why it can't show what it shows when there's a `problem`. */
export function textView(
  b: ViewBase,
  body: string,
  problem?: { text: string; detail?: string | null },
  t?: DeskViewTone,
): DeskWidgetView {
  const text = problem ? words(problem.text, 120) : '';
  const detail = problem?.detail ? words(problem.detail, 200) : '';
  return {
    kind: 'text',
    ...base(b),
    ...(t ? { tone: t } : {}),
    ...(text ? { problem: { text, ...(detail ? { detail } : {}) } } : {}),
    body: (body.trim() || text || '·').slice(0, 600),
  };
}

function figureOf(k: Pick<ThingPageKpi, 'value' | 'rest' | 'label' | 'tone'>): DeskViewFigure | null {
  const value = words(k.value, 24);
  const label = words(k.label, 40);
  if (!value || !label) return null;
  // Words after the value that are longer than a unit (“of 171 integrations”) would be cut mid-word: left out.
  const rest = k.rest?.trim() ?? '';
  const unit = rest && [...rest].length <= 12 ? words(rest, 12) : '';
  return { value, ...(unit ? { unit } : {}), label, ...tone(k.tone) };
}

/** Figures (four at most); the first one's line under them, its small line and its bar. */
export function figuresView(
  b: ViewBase,
  kpis: readonly ThingPageKpi[],
  lead?: string,
): DeskWidgetView | null {
  const pairs = shownFigures(kpis, lead)
    .map((k) => ({ k, f: figureOf(k) }))
    .filter((x): x is { k: ThingPageKpi; f: DeskViewFigure } => x.f !== null);
  const first = pairs[0]?.k;
  if (!first) return null;
  const line = words(first.sub, 120);
  const spark = (first.spark ?? []).filter((v): v is number => v !== null && Number.isFinite(v));
  const progress = pct(first.meter);
  return {
    kind: 'figures',
    ...base(b),
    items: pairs.map((x) => x.f),
    ...(line ? { line } : {}),
    ...(spark.length >= 2 ? { spark: squeeze(spark) as number[] } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

/** A series' last value read with its unit (“0.2 %”); '' when it read nothing. */
function lastReading(s: { values: readonly (number | null)[]; unit?: string | undefined }): string {
  const last = [...s.values].reverse().find((v): v is number => v !== null && Number.isFinite(v));
  if (last === undefined) return '';
  return `${Math.round(last * 10) / 10}${s.unit ? ` ${s.unit}` : ''}`;
}

/** A chart: its figure, two lines of facts, up to three lines (left axis first) and four facts under it. */
export function chartView(b: ViewBase, p: PanelOf<'chart'>): DeskWidgetView | null {
  // A second unit on the right (memory in GB beside CPU in %) can't share the screen's one scale: not drawn.
  const left = p.series.filter((s) => s.axis !== 'right');
  const series = (left.length ? left : p.series).slice(0, 3).map((s) => {
    const label = words(s.label, 40);
    const t = s.color ? SERIES_TONE[s.color] : undefined;
    return { ...(label ? { label } : {}), points: squeeze(s.values), ...(t ? { tone: t } : {}) };
  });
  if (!series.length) return null;
  const value = words(p.figure?.value, 40);
  const rest = words(p.figure?.rest, 60);
  // A line on the right axis is said in words instead (“Loss 0.2 %”), before the page's own second line.
  const right = left.length ? p.series.filter((s) => s.axis === 'right').slice(0, 2) : [];
  const rightWords = words(
    right.map((s) => `${s.label} ${s.latest ?? lastReading(s)}`.trim()).join(' · '),
    80,
  );
  const own = (p.stats ?? []).map((l) => words(lineText(l), 80)).filter(Boolean);
  const stats = rightWords ? [...own.slice(0, 1), rightWords] : own.slice(0, 2);
  const unit = words(p.axis?.unit ?? left[0]?.unit, 12);
  const foot = (p.foot ?? [])
    .map((f) => ({ label: words(f.label, 30), value: words(f.value, 40) }))
    .filter((f) => f.label && f.value)
    .slice(0, 4);
  return {
    kind: 'chart',
    ...base(b),
    ...(value ? { figure: { value, ...(rest ? { rest } : {}), ...tone(p.figure?.tone) } } : {}),
    ...(stats.length ? { stats } : {}),
    series,
    ...(unit ? { unit } : {}),
    ...(p.line && Number.isFinite(p.line.value) ? { limit: p.line.value } : {}),
    ...(foot.length ? { foot } : {}),
  };
}

function row(r: {
  title: string;
  detail?: string | null | undefined;
  meta?: string | null | undefined;
  time?: string | undefined;
  tone?: string | null | undefined;
  progress?: number | undefined;
  state?: 'on' | 'off' | undefined;
  image?: DeskImage | undefined;
}): DeskViewRow | null {
  const title = words(r.title, 120);
  if (!title) return null;
  // Words the row already says once aren't said twice (a notice whose detail is its title, a date as time and meta).
  const detail = words(r.detail, 120) === title ? '' : words(r.detail, 120);
  const time = words(r.time, 16);
  const meta = words(r.meta, 40) === time ? '' : words(r.meta, 40);
  const said = detail === meta ? '' : detail;
  return {
    title,
    ...(said ? { detail: said } : {}),
    ...(meta ? { meta } : {}),
    ...(time ? { time } : {}),
    ...tone(r.tone),
    ...(r.progress !== undefined ? { progress: r.progress } : {}),
    ...(r.state ? { state: r.state } : {}),
    ...(r.image ? { image: r.image } : {}),
  };
}

const rowsOf = (xs: (DeskViewRow | null)[]) => xs.filter((r): r is DeskViewRow => r !== null);

/** What a list panel's rows say. */
export interface ListParts {
  rows: DeskViewRow[];
  total: number;
  empty?: string | undefined;
  head?: string | null | undefined;
  progress?: number | undefined;
}

export function listView(b: ViewBase, parts: ListParts): DeskWidgetView {
  const rows = parts.rows.slice(0, DESK_VIEW_ROWS_MAX);
  const head = words(parts.head, 80);
  const empty = words(parts.empty, 120);
  return {
    kind: 'list',
    ...base(b),
    ...(head ? { head } : {}),
    ...(parts.progress !== undefined ? { progress: parts.progress } : {}),
    rows,
    ...(parts.total > rows.length ? { count: Math.min(parts.total, 1_000_000) } : {}),
    ...(empty ? { empty } : {}),
  };
}

function itemRows(
  thing: DeskWidgetRef,
  items: readonly ThingPageItem[],
  now: Date,
  timeZone: string,
  title?: PanelHint['title'],
) {
  return rowsOf(
    items.slice(0, DESK_VIEW_ROWS_MAX).map((i) =>
      row({
        title: title ? title(i.title) : i.title,
        detail: i.detail,
        meta: i.right,
        time: rowTime(i.at, now, timeZone),
        tone: i.tone,
        image: deskImage(thing, i.image),
      }),
    ),
  );
}

/** A gallery's items as rows: its words, what it is on the right, how far, and how long is left (or its tag). */
function galleryRows(p: PanelOf<'gallery'>, title?: PanelHint['title']) {
  return rowsOf(
    p.items.slice(0, DESK_VIEW_ROWS_MAX).map((i) =>
      row({
        title: title ? title(i.title) : i.title,
        detail: i.paused ? 'Paused' : (i.noteEnd ?? i.badge?.text),
        meta: i.sub,
        tone: i.badge?.tone,
        ...(pct(i.progress) !== undefined ? { progress: pct(i.progress) } : {}),
      }),
    ),
  );
}

/** A cell that says there's nothing (“—”). */
const NOTHING = /^\s*[—–-]?\s*$/;

/** The colour a row of cells takes: red or amber from any cell, else its first cell's dot or tone, else any dot. */
function rowTone(first: ThingPageCell, all: readonly ThingPageCell[]): string | undefined {
  const marks = all.flatMap((c) => [c.dot, c.tone]);
  if (marks.includes('bad')) return 'bad';
  if (marks.includes('warn')) return 'warn';
  return first.dot ?? first.tone ?? all.find((c) => c.dot)?.dot;
}

/**
 * A table's rows as a list: the first column with words is the title (its note leads the detail), the first figure
 * column after it that isn't the row's bar the words on the right — else the bar's own words (“4.9 of 7.7 TB”) — the
 * other columns the detail (a kind's hint may choose them, and a column for the time); a cell's bar is the row's, the
 * worst of its cells' dots and tones its colour. Buttons and small lines are left out.
 */
function tableRows(
  p: PanelOf<'table'>,
  chosen?: PanelHint['columns'],
  title?: PanelHint['title'],
): DeskViewRow[] {
  const columns = p.columns;
  return rowsOf(
    p.rows.slice(0, DESK_VIEW_ROWS_MAX).map((r) => {
      const cells = columns
        .map((c) => ({ c, cell: r.cells[c.key] }))
        .filter((x) => x.cell && !x.cell.action && !x.cell.button && !NOTHING.test(x.cell.text));
      const [first, ...shown] = cells;
      if (!first?.cell) return null;
      const time = chosen?.time ? shown.find((x) => x.c.key === chosen.time) : undefined;
      const rest = shown.filter((x) => x !== time);
      const say = (x: (typeof cells)[number] | undefined) => {
        if (!x?.cell) return undefined;
        const text = x.cell.note ? `${x.cell.text} (${x.cell.note})` : x.cell.text;
        const sentence = chosen?.say?.[x.c.key];
        return sentence ? sentence.replace('{text}', text) : text;
      };
      const hasBar = (x: (typeof cells)[number]) => typeof x.cell?.meter === 'number';
      const figureAt = rest.findIndex((x) => x.c.numeric && !hasBar(x));
      const metaAt = chosen?.meta
        ? rest.findIndex((x) => x.c.key === chosen.meta)
        : figureAt >= 0
          ? figureAt
          : rest.findIndex(hasBar);
      const meta = metaAt >= 0 ? rest[metaAt] : undefined;
      const lead =
        first.cell.note && chosen?.note !== false
          ? { c: first.c, cell: { text: first.cell.note } }
          : undefined;
      // The row's bar (its first) says itself; another bar's words go under the title.
      const bar = rest.find(hasBar);
      const others = [
        lead,
        ...(chosen?.detail
          ? chosen.detail.map((k) => rest.find((x) => x.c.key === k))
          : rest.filter((x, i) => i !== metaAt && x !== bar)),
      ];
      const heading = title ? title(first.cell.text) : first.cell.text;
      // A second bar's words say what they measure (“Disk 3.1 of 10 GB”).
      const sayUnder = (x: (typeof cells)[number] | undefined) =>
        x && hasBar(x) && x.c.label ? `${x.c.label} ${say(x)}` : say(x);
      const parts = others
        .map(sayUnder)
        .filter((t): t is string => !!t && t !== first.cell?.text && t !== heading);
      const detail = [...new Set(parts)].join(' · ');
      const all = columns.map((c) => r.cells[c.key]).filter((c): c is ThingPageCell => !!c);
      const meter = all.find((c) => typeof c.meter === 'number')?.meter;
      return row({
        title: heading,
        detail,
        meta: say(meta),
        time: time?.cell?.text,
        tone: rowTone(first.cell, all),
        progress: pct(meter),
      });
    }),
  );
}

function barRows(p: PanelOf<'bars'>): DeskViewRow[] {
  return rowsOf(
    p.items.slice(0, DESK_VIEW_ROWS_MAX).map((b) =>
      row({
        title: b.label,
        detail: b.sub ?? b.note,
        meta: b.value,
        tone: b.tone ?? b.subTone,
        progress: pct(b.pct),
      }),
    ),
  );
}

/**
 * Controls that are on or off as a lamp is (a light, a switch, a fan, a plug): what “N on” counts and what draws a lit
 * dot. A lock, an alarm, a door, a blind or a player is on in another sense (unlocked, armed, open, playing): its row
 * says its state in words instead, so an unlocked door never reads as a light left on.
 */
const LAMPS: ReadonlySet<string> = new Set(['light', 'switch', 'fan', 'plug']);
const lampLike = (c: ThingControl) => c.on !== undefined && (c.icon === undefined || LAMPS.has(c.icon));

/** The controls as rows: on or off where they switch, their state's words; cameras are widgets of their own. */
function controlRows(
  p: PanelOf<'controls'>,
  now: Date,
  timeZone: string,
): {
  rows: DeskViewRow[];
  total: number;
  on: number;
  switches: number;
} {
  const groups = p.groups.filter((g) => g.items.some((c) => !isCameraControl(c)));
  const named = groups.length > 1;
  const all = groups.flatMap((g) => g.items.filter((c) => !isCameraControl(c)).map((c) => ({ g, c })));
  const rows = rowsOf(
    all.slice(0, DESK_VIEW_ROWS_MAX).map(({ g, c }) =>
      row({
        title: c.label,
        detail: c.state && (dateWords(c.state, now, timeZone) ?? c.state),
        meta: named && g.id !== 'other' && g.title !== c.label ? g.title : undefined,
        tone: c.tone,
        ...(lampLike(c) ? { state: c.on ? 'on' : 'off' } : {}),
      }),
    ),
  );
  const switches = all.filter((x) => lampLike(x.c));
  return { rows, total: all.length, on: switches.filter((x) => x.c.on).length, switches: switches.length };
}

function factRows(p: PanelOf<'facts'>): DeskViewRow[] {
  return rowsOf(
    p.items.slice(0, DESK_VIEW_ROWS_MAX).map((f) => {
      const short = [...f.value.trim()].length <= 40;
      return row({ title: f.label, ...(short ? { meta: f.value } : { detail: f.value }) });
    }),
  );
}

function noticeRows(p: PanelOf<'notices'>): { rows: DeskViewRow[]; total: number } {
  const open = p.items.filter((n) => !n.quiet);
  return {
    rows: rowsOf(
      open
        .slice(0, DESK_VIEW_ROWS_MAX)
        .map((n) => row({ title: n.title, detail: n.detail, tone: n.tone === 'info' ? undefined : n.tone })),
    ),
    total: open.length,
  };
}

/** A gallery as posters: title, its words, its bar and the words under it; the picture keeps the gallery's shape. */
export function postersView(
  b: ViewBase,
  thing: DeskWidgetRef,
  p: PanelOf<'gallery'>,
  hint?: PanelHint,
  head?: string | null,
): DeskWidgetView {
  const items = p.items.slice(0, DESK_VIEW_ROWS_MAX).flatMap((i): DeskViewPoster[] => {
    const title = words(i.title, 120);
    if (!title) return [];
    const own = hint?.poster?.(i) ?? {};
    const detail = words(own.detail ?? i.sub, 120);
    const who = words(own.who, 80);
    const time = words(own.time ?? i.note ?? i.badge?.text, 40);
    const progress = pct(i.progress);
    const image = deskImage(thing, i.image);
    return [
      {
        title,
        ...(detail ? { detail } : {}),
        ...(who ? { who } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(time ? { time } : {}),
        ...(image ? { image } : {}),
      },
    ];
  });
  const h = words(head, 80);
  const empty = words(hint?.empty ?? p.empty, 120);
  return {
    kind: 'posters',
    ...base(b),
    ...(h ? { head: h } : {}),
    items,
    shape: p.shape,
    ...(empty ? { empty } : {}),
  };
}

/** A gallery as a photo view: one big picture at a time, its title and words under it; only items with a picture. */
export function photoView(
  b: ViewBase,
  thing: DeskWidgetRef,
  p: PanelOf<'gallery'>,
  hint?: PanelHint,
): DeskWidgetView {
  const items = p.items
    .flatMap((i): DeskViewPhoto[] => {
      const image = deskImage(thing, i.image);
      if (!image) return [];
      const caption = words(i.title, 80);
      const time = words(i.sub ?? i.note, 40);
      return [{ image, ...(caption ? { caption } : {}), ...(time && time !== caption ? { time } : {}) }];
    })
    .slice(0, DESK_VIEW_PHOTOS_MAX);
  const every = hint?.every
    ? Math.max(DESK_PHOTO_EVERY_S.min, Math.min(DESK_PHOTO_EVERY_S.max, Math.round(hint.every)))
    : undefined;
  const empty = words(hint?.empty ?? p.empty, 120);
  return {
    kind: 'photo',
    ...base(b),
    items,
    ...(every ? { every } : {}),
    ...(empty ? { empty } : {}),
  };
}

/** A photo view with its pictures made large (1280 px, signed by the runtime); one that can't be is left out. */
export function largePhotos(view: DeskWidgetView, enlarge: (ref: string) => string): DeskWidgetView {
  if (view.kind !== 'photo') return view;
  return {
    ...view,
    items: view.items.flatMap((i) => {
      const ref = enlarge(i.image.ref);
      return ref ? [{ ...i, image: { ...i.image, ref } }] : [];
    }),
  };
}

const TILE_RANK: Record<DeskViewTone, number> = { bad: 0, warn: 1, off: 2, ok: 3 };

/** A tile's colour from its cells: red or amber from any, else the first dot, else the first tone, else grey. */
function tileTone(cells: readonly (ThingPageCell | undefined)[]): DeskViewTone {
  const marks = cells.flatMap((c) => (c ? [c.dot, c.tone] : []));
  if (marks.includes('bad')) return 'bad';
  if (marks.includes('warn')) return 'warn';
  const dot = cells.map((c) => toneOf(c?.dot)).find(Boolean);
  return dot ?? cells.map((c) => toneOf(c?.tone)).find(Boolean) ?? 'off';
}

/** Short words a tile can carry whole (a longer one would be cut mid-word: left out). */
const tileValue = (text: string | null | undefined) => {
  const w = words(text, 40);
  return w && [...w].length <= 16 ? w : '';
};

function tableTiles(p: PanelOf<'table'>, hint?: PanelHint): DeskViewTile[] {
  const board = hint?.board;
  return p.rows.flatMap((r: ThingPageRow): DeskViewTile[] => {
    const first = p.columns
      .map((c) => r.cells[c.key])
      .find((c) => c && !c.action && !c.button && !NOTHING.test(c.text));
    const label = first ? words(hint?.title ? hint.title(first.text) : first.text, 40) : '';
    if (!label) return [];
    const marked = board?.tone ? board.tone.map((k) => r.cells[k]) : p.columns.map((c) => r.cells[c.key]);
    const own = board?.tile?.(r.cells) ?? {};
    const value = board?.value ? r.cells[board.value]?.text : undefined;
    return [
      {
        label,
        tone: own.tone ?? tileTone(marked),
        ...(own.value ? { value: own.value } : value ? { value } : {}),
      },
    ];
  });
}

/**
 * A table, list or bar list as a board: a tile each, named by its first words, coloured by its row (the worst of its
 * cells' dots and tones), with short words where it isn't fine (or always, as the hint says); the worst first where the
 * hint asks; how many in all past 48.
 */
export function boardView(
  b: ViewBase,
  p: PanelOf<'table' | 'list' | 'bars'>,
  hint?: PanelHint,
  head?: string | null,
): DeskWidgetView {
  const all =
    p.kind === 'table'
      ? tableTiles(p, hint)
      : p.kind === 'list'
        ? p.items.map((i) => ({
            label: words(hint?.title ? hint.title(i.title) : i.title, 40),
            tone: toneOf(i.tone) ?? 'off',
            value: i.right ?? undefined,
          }))
        : p.items.map((x) => ({ label: words(x.label, 40), tone: toneOf(x.tone) ?? 'off', value: x.value }));
  const said = all
    .filter((t) => t.label)
    .map((t): DeskViewTile => {
      const value = hint?.board?.values === 'all' || t.tone !== 'ok' ? tileValue(t.value) : '';
      return { label: t.label, tone: t.tone, ...(value ? { value } : {}) };
    });
  const ordered = hint?.board?.worstFirst
    ? said
        .map((t, i) => ({ t, i }))
        .sort((x, y) => TILE_RANK[x.t.tone] - TILE_RANK[y.t.tone] || x.i - y.i)
        .map((x) => x.t)
    : said;
  const items = ordered.slice(0, DESK_VIEW_TILES_MAX);
  const h = words(head ?? ('meta' in p ? p.meta : null), 80);
  const empty = words(hint?.empty ?? p.empty, 120);
  return {
    kind: 'board',
    ...base(b),
    ...(h ? { head: h } : {}),
    items,
    ...(ordered.length > items.length ? { count: Math.min(ordered.length, 1_000_000) } : {}),
    ...(empty ? { empty } : {}),
  };
}

/** One camera's latest picture: its name as the title, what the gallery says under it as the event. */
export function cameraView(
  b: ViewBase,
  thing: DeskWidgetRef,
  camera: {
    title: string;
    image?: ThingImage | undefined;
    event?: string | null | undefined;
    muted?: boolean;
  },
): DeskWidgetView {
  const image = deskImage(thing, camera.image);
  const event = words(camera.event, 80);
  return {
    kind: 'camera',
    ...base({ ...b, title: camera.title || b.title }),
    ...(camera.muted ? { tone: 'off' as const } : {}),
    ...(image ? { image } : {}),
    ...(event ? { event } : {}),
  };
}

/** A thermostat's figures: the room's temperature big, the setpoint and what it does under it (“Set to 21 °C · Heating”). */
function thermostatReading(c: ThingControl): { value: string; rest?: string; sub?: string } {
  const parts = (c.state ?? '').split(' · ').filter(Boolean);
  const nowAt = parts.findIndex((x) => /^Now\s/.test(x));
  const room = nowAt >= 0 ? splitReading((parts[nowAt] as string).replace(/^Now\s+/, '')) : null;
  const doing = parts.filter((_, i) => i !== nowAt);
  const unit = c.stepper?.unit ?? room?.rest;
  const set = c.stepper ? `Set to ${c.stepper.value}${unit ? ` ${unit}` : ''}` : null;
  const sub = [set, ...doing].filter(Boolean).join(' · ');
  if (room && /^[−-]?\d/.test(room.value)) return { ...room, ...(sub ? { sub } : {}) };
  if (c.stepper)
    return {
      value: String(c.stepper.value),
      ...(c.stepper.unit ? { rest: c.stepper.unit } : {}),
      ...(doing.length ? { sub: doing.join(' · ') } : {}),
    };
  return { value: doing.join(' · ') || '—' };
}

/** “21.5 °C” → value “21.5”, unit “°C”; “Open” stays the value. */
export function splitReading(state: string): { value: string; rest?: string } {
  const m = /^\s*([−-]?\d[\d.,]*)\s*([^\d\s].{0,11})?\s*$/.exec(state);
  if (!m) return { value: state };
  return { value: m[1] as string, ...(m[2] ? { rest: m[2].trim() } : {}) };
}

/**
 * How many rows a panel stands for: a Summary that shows the first 15 of 41 has the whole list on a tab of its own,
 * under the same id.
 */
export function panelTotal(page: ThingPage, p: PanelOf<'list' | 'table' | 'bars'>): number {
  const size = (x: Panel) =>
    x.kind === 'table' ? x.rows.length : x.kind === 'list' || x.kind === 'bars' ? x.items.length : 0;
  return Math.max(
    size(p),
    ...page.tabs.flatMap((t) => t.panels.filter((x) => x.id === p.id && x.kind === p.kind).map(size)),
  );
}

/** What a panel widget shows: its view, or null when the page has no such panel or item (the caller says why). */
export function panelView(input: {
  b: ViewBase;
  thing: DeskWidgetRef;
  page: ThingPage;
  panel: Panel;
  item?: string | undefined;
  hint?: PanelHint | undefined;
  now: Date;
  timeZone: string;
}): DeskWidgetView | null {
  const { b, thing, page, panel: p, hint, now, timeZone } = input;
  const head = hint?.head?.(page, p) ?? null;
  if (input.item !== undefined) {
    if (p.kind === 'gallery') {
      const camera = p.items.find((i) => i.id === input.item);
      if (!camera) return null;
      return cameraView({ ...b, title: camera.title }, thing, {
        title: camera.title,
        image: camera.image,
        event: camera.note ?? camera.sub ?? camera.badge?.text,
        muted: !!camera.muted,
      });
    }
    if (p.kind === 'controls') {
      const group = p.groups.find((g) => g.items.some((c) => c.id === input.item));
      const c = group?.items.find((x) => x.id === input.item);
      if (!c || !group) return null;
      if (isCameraControl(c))
        return cameraView({ ...b, title: c.label }, thing, { title: c.label, image: c.image });
      const date = c.state ? dateWords(c.state, now, timeZone) : null;
      const reading: { value: string; rest?: string; sub?: string } =
        c.icon === 'thermostat' || c.stepper
          ? thermostatReading(c)
          : date
            ? { value: date }
            : splitReading(c.state ?? '');
      return figuresView({ ...b, title: c.label }, [
        {
          key: 'reading',
          label: group.title !== c.label && group.id !== 'other' ? group.title : c.label,
          value: reading.value || '—',
          ...(reading.rest ? { rest: reading.rest } : {}),
          ...(reading.sub ? { sub: reading.sub } : {}),
          ...(c.tone ? { tone: c.tone } : {}),
        },
      ]);
    }
    return null;
  }
  const drawn = screenViewOf(p, hint);
  if (drawn === 'photo' && p.kind === 'gallery') return photoView(b, thing, p, hint);
  if (drawn === 'board' && (p.kind === 'table' || p.kind === 'list' || p.kind === 'bars'))
    return boardView(b, p, hint, head);
  if (drawn === 'list' && p.kind === 'gallery')
    return listView(b, {
      rows: galleryRows(p, hint?.title),
      total: p.total ?? p.items.length,
      empty: hint?.empty ?? p.empty,
      head,
    });
  switch (p.kind) {
    case 'kpis':
      return figuresView(b, p.items);
    case 'chart':
      return chartView(b, p);
    case 'list':
      return listView(b, {
        rows: itemRows(thing, p.items, now, timeZone, hint?.title),
        total: panelTotal(page, p),
        empty: hint?.empty ?? p.empty,
        head,
      });
    case 'table':
      return listView(b, {
        rows: tableRows(p, hint?.columns, hint?.title),
        total: panelTotal(page, p),
        empty: hint?.empty ?? p.empty,
        head,
      });
    case 'bars':
      return listView(b, {
        rows: barRows(p),
        total: panelTotal(page, p),
        empty: hint?.empty ?? p.empty,
        head,
      });
    case 'controls': {
      const c = controlRows(p, now, timeZone);
      const own = c.switches ? (c.on ? `${c.on} on` : 'All off') : null;
      return listView(b, { rows: c.rows, total: c.total, empty: hint?.empty ?? p.empty, head: head ?? own });
    }
    case 'facts':
      return listView(b, { rows: factRows(p), total: p.items.length, head });
    case 'notices': {
      const n = noticeRows(p);
      return listView(b, { ...n, empty: hint?.empty ?? p.empty ?? 'Nothing needs a look.', head });
    }
    case 'gallery': {
      if (isCameraGallery(p) && !hint?.mosaic) {
        const camera = p.items.find((i) => i.image) ?? p.items[0];
        if (!camera) return textView(b, words(hint?.empty ?? p.empty, 600) || 'No cameras right now.');
        return cameraView(b, thing, {
          title: camera.title,
          image: camera.image,
          event: camera.note ?? camera.sub ?? camera.badge?.text,
          muted: !!camera.muted,
        });
      }
      return postersView(b, thing, p, hint, head);
    }
    case 'text':
      return textView({ ...b, title: p.title ?? b.title }, p.body);
    default:
      return null;
  }
}

/**
 * A panel the page leaves out now (it had nothing to show): its view, empty, when what it becomes is known; a figure,
 * chart or text has no empty form, so it says so in words.
 */
export function emptyView(
  b: ViewBase,
  known: { view: DeskWidgetViewKind; shape?: 'poster' | 'wide' | 'square' | undefined },
  empty: string | undefined,
): DeskWidgetView {
  const words_ = words(empty, 120) || 'Nothing here right now.';
  if (known.view === 'list') return listView(b, { rows: [], total: 0, empty: words_ });
  if (known.view === 'posters')
    return { kind: 'posters', ...base(b), items: [], shape: known.shape ?? 'poster', empty: words_ };
  if (known.view === 'photo') return { kind: 'photo', ...base(b), items: [], empty: words_ };
  if (known.view === 'board') return { kind: 'board', ...base(b), items: [], empty: words_ };
  return textView(b, words_);
}
