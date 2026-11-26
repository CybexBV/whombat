/**
 * Screens of widgets (3.6; Whombat docs/decisions/desk-display.md DK-126…DK-149). Every screen — the box's own display,
 * a monitor plugged into the box, a tablet or a computer elsewhere — is a grid of widgets the person arranges, on up to
 * six pages, with its own Size, page turning and pop-ups.
 *
 * - **The layout** (`DeskLayout`): pages, each with a layout per grid shape (`"8x5"`): the widgets placed on it
 *   (`DeskWidget`: its type, what it shows, its cell, its size). The grid's shape comes from the screen
 *   (`@whombat/screen`); a page without a layout for a shape is drawn rearranged from its latest one.
 * - **The views** (`DeskWidgetView`): what each placed widget says, resolved by the runtime and free of size — a few
 *   figures, a list, posters, a chart, a camera still, a server — so the screen picks the form for the cells it has.
 *   Whombat's own *How things are*, *What’s going on* and *Servers* read the calm glance (`DeskCalm`) instead.
 * - **What needs the person** (`DeskAttention`): the modal's items and the pill, from the calm planner's order.
 *
 * The shapes are here, not in the desk socket's contract, because the session carries them too (Settings' editor and a
 * screen elsewhere).
 */
import { z } from 'zod';
import { DeskShow } from './desk-glance.js';
import { displayLine as line } from './display-text.js';
import { LOOK_FIX_LABEL_MAX, LookResearchState } from './look-research.js';
import { ClockTime, Weekday } from './notify.js';

/* Text and ids --------------------------------------------------------------------------------------------------- */

const Timestamp = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/);
const Count = z.number().int().min(0).max(1_000_000);
const Pct = z.number().int().min(0).max(100);
const AskNumber = z.number().int().min(1).max(1_000_000_000);
const Mark = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const ServerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** The box's own display. */
export const DESK_SCREEN_BOX = 'box';
/**
 * A screen: `box` the box's own display, `out_<key>` a monitor plugged into the box (its output's name, lower case),
 * `scr_<id>` a tablet or computer elsewhere.
 */
export const DESK_SCREEN_ID_RE = /^(box|out_[a-z0-9-]{1,40}|scr_[A-Za-z0-9_-]{8,40})$/;
export const DeskScreenId = z.string().regex(DESK_SCREEN_ID_RE);
export type DeskScreenId = z.infer<typeof DeskScreenId>;

/** What a screen is: the box's own display, a monitor on the box, a device elsewhere (DK-128). */
export const DESK_SCREEN_KINDS = ['box', 'output', 'device'] as const;
export const DeskScreenKind = z.enum(DESK_SCREEN_KINDS);
export type DeskScreenKind = z.infer<typeof DeskScreenKind>;

export const DeskPageId = z.string().regex(/^p_[A-Za-z0-9_-]{1,32}$/);
export type DeskPageId = z.infer<typeof DeskPageId>;
export const DeskWidgetId = z.string().regex(/^w_[A-Za-z0-9_-]{1,32}$/);
export type DeskWidgetId = z.infer<typeof DeskWidgetId>;

/** A grid's shape, columns × rows: `"8x5"`. */
export const DESK_SHAPE_RE = /^([1-9]|[1-3][0-9])x([1-9]|[1-3][0-9])$/;
export const DeskShapeKey = z.string().regex(DESK_SHAPE_RE);
export type DeskShapeKey = z.infer<typeof DeskShapeKey>;
/** The most columns or rows a grid has. */
export const DESK_GRID_MAX = 39;

export function deskShapeKey(cols: number, rows: number): DeskShapeKey {
  return `${cols}x${rows}`;
}
export function parseDeskShapeKey(key: string): { cols: number; rows: number } | null {
  const m = DESK_SHAPE_RE.exec(key);
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
}

/* The widgets (DK-139) ------------------------------------------------------------------------------------------- */

/**
 * What a widget is. Whombat's own: `clock`, `status` (*How things are*), `now` (*What’s going on*), `strip` (*Servers*),
 * `work` (the assistant's work), `coming` (*Coming up*), `done` (*Done today*). Then `server` (a server, `ref`
 * `server:<hosts id>`), `figures` (a connection's or device's figures, `ref` `connection:<id>` / `device:<id>`),
 * `panel` (one panel of its page, `opts.panel` the panel's id; an account's, `ref` `account:<id>`, 3.7) and `widget` (a
 * widget the assistant made for Home, `ref` `widget:<id>`).
 */
