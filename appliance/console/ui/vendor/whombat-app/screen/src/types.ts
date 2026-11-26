/**
 * The contract's shapes the drawing reads, as plain TypeScript (Whombat `@whombat/core` `desk-screens.ts` and
 * `desk-glance.ts`). They mirror the zod types member for member — a test keeps both assignable to each other — so the
 * box's console can take this package's source without zod or core.
 */
import type { ScreenSize, WidgetType } from './specs';

/* The layout ------------------------------------------------------------------------------------------------------ */

export type DeskTurn = 'touch' | '30s' | '60s';
export type DeskPopups = 'all' | 'problems' | 'none';
/** What a locked screen shows: the clock alone, the widgets without private words, or everything. */
export type DeskLockedView = 'time' | 'summary' | 'everything';
export type DeskViewTone = 'ok' | 'warn' | 'bad' | 'off';
export type DeskAttentionTone = 'bad' | 'warn';
export type LookResearchState = 'looking' | 'found' | 'fixing' | 'fixed' | 'failed';

export interface DeskWidget {
  id: string;
  type: WidgetType;
  ref?: string | undefined;
  opts: Record<string, string>;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** When a page is in the turning: `from`–`to` (`HH:MM`) in the person's zone, on `days` (every day without). */
export interface DeskPageShow {
  from: string;
  to: string;
  days?: Weekday[] | undefined;
}

export interface DeskPage {
  id: string;
  name: string;
  layouts: Record<string, DeskWidget[]>;
  last: string;
  show?: DeskPageShow | undefined;
}

export interface DeskLayout {
  pages: DeskPage[];
  turn: DeskTurn;
  size: ScreenSize;
}

/* The views ------------------------------------------------------------------------------------------------------- */

export interface DeskImage {
  thing: string;
  ref: string;
  shape: 'poster' | 'wide' | 'square';
  alt?: string | undefined;
}

export interface DeskViewFigure {
  value: string;
  unit?: string | undefined;
  label: string;
  tone?: DeskViewTone | undefined;
}

/** One of a row's limits, drawn as blocks: “WEEK ▮▮▮▯ 62 % used · resets 2 Dec”. */
export interface DeskViewMeter {
  key?: string | undefined;
  pct: number;
  text: string;
  reset?: string | undefined;
  tone?: DeskViewTone | undefined;
}

export interface DeskViewRow {
  title: string;
  detail?: string | undefined;
  meta?: string | undefined;
  note?: string | undefined;
  time?: string | undefined;
  tone?: DeskViewTone | undefined;
  progress?: number | undefined;
  meters?: DeskViewMeter[] | undefined;
  mark?: string | undefined;
  state?: 'on' | 'off' | undefined;
  image?: DeskImage | undefined;
}

export interface DeskViewPoster {
  title: string;
  detail?: string | undefined;
  who?: string | undefined;
  progress?: number | undefined;
  time?: string | undefined;
  image?: DeskImage | undefined;
}

export interface DeskViewBase {
  id: string;
  title: string;
  name?: string | undefined;
  mark?: string | undefined;
  tone?: DeskViewTone | undefined;
  problem?: { text: string; detail?: string | undefined } | undefined;
  locked?: boolean | undefined;
  at?: string | undefined;
}

export interface DeskFiguresView extends DeskViewBase {
  kind: 'figures';
  items: DeskViewFigure[];
  line?: string | undefined;
  spark?: number[] | undefined;
  progress?: number | undefined;
}

export interface DeskListView extends DeskViewBase {
  kind: 'list';
  head?: string | undefined;
  progress?: number | undefined;
  rows: DeskViewRow[];
  count?: number | undefined;
  empty?: string | undefined;
}

export interface DeskPostersView extends DeskViewBase {
  kind: 'posters';
  head?: string | undefined;
  items: DeskViewPoster[];
  shape: 'poster' | 'wide' | 'square';
  empty?: string | undefined;
}

export interface DeskChartSeries {
  label?: string | undefined;
  points: (number | null)[];
  tone?: DeskViewTone | undefined;
}

export interface DeskChartView extends DeskViewBase {
  kind: 'chart';
  figure?: { value: string; rest?: string | undefined; tone?: DeskViewTone | undefined } | undefined;
  stats?: string[] | undefined;
  series: DeskChartSeries[];
  unit?: string | undefined;
  limit?: number | undefined;
  foot?: { label: string; value: string }[] | undefined;
}

export interface DeskCameraView extends DeskViewBase {
  kind: 'camera';
  image?: DeskImage | undefined;
  event?: string | undefined;
}

export interface DeskServerView extends DeskViewBase {
  kind: 'server';
  line?: string | undefined;
  state: 'ok' | 'warn' | 'bad' | 'off';
  say?: string | undefined;
  cpu?: number | undefined;
  memory?: number | undefined;
  disk?: number | undefined;
  spark?: number[] | undefined;
  range?: '1h' | '24h' | '7d' | undefined;
  stats?: string[] | undefined;
  uptime?: string | undefined;
  server: string;
}

export interface DeskTextView extends DeskViewBase {
  kind: 'text';
  body: string;
}

export interface DeskViewTile {
  label: string;
  tone: DeskViewTone;
  value?: string | undefined;
}

export interface DeskViewPhoto {
  image: DeskImage;
  caption?: string | undefined;
  time?: string | undefined;
}

export interface DeskPhotoView extends DeskViewBase {
  kind: 'photo';
  items: DeskViewPhoto[];
  every?: number | undefined;
  empty?: string | undefined;
}

export interface DeskBoardView extends DeskViewBase {
  kind: 'board';
  head?: string | undefined;
  items: DeskViewTile[];
  count?: number | undefined;
  empty?: string | undefined;
}

export interface DeskWeatherHour {
  at: string;
  temp: number;
  symbol: string;
  rainMm?: number | undefined;
}

export interface DeskWeatherDay {
  date: string;
  high: number;
  low: number;
  symbol: string;
  rainMm?: number | undefined;
}

export interface DeskWeatherView extends DeskViewBase {
  kind: 'weather';
  place?: string | undefined;
  unit: 'C' | 'F';
  now?:
    | {
        temp: number;
        symbol: string;
        text: string;
        wind?: string | undefined;
        feels?: number | undefined;
      }
    | undefined;
  today?:
    | { high: number; low: number; rainMm?: number | undefined; rainChance?: number | undefined }
    | undefined;
  hours: DeskWeatherHour[];
  days: DeskWeatherDay[];
  sun?:
    | { rise?: string | undefined; set?: string | undefined; polar?: 'day' | 'night' | undefined }
    | undefined;
  credit: string;
}

export type DeskWidgetView =
  | DeskFiguresView
  | DeskListView
  | DeskPostersView
  | DeskChartView
  | DeskCameraView
  | DeskServerView
  | DeskTextView
  | DeskPhotoView
  | DeskBoardView
  | DeskWeatherView;

export type DeskWidgetViewKind = DeskWidgetView['kind'];

/* What needs the person ------------------------------------------------------------------------------------------- */

export interface DeskAttentionItem {
  key: string;
  kind: 'ask' | 'look';
  tone: DeskAttentionTone;
  pops: boolean;
  title: string;
  detail?: string | undefined;
  since?: string | undefined;
  name?: string | undefined;
  ask?: number | undefined;
  look?: string | undefined;
  server?: string | undefined;
  research?: LookResearchState | undefined;
  fix?: string | undefined;
}

export interface DeskAttention {
  items: DeskAttentionItem[];
  more: number;
  tone?: DeskAttentionTone | undefined;
}

/* The screen's grid ----------------------------------------------------------------------------------------------- */

/** A widget taking over the screen for a moment: the doorbell rang. */
export interface DeskSpotlight {
  id: string;
  widget: { id: string; type: WidgetType; ref?: string | undefined; opts: Record<string, string> };
  until: string;
  reason: 'doorbell';
}

export interface DeskGrid {
  screen: string;
  layout: DeskLayout;
  views: DeskWidgetView[];
  attention: DeskAttention;
  popups: DeskPopups;
  trying?: { until: string } | undefined;
  spotlight?: DeskSpotlight | undefined;
}

/* The calm glance's parts Whombat's own widgets read -------------------------------------------------------------- */

export type DeskHeadlineTone = 'ok' | 'busy' | 'warn' | 'bad';

export interface DeskHeadline {
  tone: DeskHeadlineTone;
  text: string;
  more?: string | undefined;
}

export interface DeskMoment {
  key: string;
  kind: 'work' | 'activity' | 'figure' | 'coming';
  name: string;
  mark?: string | undefined;
  value: string;
  detail?: string | undefined;
  progress?: number | undefined;
  pinned?: boolean | undefined;
}

export interface DeskStripServer {
  id?: string | undefined;
  name: string;
  mark: string;
  state: 'ok' | 'warn' | 'bad' | 'off';
  say?: string | undefined;
  spark?: number[] | undefined;
  work?: 'done' | 'now' | 'next' | undefined;
  progress?: number | undefined;
}

/**
 * The calm glance as *How things are*, *What’s going on* and *Servers* read it: the sentence by the clock, what's going
 * on, the servers and how many more, and how many things the assistant did today. Core's `DeskCalm` is one of these.
 */
export interface ScreenCalm {
  headline: DeskHeadline;
  moments: DeskMoment[];
  strip: DeskStripServer[];
  moreStrip: number;
  doneCount?: number | undefined;
}
