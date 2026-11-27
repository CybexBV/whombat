/**
 * A server's Sensors (ported from Rackoon's `Overview` temperatures and `Health` fans): the temperatures over a range
 * as one chart with each sensor's own warm line, every sensor now, at its peak and against its limit, then fans, GPUs
 * and UPSes when the server has them. Hints about sensors first.
 */
import {
  DASH,
  detailGuests,
  formatNum,
  formatPct,
  formatTemp,
  formatTemp1,
  formatTempDense,
  formatTooltipTime,
  hostRangeWords,
  hostTone,
  sensorLevel,
  serverNoticeOptions,
  serverWatch,
  tempScale,
  timeTicks,
  warmFrom,
} from '@whombat/client/hosts';
import { useHostServerMetrics } from '@whombat/client/hosts/react';
import type { HostSeriesRange } from '@whombat/core/domain';
import { useState } from 'react';
import { TimeChart } from '../../../components/charts';
import { cx } from '../../../components/cx';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useWebI18n } from '../../../i18n/provider';
import { useLocaleWords } from '../../../i18n/words';
import { Card, Empty, StateCell } from '../parts';
import { useServerEndQuiet } from '../quiet/KeepQuiet';
import { useServerQuiet } from '../quiet/useQuiet';
import styles from '../Things.module.css';
import type { TabProps } from './tabProps';
import { WatchNotices } from './WatchNotices';

const COLORS = ['var(--chart2)', 'var(--chart1)', 'var(--chart3)', 'var(--face-dusty)'] as const;
const RANGES: HostSeriesRange[] = ['6h', '24h', '7d'];