export const DESK_OWN_WIDGETS = ['clock', 'status', 'now', 'strip', 'work', 'coming', 'done'] as const;
export const DESK_WIDGET_TYPES = [...DESK_OWN_WIDGETS, 'server', 'figures', 'panel', 'widget'] as const;
export const DeskWidgetType = z.enum(DESK_WIDGET_TYPES);
export type DeskWidgetType = z.infer<typeof DeskWidgetType>;

/**
 * What a widget shows: a server, a connection, a device (Home's thing ids), a Home widget, or one of the person's own
 * accounts (3.7, DK-159): `account:<id>` a Google, Microsoft 365 or Email (IMAP) account the person connected,
 * `account:github` the Whombat's GitHub.
 */
export const DESK_WIDGET_REF_RE =
  /^(server|connection|device|widget|account):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** The ref of the Whombat's GitHub (its repositories and pull requests). */
export const DESK_ACCOUNT_GITHUB = 'account:github';
export const DeskWidgetRef = z.string().regex(DESK_WIDGET_REF_RE);
export type DeskWidgetRef = z.infer<typeof DeskWidgetRef>;

/**
 * A widget's own settings, small strings (DK-144): `panel` the panel's id, `range` a chart's (`1h`, `24h`, `7d`),
 * `lock` what it shows on a locked screen (`show`, `hide`). Unknown keys are kept and ignored.
 */
export const DESK_WIDGET_OPTS_MAX = 8;
export const DeskWidgetOpts = z
  .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/), line(120))
  .refine((r) => Object.keys(r).length <= DESK_WIDGET_OPTS_MAX);
export type DeskWidgetOpts = z.infer<typeof DeskWidgetOpts>;
export const DESK_WIDGET_RANGES = ['1h', '24h', '7d'] as const;
export const DESK_WIDGET_LOCK = ['show', 'hide'] as const;

/** What a widget is and shows, without its place: the editor asks the runtime for views of these. */
export const DeskWidgetSpec = z.object({
  id: DeskWidgetId,
  type: DeskWidgetType,
  ref: DeskWidgetRef.optional(),
  opts: DeskWidgetOpts.default(() => ({})),
});
export type DeskWidgetSpec = z.infer<typeof DeskWidgetSpec>;

/** A widget on a page: its cell (`x`, `y` from the top left, 0-based) and its size in cells. */
export const DeskWidget = DeskWidgetSpec.extend({
  x: z
    .number()
    .int()
    .min(0)
    .max(DESK_GRID_MAX - 1),
  y: z
    .number()
    .int()
    .min(0)
    .max(DESK_GRID_MAX - 1),
  w: z.number().int().min(1).max(DESK_GRID_MAX),
  h: z.number().int().min(1).max(DESK_GRID_MAX),
});
export type DeskWidget = z.infer<typeof DeskWidget>;

/** Why a widget's spec can't be shown: a ref of the wrong kind, a panel without its id. Null: fine. */
export function deskWidgetSpecProblem(w: Pick<DeskWidgetSpec, 'type' | 'ref' | 'opts'>): string | null {
  const kind = w.ref?.slice(0, w.ref.indexOf(':'));
  switch (w.type) {
    case 'server':
      return kind === 'server' ? null : 'a server widget names a server';
    case 'figures':
      return kind === 'connection' || kind === 'device' || kind === 'account'
        ? null
        : 'figures name a connection, device or account';
    case 'panel':
      if (kind !== 'connection' && kind !== 'device' && kind !== 'account')
        return 'a panel names a connection, device or account';
      return w.opts?.panel && /^[a-z][a-z0-9_-]{0,39}$/.test(w.opts.panel) ? null : 'a panel names its panel';
    case 'widget':
      return kind === 'widget' ? null : 'names a Home widget';
    default:
      return w.ref === undefined ? null : 'Whombat’s own widgets name nothing';
  }
}

/* Pages and the layout (DK-132, DK-133) -------------------------------------------------------------------------- */

