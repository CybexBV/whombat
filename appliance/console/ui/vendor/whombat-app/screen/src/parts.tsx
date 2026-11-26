/**
 * The small parts every widget is drawn from: the screen's context (the assistant's name, the time zone, the host's
 * picture loader and face), marks, the header, bars and meters, the SVG lines over time, pictures.
 */
import { isBrandMark, WORDMARKS } from '@whombat/brand';
import { BrandMark } from '@whombat/brand/react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DeskImage, DeskViewTone } from './types';
import s from './widgets.module.css';

/* The screen's context ------------------------------------------------------------------------------------------- */

/** What every widget may need from the host, kept stable across draws (the callbacks read the latest props). */
export interface ScreenEnv {
  assistant: string;
  timeZone?: string | undefined;
  /** A picture a view names, as an object URL the host owns (it may cache it; the screen never revokes it). */
  loadImage?: ((image: DeskImage) => Promise<string>) | undefined;
  /** The assistant's face at `size` px; a lettered circle when absent. */
  renderFace?: ((size: number) => ReactNode) | undefined;
  /** A server's own screen (DK-83). */
  onServer?: ((id: string) => void) | undefined;
  /** “+3” in *Servers*: every server. */
  onServers?: (() => void) | undefined;
  /** “{assistant} did 3 things today ›”. */
  onDoneToday?: (() => void) | undefined;
  /** The pill's modal, with everything (*How things are* opens it). */
  onAttention?: (() => void) | undefined;
  /** A widget opened big (DK-140). */
  onBig?: ((id: string) => void) | undefined;
  /** A widget hiding words while locked was touched. */
  onUnlock?: (() => void) | undefined;
  editing: boolean;
}

const EnvContext = createContext<ScreenEnv>({ assistant: 'Dusty', editing: false });
export const EnvProvider = EnvContext.Provider;
export const useEnv = () => useContext(EnvContext);

/* Colours by tone ------------------------------------------------------------------------------------------------ */

export type Colour = DeskViewTone | 'sand' | 'face';
const COLOUR_CLASS: Record<Colour, string | undefined> = {
  ok: s.cOk,
  warn: s.cWarn,
  bad: s.cBad,
  off: s.cOff,
  sand: s.cSand,
  face: s.cFace,
};
export const toneClass = (c: Colour | undefined) => (c ? (COLOUR_CLASS[c] ?? '') : '');
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/** The stroke colour of a line over time, by tone; neutral lines take the chart colour. */
export function strokeOf(tone: DeskViewTone | undefined, i = 0): string {
  if (tone === 'ok') return 'var(--ok)';
  if (tone === 'warn') return 'var(--warn)';
  if (tone === 'bad') return 'var(--bad)';
  if (tone === 'off') return 'var(--mut)';
  return ['var(--chart1)', 'var(--chart2)', 'var(--chart3)'][i % 3] ?? 'var(--chart1)';
}

/* Marks and icons ------------------------------------------------------------------------------------------------ */

const ICONS = {
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 5 12L17 12h4" />,
  now: (
    <>
      <rect x="3.5" y="5" width="7" height="14" rx="2" />
      <rect x="13.5" y="5" width="7" height="14" rx="2" />
    </>
  ),
  strip: (
    <>
      <rect x="3" y="8" width="5" height="8" rx="1.5" />
      <rect x="9.5" y="8" width="5" height="8" rx="1.5" />
      <rect x="16" y="8" width="5" height="8" rx="1.5" />
    </>
  ),
  cal: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  // The sun behind a cloud, whose fill is the tile's so the sun stays behind it.
  weather: (
    <>
      <circle cx="8.5" cy="8.5" r="3.2" />
      <path d="M8.5 2.6v.9M2.6 8.5h.9M4.3 4.3l.7.7M12.7 4.3l-.7.7" />
      <path
        d="M7 19h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 10.6 4.25 4.25 0 0 0 7 19Z"
        transform="translate(3 2.4) scale(0.88)"
        fill="var(--sf2)"
      />
    </>
  ),
  news: (
    <>
      <rect x="3.5" y="5" width="13.5" height="14" rx="2" />
      <path d="M17 9h3.5v8a2 2 0 0 1-2 2H17M7 9h6.5M7 12.5h6.5M7 16h4" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4.5" width="16" height="6.5" rx="2" />
      <rect x="4" y="13" width="16" height="6.5" rx="2" />
      <path d="M8 7.75h.01M8 16.25h.01" />
    </>
  ),
} as const;
export type IconName = keyof typeof ICONS;

