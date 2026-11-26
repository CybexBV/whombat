/**
 * Each widget's smallest, largest and first size in cells (DK-131), so the editor, the screen and the runtime agree.
 * A panel's depend on what it draws (`view`), known once the runtime resolved it; before that, the panel's own.
 */

export const SCREEN_SIZES = ['smaller', 'normal', 'larger'] as const;
export type ScreenSize = (typeof SCREEN_SIZES)[number];

export const OWN_WIDGETS = [
  'clock',
  'status',
  'now',
  'strip',
  'work',
  'coming',
  'done',
  'weather',
  'news',
] as const;
export type OwnWidget = (typeof OWN_WIDGETS)[number];
export const WIDGET_TYPES = [...OWN_WIDGETS, 'server', 'figures', 'panel', 'widget'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const VIEW_KINDS = [
  'figures',
  'list',
  'posters',
  'chart',
  'camera',
  'server',
  'text',
  'photo',
  'board',
  'weather',
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export interface WidgetSpecLike {
  type: WidgetType;
  /** A server widget's sizes follow what it shows (`opts.show`). */
  opts?: Readonly<Record<string, string>> | undefined;
}

/** In cells, `[wide, high]`. */
export interface WidgetSize {
  min: readonly [number, number];
  max: readonly [number, number];
  def: readonly [number, number];
}

const size = (min: [number, number], max: [number, number], def: [number, number]): WidgetSize => ({
  min,
  max,
  def,
});

export const OWN_SIZES: Readonly<Record<OwnWidget, WidgetSize>> = {
  clock: size([2, 1], [8, 3], [3, 2]),
  status: size([2, 1], [8, 2], [3, 2]),
  now: size([2, 2], [12, 3], [8, 2]),
  strip: size([2, 1], [16, 2], [8, 1]),
  work: size([2, 1], [8, 3], [4, 1]),
  coming: size([2, 1], [4, 4], [2, 2]),
  done: size([2, 1], [6, 4], [3, 2]),
  // One cell is the symbol and the temperature; wider adds the hours, higher the days.
  weather: size([1, 1], [8, 4], [2, 2]),
  news: size([2, 1], [6, 5], [3, 2]),
};

/** A panel's, by what it draws. */
export const VIEW_SIZES: Readonly<Record<ViewKind, WidgetSize>> = {
  figures: size([1, 1], [4, 2], [2, 1]),
  list: size([2, 1], [6, 5], [3, 2]),
  // One cell high, what's playing is a count and a gallery a strip of small pictures.
  posters: size([2, 1], [8, 4], [4, 2]),
  chart: size([2, 1], [8, 4], [4, 2]),
  camera: size([2, 2], [8, 5], [4, 3]),
  server: size([2, 1], [6, 3], [2, 2]),
  text: size([2, 1], [6, 4], [3, 2]),
  // A picture worth looking at needs room; a board starts as a strip of tiles.
  photo: size([2, 2], [8, 5], [4, 3]),
  board: size([2, 1], [8, 4], [4, 2]),
  weather: size([1, 1], [8, 4], [2, 2]),
};

export const SERVER_SIZE = VIEW_SIZES.server;

/**
 * What a server widget shows (`opts.show`; Whombat desk-display.md DK-153): its overview (processor, memory and disk) unless
 * chosen, or one part of it — its processor, memory or network over the widget's range, its storage, its virtual machines
 * and containers, its temperature or its open alerts. Each part draws one of the views every screen knows.
 */
export const SERVER_SHOWS = [
  'overview',
  'cpu',
  'memory',
  'network',
  'storage',
  'guests',
  'temp',
  'alerts',
] as const;
export type ServerShow = (typeof SERVER_SHOWS)[number];
export const SERVER_SHOW_VIEWS: Readonly<Record<ServerShow, ViewKind>> = {
  overview: 'server',
  cpu: 'chart',
  memory: 'chart',
  network: 'chart',
  storage: 'list',
  guests: 'list',
  temp: 'figures',
  alerts: 'list',
};

/** Where a server's meters turn amber and red: the box's own tones (core `DESK_BOX_TONES`, kept equal by a test). */
export const METER_TONES = {
  cpu: { warn: 75, bad: 90 },
  memory: { warn: 80, bad: 90 },
  storage: { warn: 85, bad: 95 },
} as const;

/** A server widget's part: its own choice when it's one of `SERVER_SHOWS`, else the overview. */
export function serverShow(opts: Readonly<Record<string, string>> | undefined): ServerShow {
  const show = opts?.show ?? '';
  return (SERVER_SHOWS as readonly string[]).includes(show) ? (show as ServerShow) : 'overview';
}
export const FIGURES_SIZE = VIEW_SIZES.figures;
/** A widget the assistant made for Home: a few figures over time. */
export const HOME_WIDGET_SIZE = size([1, 1], [4, 2], [2, 1]);
/** A panel before the runtime said what it draws. */
export const PANEL_SIZE = size([1, 1], [8, 5], [3, 2]);

/** A widget's sizes: its type's, a server's by what it shows, a panel's by `view` when known. */
export function sizeOf(w: WidgetSpecLike, view?: string): WidgetSize {
  switch (w.type) {
    case 'server':
      return VIEW_SIZES[SERVER_SHOW_VIEWS[serverShow(w.opts)]];
    case 'figures':
      return FIGURES_SIZE;
    case 'widget':
      return HOME_WIDGET_SIZE;
    case 'panel':
      return view && (VIEW_KINDS as readonly string[]).includes(view)
        ? VIEW_SIZES[view as ViewKind]
        : PANEL_SIZE;
    default:
      return OWN_SIZES[w.type];
  }
}

/** `w` × `h` clamped to a widget's sizes. */
export function clampSize(s: WidgetSize, w: number, h: number): { w: number; h: number } {
  return {
    w: Math.max(s.min[0], Math.min(s.max[0], w)),
    h: Math.max(s.min[1], Math.min(s.max[1], h)),
  };
}
