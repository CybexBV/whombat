// History of one guest: CPU, memory, network and disk I/O over a range, from
// the samples the hub keeps once a minute while the guest runs. Opened from
// the guest's ⋯ menu (every role); the guest page's Summary shows the same
// charts inline.

import { useState } from 'react';
import { useGuestMetrics } from '../../api/queries';
import type { Guest, Range } from '../../api/types';
import { ErrorCard } from '../../components/common';
import { InlineRetry } from '../../components/InlineRetry';
import { SegmentedControl } from '../../components/controls';
import { Modal } from '../../components/Modal';
import { type ChartSeries, TimeChart } from '../../components/TimeChart';
import { formatDiskRate, formatNetRate, formatPct1 } from '../../lib/format';
import { t } from '../../lib/i18n';
import { niceCeiling, niceRate } from '../server/SummaryTab';

const RANGES: Range[] = ['1h', '6h', '24h', '7d', '30d'];

function peak(...lists: ((number | null)[] | undefined)[]): number {
  let m = 0;
  for (const l of lists) for (const v of l ?? []) if (v != null && v > m) m = v;
  return m;
}

function memText(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

interface ChartProps {
  title: string;
  series: ChartSeries[];
  timestamps: string[];
  range: Range;
  max: number;
  labels: (v: number) => string;
  format: (v: number) => string;
  hover: number | null;
  onHover: (i: number | null) => void;
}

function Chart(p: ChartProps) {
  return (
    <div className="gh-chart">
      <div className="lbl">{p.title}</div>
      <TimeChart
        title={p.title}
        range={p.range}
        timestamps={p.timestamps}
        series={p.series}
        yMin={0}
        yMax={p.max}
        yLabels={[1, 0.5, 0].map((f) => p.labels(p.max * f))}
        height={90}
        area={p.series.length === 1}
        hover={p.hover}
        onHover={p.onHover}
        formatValue={p.format}
        tooltip="hover"
      />
    </div>
  );
}

/** The charts of one guest over a range (the history dialog and the guest page's Summary). */
export function GuestHistoryCharts({ serverId, guest, range, inCard }: { serverId: string; guest: Pick<Guest, 'id'>; range: Range; inCard?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const m = useGuestMetrics(serverId, guest.id, range);
  const s = m.data?.series ?? {};
  const ts = m.data?.timestamps ?? [];
  const empty = m.data && !Object.values(s).some((l) => l.some((v) => v != null));
  const common = { timestamps: ts, range, hover, onHover: setHover };
  const cpuMax = niceCeiling(peak(s.cpu_pct));
  const memMax = Math.max(64, peak(s.mem_mb) * 1.15);
  const netMax = niceRate(peak(s.net_rx_mbps, s.net_tx_mbps));
  const ioMax = niceRate(peak(s.disk_read_mbs, s.disk_write_mbs));
  const hasNet = !!(s.net_rx_mbps || s.net_tx_mbps);
  const hasIO = !!(s.disk_read_mbs || s.disk_write_mbs);
  if (m.isError && !m.data) {
    return inCard ? (
      <InlineRetry title={t('Could not load the history')} error={m.error} onRetry={() => void m.refetch()} />
    ) : (
      <ErrorCard title={t('Could not load the history')} error={m.error} onRetry={() => void m.refetch()} />
    );
  }
  if (empty) return <p className="ink-2">{t('No history in this range yet. The hub records it once a minute while the guest runs.')}</p>;
  return (
    <div className="gh-grid" aria-busy={m.isPending}>
      <Chart
        {...common}
        title={t('CPU')}
        series={[{ key: 'cpu', label: t('CPU'), short: t('CPU'), color: 'var(--series-cpu)', values: s.cpu_pct ?? [] }]}
        max={cpuMax}
        labels={(v) => `${Math.round(v)}%`}
        format={formatPct1}
      />
      <Chart
        {...common}
        title={t('Memory')}
        series={[{ key: 'mem', label: t('Memory'), short: t('Memory'), color: 'var(--series-memory)', values: s.mem_mb ?? [] }]}
        max={memMax}
        labels={memText}
        format={memText}
      />
      {hasNet && (
        <Chart
          {...common}
          title={t('Network')}
          series={[
            { key: 'rx', label: t('Received'), short: t('In'), color: 'var(--series-yellow)', values: s.net_rx_mbps ?? [] },
            { key: 'tx', label: t('Sent'), short: t('Out'), color: 'var(--series-aqua)', values: s.net_tx_mbps ?? [] },
          ]}
          max={netMax}
          labels={(v) => formatNetRate(v)}
          format={formatNetRate}
        />
      )}
      {hasIO && (
        <Chart
          {...common}
          title={t('Disk I/O')}
          series={[
            { key: 'rd', label: t('Read'), short: t('Read'), color: 'var(--series-aqua)', values: s.disk_read_mbs ?? [] },
            { key: 'wr', label: t('Write'), short: t('Write'), color: 'var(--series-orange)', values: s.disk_write_mbs ?? [] },
          ]}
          max={ioMax}
          labels={(v) => formatDiskRate(v)}
          format={formatDiskRate}
        />
      )}
    </div>
  );
}

export function GuestHistoryDialog({ serverId, guest, onClose }: { serverId: string; guest: Pick<Guest, 'id' | 'name' | 'kind'>; onClose: () => void }) {
  const [range, setRange] = useState<Range>('24h');
  return (
    <Modal open onClose={onClose} title={t('{name}: history', { name: guest.name })} description={t('Recorded once a minute while the guest runs.')} wide>
      <div className="gh-head">
        <GuestHistoryRange value={range} onChange={setRange} />
      </div>
      <GuestHistoryCharts serverId={serverId} guest={guest} range={range} />
    </Modal>
  );
}

/** The ranges the hub keeps guest history for. */
export function GuestHistoryRange({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return <SegmentedControl label={t('Time range')} value={value} onChange={onChange} options={RANGES.map((r) => ({ value: r, label: r }))} />;
}
