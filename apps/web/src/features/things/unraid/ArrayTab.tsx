/**
 * An Unraid server's Array (Whombat incus-unraid.md IU-05; AP-1590): the array card (its state and use, Start or Stop,
 * parity with its progress and Check, Pause, Resume, Stop, the mover, Spin up all and Spin down all), then the tables
 * Unraid's own Main page has — Array devices (parity and data), each pool, the boot device — with each disk's status,
 * identification, temperature, errors, file system, size, used, free and spin, and the parity checks so far with the
 * schedule. Hints and alerts about the disks come first with their way out.
 */
import {
  arrayGroups,
  DASH,
  detailGuests,
  diskUsedLevel,
  formatDuration,
  type HostTone,
  hostTone,
  parityRunWhen,
  parityRunWords,
  parityView,
  poolWords,
  serverNoticeOptions,
  serverWatch,
  type UnraidDiskRow,
  unraidAbilities,
  unraidArrayView,
  unraidDetail,
  unraidDiskRow,
  unraidSize,
} from '@whombat/client/hosts';
import type { HostServerDetail, HostUnraidDetail, HostUnraidDisk } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { useWebI18n } from '../../../i18n/provider';
import { Card, Dot, Empty, StateCell } from '../parts';
import { useServerEndQuiet } from '../quiet/KeepQuiet';
import { useServerQuiet } from '../quiet/useQuiet';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { WatchNotices } from '../tabs/WatchNotices';
import wu from './Unraid.module.css';
import { type UnraidDialog, UnraidDialogs } from './UnraidDialogs';
import { UnraidHints } from './UnraidHints';
import { type UnraidAccess, useUnraidAccess, useUnraidChange } from './useUnraid';

export interface UnraidTabProps {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone?: string;
}