export const DESK_PAGES_MAX = 6;
export const DESK_PAGE_WIDGETS_MAX = 24;
/** Shapes a page keeps a layout for; the oldest other than `last` goes first. */
export const DESK_PAGE_SHAPES_MAX = 8;
/** Different widgets a screen resolves (DK-148). */
export const DESK_SCREEN_VIEWS_MAX = 64;
/** Screens besides the box's own (DK-148). */
export const DESK_SCREENS_MAX = 8;

/**
 * When a page is in the screen's turning: from `from` to `to` in the person's time zone, on `days` (the day the
 * window starts: `22:00`–`06:00` on `fri` runs into Saturday morning), every day without `days`. `from` = `to` is the
 * whole day. A page without one is always in.
 */
export const DeskPageShow = z.object({
  from: ClockTime,
  to: ClockTime,
  days: z.array(Weekday).min(1).max(7).optional(),
});
export type DeskPageShow = z.infer<typeof DeskPageShow>;

export const DeskPage = z
  .object({
    id: DeskPageId,
    name: line(24),
    /** The widgets for each grid shape this page was arranged on. */
    layouts: z
      .record(DeskShapeKey, z.array(DeskWidget).max(DESK_PAGE_WIDGETS_MAX))
      .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= DESK_PAGE_SHAPES_MAX),
    /** The shape changed last: other shapes without a layout of their own are rearranged from it. */
    last: DeskShapeKey,
    /** Only at these times; always without. */
    show: DeskPageShow.optional(),
  })
  .refine((p) => p.last in p.layouts, { message: 'last names one of the layouts' });
export type DeskPage = z.infer<typeof DeskPage>;

/** How pages turn (DK-133): when someone touches the screen, or by themselves every 30 seconds or every minute. */
export const DESK_TURNS = ['touch', '30s', '60s'] as const;
export const DeskTurn = z.enum(DESK_TURNS);
export type DeskTurn = z.infer<typeof DeskTurn>;
/** The seconds between pages turning by themselves. */
export const DESK_TURN_S: Readonly<Record<DeskTurn, number | null>> = { touch: null, '30s': 30, '60s': 60 };
/** A screen that turns when touched goes back to its first page after this long untouched (DK-133). */
export const DESK_FIRST_PAGE_AFTER_S = 120;

/** Size (DK-130): how big everything is drawn, so how many cells fit. */
export const DESK_SIZES = ['smaller', 'normal', 'larger'] as const;
export const DeskSize = z.enum(DESK_SIZES);
export type DeskSize = z.infer<typeof DeskSize>;
export const DESK_SIZE_ZOOM: Readonly<Record<DeskSize, number>> = { smaller: 0.8, normal: 1, larger: 1.3 };

export const DeskLayout = z.object({
  pages: z.array(DeskPage).min(1).max(DESK_PAGES_MAX),
  turn: DeskTurn.default('touch'),
  size: DeskSize.default('normal'),
});
export type DeskLayout = z.infer<typeof DeskLayout>;