/** One of Whombat's own widgets' signs, on a quiet tile. */
export function IconTile({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <span className={cx(s.mark, s.markIcon)} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        aria-hidden="true"
        width={size * 0.72}
        height={size * 0.72}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[name]}
      </svg>
    </span>
  );
}

/** A service's or OS's mark (`@whombat/brand`), else its first letter on a quiet tile. Always decorative. */
export function Mark({ mark, name, size = 24 }: { mark?: string | undefined; name: string; size?: number }) {
  // A wordmark can't be read at a mark's size: its name's letter stands in.
  if (mark && isBrandMark(mark) && !WORDMARKS.has(mark)) return <BrandMark mark={mark} size={size} />;
  const letter = [...name.trim()][0]?.toUpperCase() ?? '·';
  return (
    <span
      className={cx(s.mark, s.markLetter)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** The assistant's face: the host's drawing, else its initial on the assistant's colour. */
export function Face({ size }: { size: number }) {
  const env = useEnv();
  if (env.renderFace) return <>{env.renderFace(size)}</>;
  return (
    <span
      className={s.face}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      {[...env.assistant][0] ?? 'D'}
    </span>
  );
}

/* The header ----------------------------------------------------------------------------------------------------- */

/** “[mark] **Plex** · Now playing           2 watching”. */
export function Header({
  mark,
  name,
  title,
  right,
}: {
  mark: ReactNode;
  name?: string | undefined;
  title?: string | undefined;
  right?: ReactNode;
}) {
  return (
    <div className={s.hd}>
      {mark}
      <span className={s.hdName}>
        {name ? <b>{name}</b> : null}
        {name && title ? ` · ${title}` : title && !name ? <b>{title}</b> : null}
      </span>
      {right !== undefined && right !== null && right !== '' && <span className={s.hdRight}>{right}</span>}
    </div>
  );
}

/* Bars ----------------------------------------------------------------------------------------------------------- */

export function Bar({
  pct,
  colour,
  thin,
  className,
}: {
  pct: number;
  colour?: Colour | undefined;
  thin?: boolean;
  className?: string;
}) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span
      className={cx(s.bar, thin && s.thin, toneClass(colour), className)}
      role="img"
      aria-label={`${p} %`}
    >
      <i style={{ width: `${p}%` }} />
    </span>
  );
}

/** How many blocks a meter has: the server cards' twenty (Whombat desk-display.md DK-152). */
export const METER_BLOCKS = 20;

/** Blocks lit up to `pct`, in its tone. */
export function Blocks({ pct, tone, count = METER_BLOCKS }: { pct: number; tone: Colour; count?: number }) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * count);
  return (
    <span className={cx(s.blocks, toneClass(tone))} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => `b${i}`).map((key, i) => (
        <i key={key} className={s.blk} data-on={i < on || undefined} />
      ))}
    </span>
  );
}

/**
 * A server's figure on a line of its own, as the server cards drew it (DK-152): the short name (“CPU”), the blocks lit
 * up to it — amber, then red, from `at` — and the percentage; none: unlit blocks and “–”.
 */
export function Meter({
  k,
  label,
  pct,
  at,
  count,
}: {
  k: string;
  label: string;
  pct: number | undefined;
  at: { warn: number; bad: number };
  count?: number;
}) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const text = pct === undefined ? '–' : `${p} %`;
  return (
    <div className={s.meter} role="img" aria-label={`${label} ${text}`}>
      <span className={s.meterKey}>{k}</span>
      <Blocks pct={p} tone={p >= at.bad ? 'bad' : p >= at.warn ? 'warn' : 'ok'} count={count} />
      <b>{text}</b>
    </div>
  );
}

/* Lines over time ------------------------------------------------------------------------------------------------ */

/** The runs of a line in a 0…100 × 0…100 box, each a list of `[x, y]`; gaps (null) split it. `lo`…`hi` the range. */
export function lineRuns(
  values: readonly (number | null)[],
  lo: number,
  hi: number,
  pad = 4,
): [number, number][][] {
  const span = hi - lo || 1;
  const n = values.length;
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([n <= 1 ? 50 : (i / (n - 1)) * 100, 100 - pad - ((v - lo) / span) * (100 - 2 * pad)]);
  });
  if (run.length) runs.push(run);
  return runs;
}

const pointsText = (run: [number, number][]) =>
  run.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

/**
 * A line's range, calm as the mockups draw it: the values take the upper middle half of the height (room under them for
 * the wash, above for a peak), at least `minSpan` tall so a quiet line doesn't look wild, with room for `limit`, never
 * under `floor` (0 for percentages).
 */
