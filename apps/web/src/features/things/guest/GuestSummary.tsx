/**
 * A guest's Summary (ported from Rackoon's `features/guest/SummaryTab.tsx` and `guests/GuestHistory.tsx`; PX-01,
 * PX-07): why the settings tabs are missing when Manage is off (with a link to the Agent card), this guest's
 * Proxmox hints with their way out, its four figures, its history (CPU, memory, network, disk I/O) over a range, the
 * facts people look for (disks, addresses, last backup and the job that covers it, snapshots and the oldest, a lock,
 * changes waiting for a restart, HA, the guest agent) and its notes with Edit.
 */
import {
  BACKUP_OLD_DAYS,
  backupJobIncludes,
  backupJobName,
  DASH,
  formatBytesBinary,
  formatDiskRate,
  formatDuration,
  formatMemPair,
  formatNetRate,
  formatNum,
  formatPct,
  formatPct1,
  formatRelativeDay,
  formatTooltipTime,
  type GuestHintView,
  guestHints,
  HOST_RANGE_WORDS,
  isOn,
  keyOrder,
  manageablePlatform,
  niceCeiling,
  niceRate,
  pendingKeys,
  timeTicks,
} from '@whombat/client/hosts';
import { useHostGuestMetrics } from '@whombat/client/hosts/react';
import type { HostGuestDetail, HostSeriesRange, HostServerDetail } from '@whombat/core/domain';
import { AlertTriangle, Info } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '../../../components/Button';
import { TimeChart, type TimeSeries } from '../../../components/charts';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useBackupJobs } from '../manage/BackupJobs';
import { Card, Dot, Empty } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import type { EditCtx } from './EditDialog';
import { TextKeyDialog } from './OptionsTab';