const overlaps = (a: DeskWidget, b: DeskWidget) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Why a layout can't be kept, in a few words; null when it can. Every widget inside its shape and on no other, ids
 * unique on a page (a widget keeps its id across a page's shapes), page ids unique, a page's days each once, every spec
 * sound. Sizes per type are the screen's to enforce (`@whombat/screen`), not the contract's.
 */
export function deskLayoutProblem(layout: DeskLayout): string | null {
  const pageIds = new Set<string>();
  for (const page of layout.pages) {
    if (pageIds.has(page.id)) return `page ${page.id} twice`;
    pageIds.add(page.id);
    const days = page.show?.days ?? [];
    if (new Set(days).size !== days.length) return `a day twice on ${page.name}`;
    for (const [shape, widgets] of Object.entries(page.layouts)) {
      const s = parseDeskShapeKey(shape);
      if (!s) return `shape ${shape}`;
      const ids = new Set<string>();
      for (const [i, w] of widgets.entries()) {
        if (ids.has(w.id)) return `widget ${w.id} twice on ${page.name}`;
        ids.add(w.id);
        if (w.x + w.w > s.cols || w.y + w.h > s.rows) return `${w.id} outside ${shape}`;
        const spec = deskWidgetSpecProblem(w);
        if (spec) return `${w.id}: ${spec}`;
        for (const other of widgets.slice(i + 1)) if (overlaps(w, other)) return `${w.id} on ${other.id}`;
      }
    }
  }
  return null;
}

/** Every different widget of a layout (by id; the first seen wins), what the runtime resolves. */
export function deskLayoutWidgets(layout: DeskLayout): DeskWidgetSpec[] {
  const seen = new Map<string, DeskWidgetSpec>();
  for (const page of layout.pages)
    for (const widgets of Object.values(page.layouts))
      for (const w of widgets)
        if (!seen.has(w.id))
          seen.set(w.id, { id: w.id, type: w.type, ...(w.ref ? { ref: w.ref } : {}), opts: w.opts });
  return [...seen.values()];
}

/** The shape the default layout is drawn for: the Z13's 8 × 5. */
export const DESK_DEFAULT_SHAPE: DeskShapeKey = '8x5';

/**
 * The layout of a screen nobody arranged (DK-127): the calm glance as widgets — the clock and how things are side by
 * side, what's going on under them, the servers along the bottom. Other shapes rearrange it.
 */
export function deskDefaultLayout(pageName: string = DESK_SCREEN_WORDS.firstPage): DeskLayout {
  return {
    pages: [
      {
        id: 'p_first',
        name: pageName,
        layouts: {
          [DESK_DEFAULT_SHAPE]: [
            { id: 'w_clock', type: 'clock', opts: {}, x: 0, y: 0, w: 4, h: 2 },
            { id: 'w_status', type: 'status', opts: {}, x: 4, y: 0, w: 4, h: 2 },
            { id: 'w_now', type: 'now', opts: {}, x: 0, y: 2, w: 8, h: 2 },
            { id: 'w_strip', type: 'strip', opts: {}, x: 0, y: 4, w: 8, h: 1 },
          ],
        },
        last: DESK_DEFAULT_SHAPE,
      },
    ],
    turn: 'touch',
    size: 'normal',
  };
}

/** An empty page, for a screen that starts empty or *+ Page*. */
export function deskEmptyPage(id: string, name: string, shape: DeskShapeKey): DeskPage {
  return { id, name, layouts: { [shape]: [] }, last: shape };
}

/* Pop-ups (DK-135…DK-137) ---------------------------------------------------------------------------------------- */

/** What opens the modal on a screen: questions and problems, problems only, nothing (the pill still shows). */
export const DESK_POPUPS = ['all', 'problems', 'none'] as const;
export const DeskPopups = z.enum(DESK_POPUPS);
export type DeskPopups = z.infer<typeof DeskPopups>;

/**
 * Something that needs the person (DK-135, DK-136), in the calm planner's order: a question or approval (`ask`, its
 * number) or a problem (`look`, its key), with the words the modal shows. `pops` it opens the modal on this screen
 * (an outage or a question, as the screen's pop-ups allow); otherwise it's only in the pill's list. `name` what
 * *Open {name}* opens, `server` a server it opens.
 */
export const DESK_ATTENTION_KINDS = ['ask', 'look'] as const;
export const DeskAttentionKind = z.enum(DESK_ATTENTION_KINDS);
export const DESK_ATTENTION_TONES = ['bad', 'warn'] as const;
export const DeskAttentionTone = z.enum(DESK_ATTENTION_TONES);
export type DeskAttentionTone = z.infer<typeof DeskAttentionTone>;
export const DeskAttentionItem = z.object({
  key: line(120),
  kind: DeskAttentionKind,
  tone: DeskAttentionTone,
  pops: z.boolean(),
  title: line(120),
  detail: line(200).optional(),
  since: Timestamp.optional(),
  name: line(40).optional(),
  ask: AskNumber.optional(),
  look: line(120).optional(),
  server: ServerId.optional(),
  research: LookResearchState.optional(),
  fix: line(LOOK_FIX_LABEL_MAX).optional(),
});
export type DeskAttentionItem = z.infer<typeof DeskAttentionItem>;
export const DESK_ATTENTION_MAX = 12;
/** The modal's and the pill's: the items, how many more, and the pill's colour (absent: nothing needs you). */
export const DeskAttention = z.object({
  items: z.array(DeskAttentionItem).max(DESK_ATTENTION_MAX),
  more: Count,
  tone: DeskAttentionTone.optional(),
});
export type DeskAttention = z.infer<typeof DeskAttention>;

/* The views (DK-142) --------------------------------------------------------------------------------------------- */

/** A widget's colour: fine, something to look at, something wrong, switched off. */
export const DESK_VIEW_TONES = ['ok', 'warn', 'bad', 'off'] as const;
export const DeskViewTone = z.enum(DESK_VIEW_TONES);
export type DeskViewTone = z.infer<typeof DeskViewTone>;

/**
 * A picture the screen loads from the runtime, never from the service: the thing it belongs to and its signed ref
 * (a thing page's `ThingImageRef`); the box's console through the desk socket's `image`, a screen elsewhere through
 * `screen.image`, the apps through their `thing-image` download. `shape` the box it keeps: poster 2:3, wide 16:9,
 * square 1:1.
 */
export const DeskImage = z.object({
  thing: DeskWidgetRef,
  ref: z
    .string()
    .min(16)
    .max(600)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  shape: z.enum(['poster', 'wide', 'square']),
  alt: z.string().max(120).optional(),
});
export type DeskImage = z.infer<typeof DeskImage>;

const viewBase = {
  /** The widget's id. */
  id: DeskWidgetId,
  /** Its title (“Now playing”, “pve-01”), and what it belongs to (“Plex”) when that isn't the title. */
  title: line(60),
  name: line(40).optional(),
  mark: Mark.optional(),
  tone: DeskViewTone.optional(),
  /** It can't show what it shows now: says why instead (“Plex isn’t answering”, “It runs on pve-02, which is down.”). */
  problem: z.object({ text: line(120), detail: line(200).optional() }).optional(),
  /** Left out because the screen is locked (DK-138): the screen says so instead of the content. */
  locked: z.boolean().optional(),
  /** When what it shows was read. */
  at: Timestamp.optional(),
};

/** A figure: “21.4” “°C” “Living room”. */
export const DeskViewFigure = z.object({
  value: line(24),
  unit: line(12).optional(),
  label: line(40),
  tone: DeskViewTone.optional(),
});
export type DeskViewFigure = z.infer<typeof DeskViewFigure>;

/** A row of a list: “21:00” “The Bear” “S3 E5 · tonight” “1.1 GB”, with a bar, a light's state or a picture. */
export const DeskViewRow = z.object({
  title: line(120),
  detail: line(120).optional(),
  meta: line(40).optional(),
  time: line(16).optional(),
  tone: DeskViewTone.optional(),
  progress: Pct.optional(),
  state: z.enum(['on', 'off']).optional(),
  image: DeskImage.optional(),
});
export type DeskViewRow = z.infer<typeof DeskViewRow>;

/** A poster or a picture with its words: “Dune: Part Two” “Film · 2024” “John · Living room TV”. */
export const DeskViewPoster = z.object({
  title: line(120),
  detail: line(120).optional(),
  who: line(80).optional(),
  progress: Pct.optional(),
  time: line(40).optional(),
  image: DeskImage.optional(),
});
export type DeskViewPoster = z.infer<typeof DeskViewPoster>;

export const DESK_VIEW_ROWS_MAX = 12;
export const DESK_VIEW_POINTS_MAX = 120;
/** A board's tiles at most (3.7). */
export const DESK_VIEW_TILES_MAX = 48;
/** A photo view's pictures at most, and how often it shows the next one (seconds, 3.7). */
export const DESK_VIEW_PHOTOS_MAX = 12;
export const DESK_PHOTO_EVERY_S = { min: 30, max: 3600, default: 120 } as const;

/** A board's tile: “pve-01” fine, “plex” amber “restarting”, “backup-box” off (3.7). */
export const DeskViewTile = z.object({
  label: line(40),
  tone: DeskViewTone,
  value: line(16).optional(),
});
export type DeskViewTile = z.infer<typeof DeskViewTile>;

/** One of a photo view's pictures, with a few words under it: “3 years ago · Texel” (3.7). */
export const DeskViewPhoto = z.object({
  image: DeskImage,
  caption: line(80).optional(),
  time: line(40).optional(),
});
export type DeskViewPhoto = z.infer<typeof DeskViewPhoto>;

/**
 * What a widget says, without its size (DK-142):
 * - `figures` one to four figures, a line under them, a small line over time (`spark`) or a bar (`progress`);
 * - `list` a big line (`head`: “3 left · about 20 min”) and rows;
 * - `posters` pictures with their words (what's playing, recently added);
 * - `chart` a figure and lines over time with facts under them;
 * - `camera` a camera's latest still;
 * - `server` a server: its processor, memory and disk, its line over time;
 * - `text` a few plain sentences;
 * - `photo` (3.7) one big picture filling the widget, the next one every `every` seconds, its words under it;
 * - `board` (3.7) many small named tiles, each a colour and maybe a short value: everything fine at a glance where a
 *   list would stop at twelve rows (every container, every device, every repository's main branch).
 *
 * A screen or an app that doesn't know a kind leaves its widget empty; the runtime sends `photo` and `board` only to
 * sessions at protocol minor 2 or later (DK-161).
 */
export const DeskWidgetView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('figures'),
    ...viewBase,
    items: z.array(DeskViewFigure).min(1).max(4),
    line: line(120).optional(),
    spark: z.array(z.number()).max(DESK_VIEW_POINTS_MAX).optional(),
    progress: Pct.optional(),
  }),
  z.object({
    kind: z.literal('list'),
    ...viewBase,
    head: line(80).optional(),
    progress: Pct.optional(),
    rows: z.array(DeskViewRow).max(DESK_VIEW_ROWS_MAX),
    /** How many there are in all (“2 new”), when more than the rows. */
    count: Count.optional(),
    empty: line(120).optional(),
  }),
  z.object({
    kind: z.literal('posters'),
    ...viewBase,
    head: line(80).optional(),
    items: z.array(DeskViewPoster).max(DESK_VIEW_ROWS_MAX),
    shape: z.enum(['poster', 'wide', 'square']),
    empty: line(120).optional(),
  }),
  z.object({
    kind: z.literal('chart'),
    ...viewBase,
    figure: z
      .object({ value: line(40), rest: line(60).optional(), tone: DeskViewTone.optional() })
      .optional(),
    stats: z.array(line(80)).max(2).optional(),
    series: z
      .array(
        z.object({
          label: line(40).optional(),
          points: z.array(z.number().nullable()).max(DESK_VIEW_POINTS_MAX),
          tone: DeskViewTone.optional(),
        }),
      )
      .min(1)
      .max(3),
    unit: line(12).optional(),
    /** A dashed line where it gets serious. */
    limit: z.number().optional(),
    foot: z
      .array(z.object({ label: line(30), value: line(40) }))
      .max(4)
      .optional(),
  }),
  z.object({
    kind: z.literal('camera'),
    ...viewBase,
    image: DeskImage.optional(),
    event: line(80).optional(),
  }),
  z.object({
    kind: z.literal('server'),
    ...viewBase,
    /** “Proxmox · 16 cores”. */
    line: line(80).optional(),
    state: z.enum(['ok', 'warn', 'bad', 'off']),
    /** Why it isn't fine, a few words. */
    say: line(40).optional(),
    cpu: Pct.optional(),
    memory: Pct.optional(),
    disk: Pct.optional(),
    /** Its processor over `range`, whole percent, oldest first. */
    spark: z.array(Pct).max(DESK_VIEW_POINTS_MAX).optional(),
    range: z.enum(DESK_WIDGET_RANGES).optional(),
    stats: z.array(line(80)).max(2).optional(),
    uptime: line(40).optional(),
    server: ServerId,
  }),
  z.object({
    kind: z.literal('text'),
    ...viewBase,
    body: z.string().min(1).max(600),
  }),
  z.object({
    kind: z.literal('photo'),
    ...viewBase,
    items: z.array(DeskViewPhoto).max(DESK_VIEW_PHOTOS_MAX),
    every: z.number().int().min(DESK_PHOTO_EVERY_S.min).max(DESK_PHOTO_EVERY_S.max).optional(),
    empty: line(120).optional(),
  }),
  z.object({
    kind: z.literal('board'),
    ...viewBase,
    head: line(80).optional(),
    items: z.array(DeskViewTile).max(DESK_VIEW_TILES_MAX),
    /** How many there are in all, when more than the tiles. */
    count: Count.optional(),
    empty: line(120).optional(),
  }),
]);
export type DeskWidgetView = z.infer<typeof DeskWidgetView>;
export type DeskWidgetViewKind = DeskWidgetView['kind'];