export function ArrayTab({ burrow, serverId, detail, timeZone }: UnraidTabProps) {
  const u = unraidDetail(detail);
  const access = useUnraidAccess(burrow, detail);
  const [dialog, setDialog] = useState<UnraidDialog | null>(null);
  // Its alerts with the ⋯ menu, quiet ones greyed (quiet-notices.md AP-4828).
  const sq = useServerQuiet(burrow, serverId);
  // A line held because the server is kept quiet ends with it: End now, as under the page's head.
  const end = useServerEndQuiet(burrow, serverId, detail.server.name ?? serverId);
  const alerts = serverWatch(
    (detail.alerts ?? []).filter((a) => a.section === 'array' || a.section === 'storage'),
    [],
    serverId,
    serverNoticeOptions(detail, detailGuests(detail), {
      quiet: sq.mayQuiet,
      ...(timeZone ? { timeZone } : {}),
    }),
  );
  if (!u) return <Empty>No word from {serverId} about its disks yet.</Empty>;
  const { parity, data } = arrayGroups(u.array);
  const started = u.array.state === 'started';
  return (
    <>
      <WatchNotices burrow={burrow} rows={alerts} quiet={sq.actions} onEnd={end.onEnd} ending={end.ending} />
      <UnraidHints burrow={burrow} detail={detail} section="array" onDialog={setDialog} />
      <ArrayCard burrow={burrow} detail={detail} u={u} access={access} full onDialog={setDialog} />
      <DiskCard
        id="wu-array"
        title="Array devices"
        meta={`${data.length === 1 ? '1 data disk' : `${data.length} data disks`} · ${parity.filter((d) => d.status === 'ok').length || 'no'} parity`}
        disks={[...parity, ...data]}
        burrow={burrow}
        serverId={serverId}
        access={access}
        started={started}
      />
      {u.pools.map((p) => (
        <DiskCard
          key={p.name}
          id={`wu-pool-${p.name}`}
          title={`Pool ${p.name}`}
          meta={poolWords(p)}
          use={{ used: p.usedBytes, free: p.freeBytes }}
          disks={p.disks}
          burrow={burrow}
          serverId={serverId}
          access={access}
          started={started}
        />
      ))}
      {u.flash ? (
        <DiskCard
          id="wu-flash"
          title="Boot device"
          meta="The USB flash drive Unraid starts from"
          disks={[u.flash]}
          burrow={burrow}
          serverId={serverId}
          access={access}
          started={started}
        />
      ) : null}
      <ParityHistory u={u} now={Date.parse(detail.asOf)} timeZone={timeZone} />
      <UnraidDialogs burrow={burrow} detail={detail} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

/** The bar under a use line, coloured as Whombat's storage levels. */
export function UseBar({ pct }: { pct: number | null }) {
  const tone = hostTone(diskUsedLevel(pct));
  return (
    <div
      className={cx(styles.bar, tone === 'warn' && styles.barWarn, tone === 'bad' && styles.barBad)}
      aria-hidden="true"
    >
      <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
    </div>
  );
}

/** Used of used + free (btrfs reports a pool's raw size, larger than what fits). */
export function fullPct(used: number | null, free: number | null): number | null {
  return used == null || free == null || used + free <= 0 ? null : (used / (used + free)) * 100;
}

/** Without the switch, one line where the buttons would be, and the way to the switch. */
export function AccessNote({ access }: { access: UnraidAccess }) {
  const [, set] = useThingSearch();
  if (!access.reason) return null;
  return (
    <p className={styles.cardNote}>
      {access.reason}
      {access.switchOff ? (
        <>
          {' '}
          <button
            type="button"
            className={cx(styles.cardLink, wu.wuInline)}
            onClick={() => set({ tab: 'system' }, { replace: true })}
          >
            Agent settings
          </button>
        </>
      ) : null}
    </p>
  );
}

/**
 * The array: state and use with Start or Stop, parity with what may be done to it, and on the Array tab (`full`) the
 * mover and the spin buttons; on the Summary a line about the disks with Open Array.
 */
export function ArrayCard({
  burrow,
  detail,
  u,
  access,
  full,
  onDialog,
}: {
  burrow: string;
  detail: HostServerDetail;
  u: HostUnraidDetail;
  access: UnraidAccess;
  full?: boolean;
  onDialog: (d: UnraidDialog) => void;
}) {
  const [, set] = useThingSearch();
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const now = Date.parse(detail.asOf);
  const a = unraidArrayView(u.array);
  const p = parityView(u.array, now);
  const can = unraidAbilities(u);
  const act = access.can;
  const quick = (op: Parameters<typeof run>[0], params?: Record<string, unknown>) =>
    void run(op, { ...(params ? { params } : {}), inline: false });
  const disks = u.array.disks.filter((d) => d.slot === 'data' && d.device).length;
  const poolDisks = u.pools.reduce((n, x) => n + x.disks.length, 0);
  return (
    <Card
      id={full ? undefined : 'wu-array-card'}
      title="Array"
      meta={u.array.startOnBoot ? 'Starts when the server boots' : 'Started by hand after a restart'}
      link={
        act && full && can.spin ? (
          <span className={wu.wuHeadActs}>
            <Button size="sm" disabled={busy} onClick={() => quick('disk.spin_up', { disk: 'all' })}>
              Spin up all
            </Button>
            <Button size="sm" disabled={busy} onClick={() => quick('disk.spin_down', { disk: 'all' })}>
              Spin down all
            </Button>
          </span>
        ) : undefined
      }
    >
      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <b>
              <StateCell tone={a.tone} text={a.stateText} />
            </b>
            <small>{a.useText}</small>
            {a.usedPct != null ? (
              <div className={wu.wuBar}>
                <UseBar pct={fullPct(u.array.usedBytes, u.array.freeBytes)} />
              </div>
            ) : null}
          </div>
          {act ? (
            <span className={wu.wuEnd}>
              {can.start ? (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => quick('array.start')}>
                  Start the array
                </Button>
              ) : can.stop ? (
                <Button size="sm" disabled={busy} onClick={() => onDialog({ kind: 'stop' })}>
                  Stop the array…
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <b>
              <StateCell tone={p.tone} text={p.title} />
            </b>
            <small>{p.detail}</small>
            {p.running || p.paused ? (
              <div
                className={wu.wuProgress}
                role="progressbar"
                aria-label="Parity check"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(p.pct ?? 0)}
              >
                <i className={p.paused ? wu.wuPaused : undefined} style={{ width: `${p.pct ?? 0}%` }} />
              </div>
            ) : null}
          </div>
          {act ? (
            <span className={wu.wuEnd}>
              {can.pause ? (
                <Button size="sm" disabled={busy} onClick={() => quick('parity.pause')}>
                  Pause
                </Button>
              ) : null}
              {can.resume ? (
                <Button size="sm" disabled={busy} onClick={() => quick('parity.resume')}>
                  Resume
                </Button>
              ) : null}
              {can.cancel ? (
                <Button size="sm" disabled={busy} onClick={() => onDialog({ kind: 'cancel' })}>
                  Stop the check…
                </Button>
              ) : null}
              {can.checkParity ? (
                <Button size="sm" disabled={busy} onClick={() => onDialog({ kind: 'parity' })}>
                  Check parity…
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
        {full ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>Mover</b>
              <small>
                {u.array.moverRunning
                  ? 'Moving files between the pools and the array now.'
                  : (can.moverReason ?? 'Moves files between the pools and the array, as the shares say.')}
              </small>
            </div>
            {act && can.mover && !can.moverReason ? (
              <span className={wu.wuEnd}>
                <Button size="sm" disabled={busy} onClick={() => quick('mover.start')}>
                  Run the mover
                </Button>
              </span>
            ) : null}
          </div>
        ) : (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>Disks</b>
              <small>
                {[
                  disks === 1 ? '1 data disk' : `${disks} data disks`,
                  a.trouble,
                  u.pools.length
                    ? `${u.pools.length === 1 ? '1 pool' : `${u.pools.length} pools`} with ${poolDisks} disks`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </div>
            <span className={wu.wuEnd}>
              <button
                type="button"
                className={styles.cardLink}
                onClick={() => set({ tab: 'array' }, { replace: true })}
              >
                Open Array
              </button>
            </span>
          </div>
        )}
      </div>
      <AccessNote access={access} />
    </Card>
  );
}

/** One of Unraid's device tables. */
function DiskCard({
  id,
  title,
  meta,
  use,
  disks,
  burrow,
  serverId,
  access,
  started,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  use?: { used: number; free: number };
  disks: HostUnraidDisk[];
  burrow: string;
  serverId: string;
  access: UnraidAccess;
  started: boolean;
}) {
  const { run, busy } = useUnraidChange(burrow, serverId);
  const rows = disks.map(unraidDiskRow);
  const spinnable = rows.some((r) => r.canSpin);
  const spin = (r: UnraidDiskRow) =>
    void run(r.spunDown ? 'disk.spin_up' : 'disk.spin_down', {
      params: { disk: r.name },
      target: r.label,
      inline: false,
    });
  return (
    <Card
      id={id}
      title={title}
      meta={
        use ? (
          <>
            {meta} · {unraidSize(use.used)} used · {unraidSize(use.free)} free
          </>
        ) : (
          meta
        )
      }
    >
      {use ? (
        <div className={wu.wuCardBar}>
          <UseBar pct={fullPct(use.used, use.free)} />
        </div>
      ) : null}
      <table className={cx(styles.table, wu.wuDisks)}>
        <colgroup>
          <col className={wu.wuColDevice} />
          <col className={wu.wuColModel} />
          <col className={wu.wuColTemp} />
          <col className={wu.wuColErrors} />
          <col className={wu.wuColFs} />
          <col className={wu.wuColSize} />
          <col className={wu.wuColSize} />
          <col className={wu.wuColSize} />
          <col className={wu.wuColSpin} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col">Identification</th>
            <th scope="col">Temp</th>
            <th scope="col">Errors</th>
            <th scope="col">File system</th>
            <th scope="col" className={wu.wuRight}>
              Size
            </th>
            <th scope="col" className={wu.wuRight}>
              Used
            </th>
            <th scope="col" className={wu.wuRight}>
              Free
            </th>
            <th scope="col">{spinnable || rows.some((r) => r.spin) ? 'Spin' : ''}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={r.status.tone === 'mut' ? wu.wuEmpty : undefined}>
              <td>
                <span className={wu.wuDevice}>
                  <Dot tone={r.status.tone} label={r.status.text} />
                  <b>{r.label}</b>
                  {r.device ? <span className={styles.kind}>{r.device}</span> : null}
                </span>
                {r.status.tone === 'bad' || r.status.tone === 'warn' ? (
                  <span className={cx(wu.wuStatus, toneText(r.status.tone))}>{r.status.text}</span>
                ) : null}
              </td>
              <td className={wu.wuModel}>{r.model || DASH}</td>
              <td className={cx(styles.num, toneText(r.tempTone))}>{r.tempText}</td>
              <td className={cx(styles.num, r.errors ? wu.wuBadText : undefined)}>
                {r.device ? r.errors : DASH}
              </td>
              <td className={wu.wuFs}>{r.fsText}</td>
              <td className={cx(styles.num, wu.wuRight)}>{r.sizeText}</td>
              <td className={cx(styles.num, wu.wuRight)}>{r.usedText}</td>
              <td className={cx(styles.num, wu.wuRight)}>{r.freeText}</td>
              <td>
                <span className={wu.wuSpin}>
                  <span className={styles.muted}>{r.spin}</span>
                  {r.canSpin && access.can && started ? (
                    <button
                      type="button"
                      className={cx(styles.cardLink, wu.wuInline)}
                      disabled={busy}
                      onClick={() => spin(r)}
                      aria-label={`${r.spunDown ? 'Spin up' : 'Spin down'} ${r.label}`}
                    >
                      {r.spunDown ? 'Spin up' : 'Spin down'}
                    </button>
                  ) : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function toneText(tone: HostTone | null): string | undefined {
  return tone === 'bad' ? wu.wuBadText : tone === 'warn' ? wu.wuWarnText : undefined;
}

/** The parity checks so far (newest first) and when the next one runs. */
function ParityHistory({ u, now, timeZone }: { u: HostUnraidDetail; now: number; timeZone?: string }) {
  const { tag: uiLocale } = useWebI18n();
  const p = u.array.parity;
  return (
    <Card
      id="wu-parity"
      title="Parity checks"
      meta={p.schedule ?? 'No schedule: set one in Unraid under Settings → Scheduler.'}
    >
      {p.history.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col" className={styles.cellMain}>
                What
              </th>
              <th scope="col" className={styles.dropS}>
                Took
              </th>
              <th scope="col" className={styles.dropM}>
                Speed
              </th>
              <th scope="col">
                <span className={styles.narrowSr}>Result</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {p.history.map((r) => {
              const w = parityRunWords(r);
              return (
                <tr key={r.at}>
                  <td className={styles.num}>{parityRunWhen(r.at, now, timeZone)}</td>
                  <td className={styles.cellMain}>{w.action}</td>
                  <td className={cx(styles.num, styles.dropS)}>
                    {r.durationS != null ? formatDuration(r.durationS, uiLocale) : DASH}
                  </td>
                  <td className={cx(styles.num, styles.dropM)}>
                    {r.speedMbs != null ? `${Math.round(r.speedMbs)} MB/s` : DASH}
                  </td>
                  <td>
                    <StateCell tone={w.tone} text={w.result} compact />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty>No parity check has run on this server yet.</Empty>
      )}
    </Card>
  );
}
