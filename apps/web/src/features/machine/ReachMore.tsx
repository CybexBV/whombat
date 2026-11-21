import { ChevronRight } from 'lucide-react';
import { Icon } from '../../components/Icon';
import m from './Machine.module.css';

/**
 * “What you get” or “What to know” under a way to reach the Whombat: its points, folded so the row stays one glance.
 * A native disclosure, so it opens with the keyboard and screen readers say whether it is open.
 */
export function ReachMore({ label, points }: { label: string; points: readonly string[] }) {
  return (
    <details className={m.reachMore}>
      <summary>
        {label}
        <Icon icon={ChevronRight} size={13} />
      </summary>
      <ul className={m.reachPoints}>
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </details>
  );
}
