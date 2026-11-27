/**
 * A guest's history from its row's menu (ported from Rackoon's `GuestHistoryDialog`): its CPU and memory over the last
 * day or week, without leaving the list.
 */
import {
  formatNum,
  formatPct1,
  formatTooltipTime,
  hostRangeWords,
  mibText,
  niceCeiling,
  timeTicks,
} from '@whombat/client/hosts';
import { useHostGuestMetrics } from '@whombat/client/hosts/react';
import type { HostGuest } from '@whombat/core/domain';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { TimeChart } from '../../../components/charts';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { currentLocale } from '../../../i18n/provider';
import { useLocaleWords } from '../../../i18n/words';
import { Empty, ErrorLine } from '../parts';
import styles from '../Things.module.css';

type Range = '24h' | '7d';

export function GuestHistoryDialog({
  burrow,
  serverId,
  guest: g,
  onClose,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuest;
  onClose: () => void;
}) {
  const HOST_RANGE_WORDS = useLocaleWords(hostRangeWords);
  const [range, setRange] = useState<Range>('24h');
  const m = useHostGuestMetrics({
    params: { burrow, serverId, guestId: g.id },
    query: { range, series: 'cpu_pct,mem_mb' },
  });
  const d = m.data;
  const cpu = d?.series.cpu_pct ?? [];
  const mem = d?.series.mem_mb ?? [];
  const cpuMax = niceCeiling(Math.max(0, ...cpu.map((v) => v ?? 0)));
  const memMax = Math.max(g.memoryLimitMb ?? 0, ...mem.map((v) => v ?? 0), 1);
  const ticks = d ? timeTicks(d.timestamps, d.range) : [];
  const point = (i: number) =>
    formatTooltipTime(d?.range ?? range, Date.parse(d?.timestamps[i] ?? ''), undefined, currentLocale());
  const any = cpu.some((v) => v != null) || mem.some((v) => v != null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
      <ModalTitle className={styles.dialogTitle}>{g.name}’s history</ModalTitle>
      <ModalDescription className={styles.dialogBody}>
        CPU and memory, {HOST_RANGE_WORDS[range].toLowerCase()}.
      </ModalDescription>
      <SegmentedControl
        options={[
          { value: '24h', label: 'Day' },
          { value: '7d', label: 'Week' },
        ]}
        value={range}
        onChange={setRange}
        label="Range"
        variant="soft"
      />
      {m.error ? (
        <ErrorLine error={m.error} onRetry={() => void m.refetch()} />
      ) : !d ? (
        <div style={{ height: 300 }} aria-busy="true" />
      ) : !any ? (
        <Empty>Nothing recorded {HOST_RANGE_WORDS[range].toLowerCase()}: it was switched off.</Empty>
      ) : (
        <>
          <section aria-label="CPU">
            <h3 className={styles.lbl} style={{ margin: '0 0 6px' }}>
              CPU
            </h3>
            <TimeChart
              label={`${g.name} CPU, ${HOST_RANGE_WORDS[range].toLowerCase()}`}
              height={130}
              series={[{ key: 'cpu', label: 'CPU', color: 'var(--chart1)', values: cpu, area: true }]}
              min={0}
              max={cpuMax}
              ticks={[0, cpuMax / 2, cpuMax]}
              tickLabel={(v) => `${formatNum(v)}%`}
              timeTicks={ticks}
              pointLabel={point}
              formatValue={formatPct1}
            />
          </section>
          <section aria-label="Memory">
            <h3 className={styles.lbl} style={{ margin: '0 0 6px' }}>
              Memory
            </h3>
            <TimeChart
              label={`${g.name} memory, ${HOST_RANGE_WORDS[range].toLowerCase()}`}
              height={130}
              series={[{ key: 'mem', label: 'Memory', color: 'var(--chart2)', values: mem, area: true }]}
              min={0}
              max={memMax}
              ticks={[0, Math.round(memMax / 2), memMax]}
              tickLabel={(v) => mibText(Math.round(v))}
              timeTicks={ticks}
              pointLabel={point}
              formatValue={(v) => mibText(Math.round(v))}
            />
          </section>
        </>
      )}
      <div className={styles.dialogActions}>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
