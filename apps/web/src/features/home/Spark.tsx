/**
 * A small line over time with its wash and a dot at the newest reading (the mock's `.sp`): the line keeps its width
 * when stretched, the dot is drawn in HTML so it stays round. Decorative: the figure beside it says it in words.
 */
import { cx } from '../../components/cx';
import s from './Arranged.module.css';

export function Spark({ points, className }: { points: readonly number[]; className?: string }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  // A flat line sits in the middle; otherwise the lowest reading touches the bottom with a little room above.
  const y = (v: number) => (max === min ? 50 : 96 - ((v - min) / span) * 88);
  const x = (i: number) => (i / (points.length - 1)) * 100;
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const last = points[points.length - 1] as number;
  return (
    <div className={cx(s.sp, className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="presentation">
        <path className={s.area} d={`${line} L100,100 L0,100 Z`} />
        <path className={s.ln} d={line} />
      </svg>
      <span className={s.end} style={{ top: `${y(last)}%` }} />
    </div>
  );
}
