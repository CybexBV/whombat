/**
 * A subscription's usage inside its sign-in row (Settings → AI in the assistant shell; less-is-more.md AP-1780): the
 * windows as compact meters under the row's line, what wasn't read, the last probe's error and a refresh's problem;
 * and the small refresh control beside Sign out. The same `usage.list` snapshot and `usage.refresh` call as Usage's
 * cards (AP-340…AP-349), so the meters say what they said there.
 */
import type { SubscriptionUsage } from '@whombat/core/domain';
import { sortUsageWindows } from '@whombat/core/domain';
import { USAGE_PROVIDER_LABELS } from '@whombat/core/text';
import { RefreshCw } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { INLINE_USAGE_TEXT, USAGE_TEXT } from './model';
import styles from './Usage.module.css';
import type { UsageRefreshState } from './useUsage';
import { WindowMeter } from './WindowMeter';

export function InlineUsage({
  usage,
  refresh,
  now,
  timeZone,
}: {
  usage: SubscriptionUsage;
  refresh: UsageRefreshState;
  now: number;
  timeZone: string;
}) {
  const name = USAGE_PROVIDER_LABELS[usage.provider];
  const windows = sortUsageWindows(usage.windows);
  return (
    <div className={styles.inline} data-usage-inline={usage.provider}>
      {windows.length > 0 ? (
        <div className={styles.inlineWindows}>
          {windows.map((w) => (
            <WindowMeter
              key={`${w.kind}-${w.label}`}
              provider={name}
              window={w}
              now={now}
              timeZone={timeZone}
              compact
            />
          ))}
        </div>
      ) : (
        <span className={styles.inlineQuiet}>
          {usage.observedAt === null ? USAGE_TEXT.notRead : USAGE_TEXT.noWindows}
        </span>
      )}
      {usage.error ? <span className={styles.problem}>{usage.error}</span> : null}
      {refresh.problem ? (
        <span className={styles.problem} role="status">
          {refresh.problem}
        </span>
      ) : null}
    </div>
  );
}

/** Refresh, as a small control: the icon, its name (and the wait while a 429 or the minute counts down) for readers. */
export function RefreshUsageButton({
  provider,
  refresh,
}: {
  provider: SubscriptionUsage['provider'];
  refresh: UsageRefreshState;
}) {
  const name = USAGE_PROVIDER_LABELS[provider];
  const label =
    refresh.waitSeconds > 0
      ? `${USAGE_TEXT.refreshIn(refresh.waitSeconds)} (${name})`
      : refresh.pending
        ? `${USAGE_TEXT.refreshing} (${name})`
        : INLINE_USAGE_TEXT.refresh(name);
  return (
    <IconButton
      label={label}
      className={styles.refreshIcon}
      onClick={refresh.refresh}
      disabled={refresh.pending || refresh.waitSeconds > 0}
      data-pending={refresh.pending || undefined}
    >
      <Icon icon={RefreshCw} size={15} />
    </IconButton>
  );
}