/* A screen's grid as the screen draws it ------------------------------------------------------------------------- */

/** Why a widget takes over a screen for a moment: the doorbell rang. */
export const DESK_SPOTLIGHT_REASONS = ['doorbell'] as const;
export const DeskSpotlightReason = z.enum(DESK_SPOTLIGHT_REASONS);
export type DeskSpotlightReason = z.infer<typeof DeskSpotlightReason>;
/** How long a moment takes over a screen; a new one starts the time again. */
export const DESK_SPOTLIGHT_S = 60;

/**
 * A widget that takes over the screen for a moment: drawn big over the dashboard until `until`, its view among
 * the grid's `views`. `id` is this moment's: *Back* hides it on that screen until the next one.
 */
export const DeskSpotlight = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  widget: DeskWidgetSpec,
  until: Timestamp,
  reason: DeskSpotlightReason,
});
export type DeskSpotlight = z.infer<typeof DeskSpotlight>;

/**
 * What a screen draws under its top bar (the desk socket's `DeskGlance.grid`, a screen elsewhere's `screen.state`):
 * its layout, the views of its widgets, what needs the person, its pop-ups, until when it shows Settings' draft
 * (*Try on the screen*, DK-143), and a widget taking over for a moment (`spotlight`).
 */
export const DeskGrid = z.object({
  screen: DeskScreenId,
  layout: DeskLayout,
  views: z.array(DeskWidgetView).max(DESK_SCREEN_VIEWS_MAX),
  attention: DeskAttention,
  popups: DeskPopups,
  trying: z.object({ until: Timestamp }).optional(),
  spotlight: DeskSpotlight.optional(),
});
export type DeskGrid = z.infer<typeof DeskGrid>;

