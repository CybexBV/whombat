/**
 * The box's outputs (Whombat desk-display.md DK-147): its own display and any monitor plugged into it. The kiosk's
 * compositor (cage) stretches the one window over every output; the kiosk tells the page where each output sits in it
 * (`#…&o=` in the URL, read from `wlr-randr` when the kiosk starts, and a display plugged in or out restarts the kiosk),
 * so the page draws one screen per output: the box's own (the desk) on the main one, a monitor's screen of widgets on
 * each other. The page tells the runtime which outputs it shows on and how big they are (`/api/desk/size`).
 *
 * Without the kiosk's word, or when it doesn't fit the window (a window resized since), the whole window is one
 * output, the main one.
 */

import { DESK_STAGE } from './deskScene';
import { DESK_OUTPUT_KEY_RE, DESK_OUTPUTS_MAX } from './grid';

/** An output as the kiosk describes it: its compositor name, the monitor's name, its place and size in the layout. */
export interface KioskOutput {
  /** The compositor's name (`eDP-1`, `HDMI-A-1`). */
  name: string;
  /** The monitor's own name (its EDID's model), when it has one. */
  model: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its size in millimetres, 0 when the monitor doesn't say. */
  mmWidth: number;
  mmHeight: number;
}

/** An output where the page draws it: its key, whether it is the box's own, its rectangle in the window (CSS px). */
export interface PlacedOutput {
  key: string;
  main: boolean;
  /** The monitor's name for Settings; null for the box's own display. */
  name: string | null;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The screen's size in logical pixels, what the grid is computed from. */
  logical: { width: number; height: number };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** The kiosk's outputs from the URL's fragment (`o=`: base64url JSON), or null when it sent none it could. */
export function outputsFromHash(hash: string): KioskOutput[] | null {
  for (const part of hash.replace(/^#/, '').split('&')) {
    if (!part.startsWith('o=')) continue;
    let json: unknown;
    try {
      const b64 = part.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
    if (!Array.isArray(json)) return null;
    const out: KioskOutput[] = [];
    for (const o of json.slice(0, 8)) {
      if (!isObj(o) || typeof o.n !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(o.n)) continue;
      const x = whole(o.x, -65_536, 65_536);
      const y = whole(o.y, -65_536, 65_536);
      const width = whole(o.w, 1, 16_384);
      const height = whole(o.h, 1, 16_384);
      if (x === null || y === null || width === null || height === null) continue;
      const model =
        typeof o.m === 'string'
          ? o.m
              .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
              .trim()
              .slice(0, 60)
          : '';
      out.push({
        name: o.n,
        model: model || null,
        x,
        y,
        width,
        height,
        mmWidth: whole(o.mw, 0, 10_000) ?? 0,
        mmHeight: whole(o.mh, 0, 10_000) ?? 0,
      });
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

/** A compositor name as the contract's output key: lower case, anything else a hyphen (`HDMI-A-1` → `hdmi-a-1`). */
export function outputKey(name: string): string {
  const k = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40);
  return DESK_OUTPUT_KEY_RE.test(k) ? k : 'display';
}

/** The box's own display: a laptop's or tablet's panel. */
const internal = (o: KioskOutput) => /^(edp|lvds|dsi)-/i.test(o.name);

/** The logical size's bounds (the contract's `DeskScreenSize`). */
const SIDE_MIN = 200;
const SIDE_MAX = 16_384;
const side = (v: number) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(v)));

/**
 * The box's own screen is drawn on the desk's stage (1280×800 zoomed to fill: the Z13's 2560×1600 is 1280×800), so
 * its logical size is the stage's.
 */
export function mainLogical(width: number, height: number): { width: number; height: number } {
  const zoom = Math.min(width / DESK_STAGE.width, height / DESK_STAGE.height);
  return { width: side(width / zoom), height: side(height / zoom) };
}

/**
 * A monitor's logical size: its pixels at about 96 per inch, as a computer would show it (a 24″ 1080p monitor is
 * 1920×1080, a 27″ 4K one about 2190×1230), in steps of a quarter; without a believable physical size (a TV, a
 * projector) as if it were 1080p high or wide at least.
 */
export function monitorLogical(o: Pick<KioskOutput, 'width' | 'height' | 'mmWidth' | 'mmHeight'>): {
  width: number;
  height: number;
} {
  const ppi = o.mmWidth > 0 ? (o.width / o.mmWidth) * 25.4 : 0;
  // A TV's EDID often gives only its aspect (160 × 90 “mm”): no monitor has 600 pixels an inch.
  const believable =
    o.mmWidth >= 100 &&
    o.mmHeight >= 60 &&
    ppi <= 300 &&
    Math.abs(o.mmWidth / o.mmHeight - o.width / o.height) < 0.15 * (o.width / o.height);
  const zoom = believable
    ? Math.min(3, Math.max(1, Math.round((ppi * 4) / 96) / 4))
    : Math.max(1, Math.min(o.width / 1920, o.height / 1080));
  return { width: side(o.width / zoom), height: side(o.height / zoom) };
}

/**
 * Where each output sits in the window: the kiosk's outputs when they tile the window (their bounding box is the
 * window, give or take a pixel, and none lies on another), the main one first (the box's own panel, else the first the
 * kiosk listed), then the rest left to right; at most the contract's four. Otherwise the whole window is the main one.
 */
export function placeOutputs(
  viewport: { width: number; height: number },
  outputs: KioskOutput[] | null,
): PlacedOutput[] {
  const whole = (): PlacedOutput[] => [
    {
      key: outputs?.length === 1 && outputs[0] ? outputKey(outputs[0].name) : 'display',
      main: true,
      name: null,
      left: 0,
      top: 0,
      width: viewport.width,
      height: viewport.height,
      logical: mainLogical(viewport.width, viewport.height),
    },
  ];
  if (!outputs || outputs.length < 2) return whole();
  const minX = Math.min(...outputs.map((o) => o.x));
  const minY = Math.min(...outputs.map((o) => o.y));
  const maxX = Math.max(...outputs.map((o) => o.x + o.width));
  const maxY = Math.max(...outputs.map((o) => o.y + o.height));
  const overlap = outputs.some((a, i) =>
    outputs.some(
      (b, j) =>
        j > i && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height,
    ),
  );
  if (overlap || Math.abs(maxX - minX - viewport.width) > 2 || Math.abs(maxY - minY - viewport.height) > 2)
    return whole();
  const main = outputs.find(internal) ?? (outputs[0] as KioskOutput);
  const rest = outputs.filter((o) => o !== main).sort((a, b) => a.x - b.x || a.y - b.y);
  const keys = new Set<string>();
  const placed: PlacedOutput[] = [];
  for (const o of [main, ...rest].slice(0, DESK_OUTPUTS_MAX)) {
    let key = outputKey(o.name);
    for (let n = 2; keys.has(key); n++) key = `${outputKey(o.name).slice(0, 36)}-${n}`;
    keys.add(key);
    const isMain = o === main;
    placed.push({
      key,
      main: isMain,
      name: isMain ? null : o.model,
      left: o.x - minX,
      top: o.y - minY,
      width: o.width,
      height: o.height,
      logical: isMain ? mainLogical(o.width, o.height) : monitorLogical(o),
    });
  }
  return placed;
}

/** What `/api/desk/size` gets: every output, the main one first. */
export interface SizeReport {
  outputs: { key: string; main: boolean; name: string | null; size: { width: number; height: number } }[];
}

export function sizeReport(placed: PlacedOutput[]): SizeReport {
  return {
    outputs: placed.map((o) => ({ key: o.key, main: o.main, name: o.name, size: o.logical })),
  };
}

/** How often the page says it again while nothing changed: a runtime that restarted learns the monitors again. */
export const SIZE_AGAIN_MS = 10 * 60_000;