const RANGES: { value: HostSeriesRange; label: string }[] = [
  { value: '1h', label: '1 h' },
  { value: '6h', label: '6 h' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const SERIES = 'cpu_pct,mem_mb,net_rx_mbps,net_tx_mbps,disk_read_mbs,disk_write_mbs';

export function GuestSummary({
  burrow,
  serverId,
  guest: g,
  detail,
  ctx,
  timeZone,
  onFix,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  detail: HostServerDetail;
  /** The configuration, when Manage is on (disks, lock, HA, notes). */
  ctx: EditCtx | null;
  timeZone?: string;
  /** A hint's way out (Back up now, Add to a backup job, Restart, Snapshots). */
  onFix: (fix: GuestHintView['fix']) => void;
}) {
  const [, set] = useThingSearch();
  const jobs = useBackupJobs(burrow, serverId, !!ctx && g.platform === 'pve').jobs;
  const [notes, setNotes] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const on = g.state === 'running' || g.state === 'unhealthy';
  const now = Date.parse(detail.asOf);
  const cfg = ctx?.config;

  // Changes waiting for a restart have their banner (with Restart now) whenever the configuration is read.
  const hints = guestHints(g, now).filter((h) => !(h.fix === 'restart' && ctx));
  const reason =
    manageablePlatform(g) && !g.manageable
      ? (g.remoteControl.manageReason ?? 'Changing guests is switched off for this server.')
      : null;

  // A way out only where it can be taken: backups and jobs need Manage, Restart and Snapshots need power.
  const hintAction = (h: GuestHintView): string | null => {
    switch (h.fix) {
      case 'backup_job':
        return ctx ? h.action : null;
      case 'backup_now':
        return ctx ? h.action : null;
      case 'restart':
      case 'snapshots':
        return g.remoteControl.power ? h.action : null;
      default:
        return h.action;
    }
  };
  const fix = (h: GuestHintView) => {
    if (h.fix === 'agent') {
      setFlash('agent');
      scrollToId('wb-fact-agent');
      return;
    }
    onFix(h.fix);
  };

  return (
    <>
      {reason ? (
        <p className={wb.wbNote}>
          <Icon icon={Info} size={16} />
          <span>
            Settings, backups and tasks aren’t here: {reason.replace(/\.$/, '')}.{' '}
            <button
              type="button"
              className={styles.cardLink}
              onClick={() => set({ guest: undefined, gtab: undefined, tab: 'system' })}
            >
              Agent settings
            </button>
          </span>
        </p>
      ) : null}
      {hints.map((h) => (
        <HintLine key={h.kind} hint={h} action={hintAction(h)} onFix={() => fix(h)} />
      ))}
      <Figures guest={g} on={on} />
      <History burrow={burrow} serverId={serverId} guest={g} timeZone={timeZone} />
      <div className={wb.wbSplit}>
        <Details
          guest={g}
          ctx={ctx}
          now={now}
          timeZone={timeZone}
          flash={flash}
          jobNames={
            jobs
              ? jobs
                  .filter((j) => j.enabled && backupJobIncludes(j, g.id, g.node))
                  .map((j) => backupJobName(j))
              : null
          }
          onAddToJob={ctx ? () => onFix('backup_job') : undefined}
          onPending={() => {
            scrollToId('wb-pending');
            document.getElementById('wb-pending')?.focus({ preventScroll: true });
          }}
        />
        {cfg && (g.platform === 'pve' || g.platform === 'incus') ? (
          <Card
            title="Notes"
            link={
              // The guest this Whombat runs in isn't changed from here (IU-02).
              g.self ? undefined : (
                <button
                  type="button"
                  className={styles.cardLink}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setNotes(true)}
                >
                  {cfg.values.description ? 'Edit' : 'Add'}
                  <span className={styles.srOnly}> notes</span>
                </button>
              )
            }
          >
            {cfg.values.description ? (
              <p className={wb.wbNotes}>{cfg.values.description}</p>
            ) : (
              <Empty>
                {g.platform === 'incus'
                  ? 'No notes yet. Incus shows them as its description.'
                  : 'No notes yet. Proxmox shows them on its summary too.'}
              </Empty>
            )}
          </Card>
        ) : null}
      </div>
      {notes && ctx ? (
        <TextKeyDialog
          ctx={ctx}
          k="description"
          label="Notes"
          multiline
          hint={
            g.platform === 'incus'
              ? 'Plain text; Incus shows it as the instance’s description.'
              : 'Plain text; Proxmox shows it on the guest’s summary too.'
          }
          onClose={() => setNotes(false)}
        />
      ) : null}
    </>
  );
}

/** Brings an element of the page into view by scrolling the page's own column (not the window around the shell). */
export function scrollToId(id: string): void {
  const el = document.getElementById(id);
  let box = el?.parentElement ?? null;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!el || !box) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 24;
  box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/** A Proxmox hint with its way out (PX-07). */
export function HintLine({
  hint,
  action,
  onFix,
}: {
  hint: GuestHintView;
  action: string | null;
  onFix: () => void;
}) {
  return (
    <div className={cx(styles.notice, hint.tone === 'warn' ? styles.noticeWarn : null)}>
      <span
        className={cx(styles.noticeIcon, hint.tone === 'warn' ? styles.noticeIconWarn : styles.noticeIconMut)}
        aria-hidden="true"
      >
        <Icon icon={hint.tone === 'warn' ? AlertTriangle : Info} size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{hint.title}</b>
        <p>{hint.detail}</p>
      </div>
      {action ? (
        <Button size="sm" onClick={onFix} style={{ alignSelf: 'center' }}>
          {action}
        </Button>
      ) : null}
    </div>
  );
}

export function Figures({ guest: g, on }: { guest: HostGuestDetail; on: boolean }) {
  return (
    <section className={styles.card} aria-label="At a glance">
      <div className={cx(styles.kpis, styles.kpis4)}>
        <div className={styles.kpi}>
          <span>CPU</span>
          <b>{on ? formatPct1(g.cpuPct) : DASH}</b>
          <span>{g.vcpu ? `${g.vcpu} cores` : DASH}</span>
        </div>
        <div className={styles.kpi}>
          <span>Memory</span>
          <b>{on ? formatMemPair(g.memoryUsedMb, g.memoryLimitMb) : DASH}</b>
          <span>
            {on && g.memoryUsedMb != null && g.memoryLimitMb
              ? `${formatPct((g.memoryUsedMb / g.memoryLimitMb) * 100)} used`
              : DASH}
          </span>
        </div>
        <div className={styles.kpi}>
          <span>Network</span>
          <b>{on ? formatNetRate((g.netRxMbps ?? 0) + (g.netTxMbps ?? 0)) : DASH}</b>
          <span>{on ? `disks ${formatDiskRate((g.diskReadMbs ?? 0) + (g.diskWriteMbs ?? 0))}` : DASH}</span>
        </div>
        <div className={styles.kpi}>
          <span>Up</span>
          <b>{on && g.uptimeS != null ? formatDuration(g.uptimeS) : DASH}</b>
          <span>{on ? 'since its last start' : (g.lastExit ?? 'switched off')}</span>
        </div>
      </div>
    </section>
  );
}

function peak(...lists: (readonly (number | null)[] | undefined)[]): number {
  let m = 0;
  for (const l of lists) for (const v of l ?? []) if (v != null && v > m) m = v;
  return m;
}

/** CPU, memory, network and disk I/O over a range (Rackoon's `GuestHistoryCharts`). */
export function History({
  burrow,
  serverId,
  guest: g,
  timeZone,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  timeZone?: string;
}) {
  const [range, setRange] = useState<HostSeriesRange>('24h');
  const m = useHostGuestMetrics({
    params: { burrow, serverId, guestId: g.id },
    query: { range, series: SERIES },
  });
  const d = m.data;
  const s = d?.series ?? {};
  const empty = d && !Object.values(s).some((l) => l.some((v) => v != null));
  // The unit sits in the chart's label, so the axis keeps short numbers.
  const chart = (
    title: string,
    unit: string,
    series: TimeSeries[],
    max: number,
    format: (v: number) => string,
  ) =>
    d ? (
      <div>
        <span className={wb.wbChartLabel}>
          {title} <span className={wb.wbChartUnit}>· {unit}</span>
        </span>
        <TimeChart
          label={`${g.name} ${title.toLowerCase()}, ${HOST_RANGE_WORDS[range].toLowerCase()}`}
          height={110}
          series={series}
          min={0}
          max={max}
          ticks={Number.isInteger(max / 2) || max < 10 ? [0, max / 2, max] : [0, max]}
          tickLabel={(v) => formatNum(v)}
          timeTicks={timeTicks(d.timestamps, d.range, timeZone)}
          pointLabel={(i) => formatTooltipTime(d.range, Date.parse(d.timestamps[i] ?? ''), timeZone)}
          formatValue={format}
        />
      </div>
    ) : (
      <div style={{ height: 130 }} aria-busy="true" />
    );
  const cpuMax = niceCeiling(peak(s.cpu_pct));
  const memGb = (s.mem_mb ?? []).map((v) => (v == null ? null : v / 1024));
  const memMax = niceRate(peak(memGb));
  const netMax = niceRate(peak(s.net_rx_mbps, s.net_tx_mbps));
  const ioMax = niceRate(peak(s.disk_read_mbs, s.disk_write_mbs));
  return (
    <Card
      title="History"
      meta={HOST_RANGE_WORDS[range]}
      link={
        <span style={{ marginLeft: 'auto', maxWidth: '100%' }}>
          <SegmentedControl
            options={RANGES}
            value={range}
            onChange={setRange}
            label="Range"
            size="sm"
            variant="soft"
            className={styles.segWrap}
          />
        </span>
      }
    >
      {m.error && !d ? (
        <Empty>The history can’t be read right now.</Empty>
      ) : empty ? (
        <Empty>No history in this range yet. Whombat keeps it once a minute while the guest runs.</Empty>
      ) : (
        <div className={wb.wbHistory} aria-busy={m.isFetching || undefined}>
          {chart(
            'CPU',
            '%',
            [{ key: 'cpu', label: 'CPU', color: 'var(--chart1)', values: s.cpu_pct ?? [], area: true }],
            cpuMax,
            formatPct1,
          )}
          {chart(
            'Memory',
            'GB',
            [{ key: 'mem', label: 'Memory', color: 'var(--chart3)', values: memGb, area: true }],
            memMax,
            (v) => `${formatNum(v)} GB`,
          )}
          {chart(
            'Network',
            'Mbit/s',
            [
              { key: 'rx', label: 'In', color: 'var(--chart1)', values: s.net_rx_mbps ?? [] },
              { key: 'tx', label: 'Out', color: 'var(--chart2)', values: s.net_tx_mbps ?? [] },
            ],
            netMax,
            formatNetRate,
          )}
          {chart(
            'Disk I/O',
            'MB/s',
            [
              { key: 'rd', label: 'Read', color: 'var(--chart3)', values: s.disk_read_mbs ?? [] },
              { key: 'wr', label: 'Write', color: 'var(--chart2)', values: s.disk_write_mbs ?? [] },
            ],
            ioMax,
            formatDiskRate,
          )}
        </div>
      )}
    </Card>
  );
}

/** “The oldest is 45 days old”, “The oldest is from today”. */
function oldestText(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  return days < 1 ? 'The oldest is from today' : `The oldest is ${days === 1 ? 'a day' : `${days} days`} old`;
}

interface Fact {
  id: string;
  k: string;
  v: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}

function Details({
  guest: g,
  ctx,
  now,
  timeZone,
  flash,
  jobNames,
  onAddToJob,
  onPending,
}: {
  guest: HostGuestDetail;
  ctx: EditCtx | null;
  now: number;
  timeZone?: string;
  flash: string | null;
  /** The enabled jobs that back it up (null: not read). */
  jobNames: string[] | null;
  onAddToJob?: () => void;
  onPending: () => void;
}) {
  const cfg = ctx?.config;
  const facts: Fact[] = [];
  if (g.image) facts.push({ id: 'image', k: g.platform === 'docker' ? 'Image' : 'System', v: g.image });
  facts.push({ id: 'addresses', k: 'Addresses', v: g.addresses?.join(', ') || DASH });
  const disks = (cfg?.disks ?? [])
    .filter((x) => x.media !== 'cdrom' && !x.unused)
    .sort((a, b) => keyOrder(a.key, b.key));
  if (disks.length)
    facts.push({
      id: 'disks',
      k: disks.length === 1 ? 'Disk' : 'Disks',
      v: disks.map((x) => `${x.key} ${x.sizeBytes ? formatBytesBinary(x.sizeBytes) : ''}`.trim()).join(' · '),
      sub: [...new Set(disks.map((x) => x.storage).filter(Boolean))].join(', ') || undefined,
    });
  facts.push({ id: 'node', k: 'Runs on', v: g.node ?? g.serverId });
  if (g.lastBackup) {
    const ok = g.lastBackup.result === 'ok';
    const old = Date.parse(g.lastBackup.at) < now - BACKUP_OLD_DAYS * 86_400_000;
    facts.push({
      id: 'backup',
      k: 'Last backup',
      v: `${formatRelativeDay(Date.parse(g.lastBackup.at), now, timeZone)} · ${ok ? 'went fine' : g.lastBackup.result}`,
      tone: ok ? (old ? 'warn' : 'ok') : 'bad',
    });
  } else if (g.platform === 'pve') facts.push({ id: 'backup', k: 'Last backup', v: 'None yet' });
  if (g.platform === 'pve' && (g.backupJob != null || jobNames))
    facts.push({
      id: 'job',
      k: 'Backup job',
      v:
        jobNames?.length || (!jobNames && g.backupJob)
          ? jobNames?.length
            ? `Covered by ${jobNames.map((n) => `“${n}”`).join(' and ')}`
            : 'Covered by a backup plan'
          : 'In no backup plan',
      tone: jobNames?.length || (!jobNames && g.backupJob) ? undefined : 'warn',
      sub:
        !(jobNames?.length || (!jobNames && g.backupJob)) && onAddToJob ? (
          <button
            type="button"
            className={styles.cardLink}
            style={{ marginLeft: 0, alignSelf: 'flex-start' }}
            onClick={onAddToJob}
          >
            Add to a backup job
          </button>
        ) : undefined,
    });
  if (g.snapshots != null)
    facts.push({
      id: 'snapshots',
      k: 'Snapshots',
      v: String(g.snapshots),
      sub: g.oldestSnapshot ? oldestText(Date.parse(g.oldestSnapshot), now) : undefined,
    });
  const lock = cfg?.lock ?? g.lock;
  if (lock)
    facts.push({
      id: 'lock',
      k: 'Lock',
      v: lock,
      sub: 'Proxmox locked it while a task runs.',
      tone: 'warn',
    });
  const pending = cfg ? pendingKeys(cfg).length : (g.pendingChanges ?? 0);
  if (pending > 0)
    facts.push({
      id: 'pending',
      k: 'Waiting for a restart',
      v: ctx ? (
        <button type="button" className={styles.cardLink} style={{ marginLeft: 0 }} onClick={onPending}>
          {pending === 1 ? '1 change' : `${pending} changes`}
        </button>
      ) : pending === 1 ? (
        '1 change'
      ) : (
        `${pending} changes`
      ),
      sub: 'They apply at the next restart.',
      tone: 'warn',
    });
  const ha = cfg?.ha?.state ?? g.haState;
  if (ha)
    facts.push({
      id: 'ha',
      k: 'High availability',
      v: ha.charAt(0).toUpperCase() + ha.slice(1),
      sub: cfg?.ha?.status ?? undefined,
    });
  if (g.kind === 'vm' && g.platform === 'pve') {
    const enabled = cfg ? isOn((cfg.values.agent ?? '').split(',')[0]?.replace(/^enabled=/, '')) : null;
    facts.push({
      id: 'agent',
      k: 'Guest agent',
      v:
        g.guestAgent === 'running'
          ? 'Running'
          : g.guestAgent === 'not_running'
            ? 'Not running'
            : enabled === false
              ? 'Off'
              : enabled
                ? 'On, not reporting'
                : 'Off',
      tone: g.guestAgent === 'running' ? 'ok' : g.guestAgent === 'not_running' ? 'warn' : undefined,
      sub:
        g.guestAgent === 'not_running'
          ? 'Install qemu-guest-agent inside the VM and start it (apt install qemu-guest-agent). Proxmox then sees its addresses and shuts it down cleanly.'
          : undefined,
    });
  }
  if (g.platform === 'docker' && g.restarts != null)
    facts.push({ id: 'restarts', k: 'Restarts', v: String(g.restarts) });
  return (
    <Card title="Details">
      <div className={styles.rows}>
        {facts.map((f) => (
          <div
            key={f.id}
            id={`wb-fact-${f.id}`}
            className={cx(styles.row, wb.wbFact, flash === f.id && wb.wbFactFlash)}
          >
            <span className={wb.wbFactKey}>{f.k}</span>
            <span className={wb.wbFactValue}>
              <span className={wb.wbFactLine}>
                {f.tone ? <Dot tone={f.tone} /> : null}
                {f.v}
              </span>
              {f.sub ? <small>{f.sub}</small> : null}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