/* Screens in Settings (DK-128, DK-146, DK-147) ------------------------------------------------------------------- */

/** A screen's size in logical pixels, as it last said. */
export const DeskScreenSize = z.object({
  width: z.number().int().min(200).max(16_384),
  height: z.number().int().min(200).max(16_384),
});
export type DeskScreenSize = z.infer<typeof DeskScreenSize>;

/** What a screen does when the doorbell rings: shows the doorbell big for a minute, or nothing. */
export const DESK_DOORBELL = ['big', 'off'] as const;
export const DeskDoorbell = z.enum(DESK_DOORBELL);
export type DeskDoorbell = z.infer<typeof DeskDoorbell>;

/**
 * A screen in Settings → Screens: what it is, its name (“Kitchen tablet”, “DELL U2720Q”), its pop-ups, what it does
 * when the doorbell rings (absent from an older runtime), its size as it last said (null before it did), how many pages,
 * whether it's showing now, when it was last seen, and for a device what it is (“iPad · Safari”).
 */
export const DeskScreenSummary = z.object({
  id: DeskScreenId,
  kind: DeskScreenKind,
  name: line(40),
  popups: DeskPopups,
  doorbell: DeskDoorbell.optional(),
  size: DeskScreenSize.nullable(),
  pages: z.number().int().min(1).max(DESK_PAGES_MAX),
  online: z.boolean(),
  lastSeenAt: Timestamp.nullable(),
  device: line(80).optional(),
});
export type DeskScreenSummary = z.infer<typeof DeskScreenSummary>;

