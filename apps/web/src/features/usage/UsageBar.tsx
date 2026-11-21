import type { UsageWindow } from '@whombat/core/domain';
import { formatUsageWindowLine } from '@whombat/core/text';
import { cx } from '../../components/cx';
import { meterTone, meterValue } from './model';
import styles from './Usage.module.css';

export interface UsageBarProps {
  window: Pick<UsageWindow, 'label' | 'usedPct' | 'resetsAt' | 'status'>;
  /** Accessible name: “Claude 5-hour usage”. */
  label: string;
  now: Date | number;
  /** `md` in the cards (8px), `sm` in the table and the compact meter (6px). */
  size?: 'md' | 'sm';
  className?: string;
}

/**
 * One window's share as a bar (AP-343): a `meter` from 0 to 100 whose value text is core's window line (“5-hour ·
 * 62 % · resets in 2 h 10 min”, “limit reached”), filled in `--ok`, `--warn` from 80 % or `--bad` from 95 % and when
 * limited. The words beside it carry the state as well; the color only repeats it.
 */
export function UsageBar({ window: w, label, now, size = 'md', className }: UsageBarProps) {
  const value = meterValue(w);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> can't be styled the same in every browser with tokens
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={formatUsageWindowLine(w, now)}
      className={cx(styles.track, size === 'sm' && styles.trackSm, className)}
      data-tone={meterTone(w)}
    >
      <span className={styles.fill} style={{ width: `${value}%` }} />
    </div>
  );
}
