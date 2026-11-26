/**
 * The weather's own line icons (Whombat weather-news.md): drawn here from a symbol's parts (`weatherSign`), no pictures
 * from anywhere. Lines in `currentColor` (the cloud), the sun in the warm token, rain in the chart's blue, snow in the
 * ink; the cloud is filled with the card's colour so the sun behind it stays behind. Always decorative: the words beside
 * it say what the sky does.
 */
import type { ReactNode } from 'react';
import { type WeatherSign, weatherSign } from './weather';
import s from './widgets.module.css';

/** A cloud, 2.5…21.8 wide and 6.5…19 high on the 24-grid. */
const CLOUD = 'M7 19h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 10.6 4.25 4.25 0 0 0 7 19Z';
const MOON = 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z';

/** Rays around (cx, cy) from r1 to r2, at the given angles (degrees, 0 = right, clockwise on screen). */
function rays(cx: number, cy: number, r1: number, r2: number, angles: readonly number[]): string {
  return angles
    .map((a) => {
      const t = (a * Math.PI) / 180;
      const p = (r: number) => `${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
      return `M${p(r1)}L${p(r2)}`;
    })
    .join('');
}

const ALL = [0, 45, 90, 135, 180, 225, 270, 315] as const;
/** Behind a cloud only the rays above and to the left show. */
const PEEK = [135, 180, 225, 270, 315] as const;

function Sky({ sky, size }: { sky: WeatherSign['sky']; size: 'full' | 'left' | 'peek' }) {
  if (!sky) return null;
  if (sky === 'moon') {
    const [x, y, k] = size === 'full' ? [0, 0, 1] : size === 'left' ? [-2.5, -2.5, 0.85] : [-1, -1.5, 0.6];
    return (
      <path
        d={MOON}
        transform={`translate(${x} ${y}) scale(${k})`}
        strokeWidth={1.6 / k}
        className={s.wxMoon}
      />
    );
  }
  const [cx, cy, r, r1, r2] =
    size === 'full'
      ? [12, 12, 4.2, 6.8, 9.2]
      : size === 'left'
        ? [10, 10, 3.8, 6.2, 8.4]
        : [8, 7.5, 3, 4.9, 6.6];
  return (
    <g className={s.wxSun}>
      <circle cx={cx} cy={cy} r={r} />
      <path d={rays(cx, cy, r1, r2, size === 'peek' ? PEEK : ALL)} />
    </g>
  );
}

/** Where the pieces fall from, by how much: light two, plain three, heavy four; around a flash, only its sides. */
function fallX(amount: 1 | 2 | 3, thunder: boolean, shift: number): number[] {
  const xs = thunder
    ? [7.5, 17.5]
    : amount === 1
      ? [10, 15]
      : amount === 2
        ? [8.5, 12.5, 16.5]
        : [7.5, 11, 14.5, 18];
  return xs.map((x) => x + shift);
}

function Fall({ sign, shift }: { sign: WeatherSign; shift: number }) {
  const { fall, amount, thunder } = sign;
  if (!fall) return null;
  const long = amount === 3 ? 3.6 : 2.8;
  const pieces: ReactNode[] = fallX(amount, thunder, shift).map((x, i) => {
    const snow = fall === 'snow' || (fall === 'sleet' && i % 2 === 1);
    const y = i % 2 === 1 ? 18.8 : 17.6;
    return snow ? (
      <circle key={x} cx={x - 0.6} cy={y + 1.6} r={1.05} className={s.wxSnow} />
    ) : (
      <path key={x} d={`M${x} ${y}l-1.1 ${long}`} className={s.wxRain} />
    );
  });
  return <>{pieces}</>;
}

/** A weather sign `size` px square for MET's symbol (`partlycloudy_day`, `heavyrain`; any other a plain cloud). */
export function WeatherIcon({ symbol, size }: { symbol: string; size: number }) {
  const sign = weatherSign(symbol);
  const below = sign.fall !== null || sign.fog;
  const behind = sign.sky !== null && sign.cloud === 'big';
  // The cloud rises to leave room for what falls, and moves right when the sun or the moon peeks from behind it.
  const [cx, cy, k] =
    sign.cloud === 'small'
      ? [10.5, 9.6, 0.56]
      : behind
        ? below
          ? [3, -1, 0.88]
          : [3, 2.4, 0.88]
        : below
          ? [0, -3.5, 1]
          : [0, 0, 1];
  return (
    <svg
      className={s.wxIcon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <Sky sky={sign.sky} size={sign.cloud === 'none' ? 'full' : sign.cloud === 'small' ? 'left' : 'peek'} />
      {sign.cloud !== 'none' && (
        // A smaller cloud keeps the same line.
        <path
          d={CLOUD}
          transform={`translate(${cx} ${cy}) scale(${k})`}
          strokeWidth={1.6 / k}
          className={s.wxCloud}
        />
      )}
      <Fall sign={sign} shift={behind ? 1 : 0} />
      {sign.thunder && <path d="M13.2 16.2l-2.4 3.4h2.9l-2.3 3.4" className={s.wxBolt} />}
      {sign.fog && <path d="M4 18.6h16M6.5 21.6h11" className={s.wxFog} />}
    </svg>
  );
}