export function lineRange(
  values: readonly (number | null)[],
  opts: { minSpan?: number; floor?: number; limit?: number | undefined } = {},
): { lo: number; hi: number } {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return { lo: 0, hi: 1 };
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  const minSpan = opts.minSpan ?? Math.max(1, Math.abs(hi) * 0.1);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const span = hi - lo;
  lo -= span * 0.6;
  hi += span * 0.35;
  if (opts.limit !== undefined) hi = Math.max(hi, opts.limit + span * 0.1);
  if (opts.floor !== undefined) lo = Math.max(opts.floor, lo);
  return { lo, hi };
}

/**
 * A line over time, as wide and high as its box (an SVG stretched to it, the stroke kept at 2.2 px): `fill` washes the
 * area under it, `grid` draws three faint lines, `limit` a dashed line where it gets serious.
 */
export function Line({
  series,
  fill,
  grid,
  limit,
  minSpan,
  floor,
  className,
}: {
  series: { points: readonly (number | null)[]; colour: string }[];
  fill?: boolean;
  grid?: boolean;
  limit?: number | undefined;
  minSpan?: number;
  floor?: number;
  className?: string;
}) {
  const all = series.flatMap((x) => x.points);
  const { lo, hi } = lineRange(all, { minSpan, floor, limit });
  const pad = fill ? 4 : 6;
  const limitY = limit === undefined ? null : 100 - pad - ((limit - lo) / (hi - lo || 1)) * (100 - 2 * pad);
  // A line's runs (split by gaps) are known only by their order.
  const runs: { key: number; run: [number, number][]; colour: string; first: boolean }[] = [];
  let n = 0;
  series.forEach((x, si) => {
    for (const run of lineRuns(x.points, lo, hi, pad))
      runs.push({ key: n++, run, colour: x.colour, first: si === 0 });
  });
  return (
    <svg
      className={cx(s.spark, className)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {grid &&
        [25, 50, 75].map((y) => (
          <line
            key={y}
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            stroke="var(--line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      {limitY !== null && (
        <line
          x1="0"
          x2="100"
          y1={limitY}
          y2={limitY}
          stroke="var(--bad)"
          strokeOpacity="0.5"
          strokeDasharray="5 6"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {runs.map((r) => (
        <g key={r.key}>
          {fill && r.first && (
            <polygon
              points={`${r.run[0]?.[0] ?? 0},100 ${pointsText(r.run)} ${r.run.at(-1)?.[0] ?? 100},100`}
              fill={r.colour}
              fillOpacity="0.14"
            />
          )}
          <polyline
            points={pointsText(r.run)}
            fill="none"
            stroke={r.colour}
            strokeWidth="2.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeOpacity="0.9"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}

/* Pictures ------------------------------------------------------------------------------------------------------- */

/**
 * A picture a view names, loaded through the host. While a new still of the same thing loads, the last one stays (a
 * camera doesn't flash); nothing is fetched while editing without a loader.
 */
export function useImage(image: DeskImage | undefined): string | null {
  const { loadImage } = useEnv();
  const key = image ? `${image.thing}\u0000${image.ref}` : '';
  // The key names the picture: a new object naming the same picture loads nothing again.
  const latest = useRef(image);
  latest.current = image;
  const [got, setGot] = useState<{ key: string; thing: string; url: string } | null>(null);
  useEffect(() => {
    const wanted = latest.current;
    if (!key || !wanted || !loadImage) return;
    let live = true;
    loadImage(wanted).then(
      (url) => {
        if (live) setGot({ key, thing: wanted.thing, url });
      },
      () => {
        // A picture that can't be had leaves the quiet tile in its place.
      },
    );
    return () => {
      live = false;
    };
  }, [key, loadImage]);
  if (!got || !image) return null;
  return got.key === key || got.thing === image.thing ? got.url : null;
}

/** A picture in a box of `width` × `height` px, a quiet tile until it's there. */
export function Picture({
  image,
  width,
  height,
  label,
  className,
}: {
  image: DeskImage | undefined;
  width: number;
  height: number;
  label?: string | undefined;
  className?: string;
}) {
  const url = useImage(image);
  const style = useMemo(() => ({ width: Math.round(width), height: Math.round(height) }), [width, height]);
  return (
    <div className={cx(s.img, className)} style={style}>
      {url && <img src={url} alt={image?.alt ?? ''} decoding="async" />}
      {label && width > 56 && <span className={s.posterLabel}>{label}</span>}
    </div>
  );
}

/** Each item with a key from its name, made unique (“Office”, “Office·2”), for lists that have no ids. */
export function keyed<T>(items: readonly T[], name: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = name(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [n === 1 ? base : `${base}·${n}`, item];
  });
}
