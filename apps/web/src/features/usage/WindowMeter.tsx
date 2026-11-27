import type { UsageWindow } from '@whombat/core/domain';
import { formatResetsIn, formatResetTime } from '@whombat/core/text';
import { currentLocale } from '../../i18n/provider';
import { meterTone, windowPctText, windowStatusWord } from './model';
import styles from './Usage.module.css';
import { UsageBar } from './UsageBar';

/**
 * One window of a subscription (AP-343): its label, a word for its state and its share over the bar, and “resets in
 * 2 h 10 min” under it (the reset time on hover). Your subscriptions' cards and the AI gateway's accounts (AP-1120);
 * `compact` inside a sign-in row (Settings → AI in the assistant shell, less-is-more.md AP-1780): smaller words, the
 * 6px bar.
 */
export function WindowMeter({
  provider,
  window: w,
  now,
  timeZone,
  compact = false,
}: {
  provider: string;
  window: UsageWindow;
  now: number;
  timeZone: string;
  compact?: boolean;
}) {
  const word = windowStatusWord(w);
  const tone = meterTone(w);
  const resets = formatResetsIn(w.resetsAt, now, currentLocale());
  return (
    <div className={styles.window} data-usage-window={w.kind} data-compact={compact || undefined}>
      <div className={styles.windowHead}>
        <span className={styles.windowLabel}>{w.label}</span>
        <span className={styles.windowValue}>
          {word ? (
            <span className={styles.word} data-tone={tone}>
              {word}
            </span>
          ) : null}
          <span className={styles.pct}>{windowPctText(w)}</span>
        </span>
      </div>
      <UsageBar window={w} label={`${provider} ${w.label} usage`} now={now} size={compact ? 'sm' : 'md'} />
      {resets ? (
        <span
          className={styles.windowMeta}
          title={w.resetsAt ? formatResetTime(w.resetsAt, now, timeZone, currentLocale()) : undefined}
        >
          {resets}
        </span>
      ) : null}
    </div>
  );
}
