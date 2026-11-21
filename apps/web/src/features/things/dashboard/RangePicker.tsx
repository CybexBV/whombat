/**
 * The Summary's one range (Whombat dashboards.md DS-03, DS-16, connections-page.md CN-05; dashboards-web.md AP-2050…,
 * connections-page.md AP-2510): “1h · 6h · 24h · 7d · 30d · 90d” as the mock writes them. Beside the charts a figure
 * opened (`RangeSeg`); at the right end of the tab row only while the page still has a chart card of its own
 * (`RangePicker`), with “Live · every 10 s” before it on a server's page — the live words stay at the row's end
 * without the picker. The range lives in the address (`?range=7d`); every chart and small line follows it.
 */
import { DASHBOARD_RANGE_WORDS } from '@whombat/client/hosts';
import type { HostSeriesRange } from '@whombat/core';
import { cx } from '../../../components/cx';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { Dot } from '../parts';
import styles from './Head.module.css';

/** The segmented control alone; nothing with fewer than two ranges. */
export function RangeSeg({
  ranges,
  value,
  onChange,
  className,
}: {
  ranges: readonly HostSeriesRange[];
  value: HostSeriesRange;
  onChange: (range: HostSeriesRange) => void;
  className?: string;
}) {
  if (ranges.length < 2) return null;
  return (
    <SegmentedControl<HostSeriesRange>
      options={ranges.map((r) => ({ value: r, label: DASHBOARD_RANGE_WORDS[r] }))}
      value={value}
      onChange={onChange}
      label="Range"
      variant="soft"
      className={cx(styles.seg, className)}
    />
  );
}

/** The tab row's end: the live words (a server's page) and the picker (when there are ranges to pick). */
export function RangePicker({
  ranges,
  value,
  onChange,
  live,
}: {
  /** None or one: the live words alone. */
  ranges: readonly HostSeriesRange[];
  value: HostSeriesRange;
  onChange: (range: HostSeriesRange) => void;
  /** Words before it when the figures follow live events (“Live · every 10 s”). */
  live?: string;
}) {
  if (ranges.length < 2 && !live) return null;
  return (
    <div className={styles.range}>
      {live ? (
        <span className={styles.live}>
          <Dot tone="ok" />
          {live}
        </span>
      ) : null}
      <RangeSeg ranges={ranges} value={value} onChange={onChange} />
    </div>
  );
}