export function SensorsTab({ burrow, serverId, detail, timeZone }: TabProps) {
  const HOST_RANGE_WORDS = useLocaleWords(hostRangeWords);
  const { tag: uiLocale } = useWebI18n();
  const [range, setRange] = useState<HostSeriesRange>('24h');
  const sensors = detail.sensors.slice(0, 4);
  const keys = sensors.map((s) => `temp_${s.id}_c`);
  const metrics = useHostServerMetrics(
    keys.length ? { params: { burrow, serverId }, query: { range, series: keys.join(',') } } : null,
  );
  // Its lines with the ⋯ menu, quiet ones greyed (quiet-notices.md AP-4828).
  const sq = useServerQuiet(burrow, serverId);
  // A line held because the server is kept quiet ends with it: End now, as under the page's head.
  const end = useServerEndQuiet(burrow, serverId, detail.server.name ?? serverId);
  const hints = serverWatch(
    [],
    detail.hints.filter((h) => h.section === 'sensors'),
    serverId,
    serverNoticeOptions(detail, detailGuests(detail), {
      quiet: sq.mayQuiet,
      ...(timeZone ? { timeZone } : {}),
    }),
  );
  const fans = detail.health?.fans ?? [];
  const gpus = detail.health?.gpus ?? [];
  const ups = detail.health?.ups ?? [];
  const data = metrics.data;
  const all = keys.flatMap((k) => data?.series[k] ?? []);
  const hottest = sensors[0];
  const scale = tempScale(all, hottest ? warmFrom(hottest.limitC) : null);
  return (
    <>
      <WatchNotices burrow={burrow} rows={hints} quiet={sq.actions} onEnd={end.onEnd} ending={end.ending} />
      <Card
        title="Temperatures"
        meta={
          sensors.length && hottest
            ? `${HOST_RANGE_WORDS[range]} · dashed line: ${hottest.label} warm from ${warmFrom(hottest.limitC)} °C`
            : HOST_RANGE_WORDS[range]
        }
        link={
          <span style={{ marginLeft: 'auto' }}>
            <SegmentedControl
              options={RANGES.map((r) => ({
                value: r,
                label: r === '6h' ? '6 h' : r === '24h' ? '24 h' : '7 days',
              }))}
              value={range}
              onChange={setRange}
              label="Range"
              size="sm"
              variant="soft"
            />
          </span>
        }
      >
        {sensors.length === 0 ? (
          <Empty>This server doesn’t report temperatures.</Empty>
        ) : (
          <div className={styles.chart}>
            {data ? (
              <TimeChart
                label={`Temperatures, ${HOST_RANGE_WORDS[range].toLowerCase()}`}
                height={190}
                series={sensors.map((s, i) => ({
                  key: `temp_${s.id}_c`,
                  label: s.label,
                  color: COLORS[i % COLORS.length] ?? 'var(--chart1)',
                  values: data.series[`temp_${s.id}_c`] ?? [],
                }))}
                min={scale.min}
                max={scale.max}
                ticks={scale.ticks}
                tickLabel={formatTempDense}
                timeTicks={timeTicks(data.timestamps, data.range, timeZone)}
                pointLabel={(i) =>
                  formatTooltipTime(data.range, Date.parse(data.timestamps[i] ?? ''), timeZone, uiLocale)
                }
                formatValue={formatTemp1}
                lines={hottest ? [{ value: warmFrom(hottest.limitC), color: 'var(--warn)' }] : undefined}
              />
            ) : (
              <div style={{ height: 190 }} aria-busy="true" />
            )}
          </div>
        )}
      </Card>
      {detail.sensors.length ? (
        <Card title="Sensors" meta={`${detail.sensors.length} reporting`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Sensor
                </th>
                <th scope="col">Now</th>
                <th scope="col" className={styles.dropS}>
                  Peak
                </th>
                <th scope="col" className={styles.dropM}>
                  Limit
                </th>
                <th scope="col" className={styles.dropL}>
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.sensors.map((s, i) => {
                const tone = hostTone(sensorLevel(s.nowC, s.limitC));
                // The chart's colour for the sensors it draws: the table is its legend.
                const color = i < sensors.length ? COLORS[i % COLORS.length] : undefined;
                return (
                  <tr key={s.id}>
                    <td className={styles.cellMain}>
                      <span className={styles.cellLine}>
                        {color ? (
                          <i className={styles.swatch} style={{ background: color }} aria-hidden="true" />
                        ) : null}
                        <span className={styles.ellipsis}>{s.label}</span>
                      </span>
                    </td>
                    <td>
                      <StateCell tone={tone} text={formatTemp(s.nowC)} />
                    </td>
                    <td className={cx(styles.num, styles.dropS)}>{formatTemp(s.maxC)}</td>
                    <td className={cx(styles.num, styles.dropM)}>{formatTemp(s.limitC)}</td>
                    <td className={cx(styles.kind, styles.dropL)}>{s.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : null}
      {fans.length ? (
        <Card title="Fans">
          <table className={styles.table}>
            <tbody>
              {fans.map((f) => (
                <tr key={`${f.source}${f.label}`}>
                  <td className={styles.cellMain}>{f.label}</td>
                  <td className={styles.num}>{formatNum(f.rpm)} rpm</td>
                  <td className={cx(styles.kind, styles.dropS)}>{f.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {gpus.length ? (
        <Card title="Graphics">
          <table className={styles.table}>
            <tbody>
              {gpus.map((g) => (
                <tr key={g.index}>
                  <td className={styles.cellMain}>{g.name}</td>
                  <td className={styles.num}>{formatPct(g.utilPct)} busy</td>
                  <td className={cx(styles.num, styles.dropXs)}>{formatTemp(g.tempC)}</td>
                  <td className={cx(styles.num, styles.dropS)}>
                    {g.powerW != null ? `${formatNum(g.powerW)} W` : DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {ups.length ? (
        <Card title="Power supply">
          <table className={styles.table}>
            <tbody>
              {ups.map((u) => (
                <tr key={u.name}>
                  <td className={styles.cellMain}>{u.model ?? u.name}</td>
                  <td className={styles.dropXs}>{u.status}</td>
                  <td className={styles.num}>{formatPct(u.chargePct)} charged</td>
                  <td className={cx(styles.num, styles.dropS)}>{formatPct(u.loadPct)} load</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}