/**
 * `desk.screens`: every screen, the box's own first, whether another can be added, and whether the Whombat follows a
 * doorbell (`doorbell`: Settings offers *When the doorbell rings*).
 */
export const DeskScreensList = z.object({
  screens: z.array(DeskScreenSummary).max(DESK_SCREENS_MAX + 4),
  canAdd: z.boolean(),
  doorbell: z.boolean().optional(),
});
export type DeskScreensList = z.infer<typeof DeskScreensList>;

/** `desk.screen.get`: a screen with its layout and its choices for *What’s going on* and *Servers* (DK-144). */
export const DeskScreenDetail = DeskScreenSummary.extend({
  layout: DeskLayout,
  show: DeskShow,
});
export type DeskScreenDetail = z.infer<typeof DeskScreenDetail>;

/**
 * Something *Add a widget* lists (DK-139): its type and what it shows (`ref`, `opts`), its name and a line about it,
 * the size it starts at and its smallest and largest (cells), and the view it draws (`view`) where known.
 */
export const DeskCatalogItem = z.object({
  type: DeskWidgetType,
  ref: DeskWidgetRef.optional(),
  opts: DeskWidgetOpts.default(() => ({})),
  name: line(60),
  line: line(120),
  mark: Mark.optional(),
  view: z
    .enum(['figures', 'list', 'posters', 'chart', 'camera', 'server', 'text', 'photo', 'board'])
    .optional(),
  /** It shows what a locked screen leaves out unless chosen (DK-138): the editor offers *On a locked screen*. */
  private: z.boolean().optional(),
});
export type DeskCatalogItem = z.infer<typeof DeskCatalogItem>;

/**
 * A group of *Add a widget*: Whombat's own, each server, each connection or device (`thing`) with its panels, then
 * the person's own accounts (`thing` `account:<id>`, 3.7). `partial` the thing has more than listed (its page couldn't
 * be read just now).
 */
export const DeskCatalogGroup = z.object({
  key: line(120),
  label: line(80),
  mark: Mark.optional(),
  thing: DeskWidgetRef.optional(),
  items: z.array(DeskCatalogItem).max(48),
  partial: z.boolean().optional(),
});
export type DeskCatalogGroup = z.infer<typeof DeskCatalogGroup>;
export const DeskCatalog = z.object({ groups: z.array(DeskCatalogGroup).max(200) });
export type DeskCatalog = z.infer<typeof DeskCatalog>;

/** A screen elsewhere's six letters (DK-146): from the letters the claim and the box's screen use, no I or O. */
export const DESK_SCREEN_CODE_RE = /^[A-HJ-NP-Z]{6}$/;
export const DeskScreenCode = z.string().regex(DESK_SCREEN_CODE_RE);
/** How long a screen elsewhere's letters work. */
export const DESK_SCREEN_CODE_TTL_S = 600;
/** A screen elsewhere unlocked with the PIN locks again after this long untouched (DK-138). */
export const DESK_SCREEN_UNLOCK_IDLE_S = 120;

/* Words ---------------------------------------------------------------------------------------------------------- */

/** Words the runtime and Settings use for screens; the screen's own are `@whombat/screen`'s (kept equal by a test). */
export const DESK_SCREEN_WORDS = {
  firstPage: 'Overview',
  newPage: 'Page {n}',
  box: 'This Whombat’s screen',
  output: 'Monitor on this Whombat',
  device: 'Screen',
  own: {
    clock: { name: 'Clock', line: 'The time and the date' },
    status: { name: 'How things are', line: 'One sentence: all fine, or what’s wrong' },
    now: { name: 'What’s going on', line: 'Up to three things happening now' },
    strip: { name: 'Servers', line: 'Every server in a row, in words when one isn’t fine' },
    work: { name: '{assistant}’s work', line: 'What {assistant} is doing and how far along' },
    coming: { name: 'Coming up', line: 'Automations and backups in the next hours' },
    done: { name: 'Done today', line: 'What {assistant} finished today' },
  },
  groups: {
    own: 'Whombat and {assistant}',
    servers: 'Servers',
    widgets: 'Made by {assistant}',
    accounts: 'Your accounts',
  },
  figures: { name: 'Figures', line: 'Its main figures' },
  server: { line: 'Processor, memory and disk, with a chart when it’s wide' },
  popups: { all: 'Questions and problems', problems: 'Problems only', none: 'Nothing' },
  sizes: { smaller: 'Smaller', normal: 'Normal', larger: 'Larger' },
  turns: { touch: 'When touched', '30s': 'Every 30 s', '60s': 'Every minute' },
  pill: { one: '1 thing needs you', many: '{n} things need you' },
  locked: { ask: '{assistant} has a question', hidden: 'Unlock to see it' },
  doorbell: { big: 'Show it big', off: 'Don’t' },
  spotlight: { doorbell: 'Someone’s at the door' },
} as const;
