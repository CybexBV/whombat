/**
 * An Incus instance's own tabs besides Configuration and Devices (Whombat incus-unraid.md IU-04; AP-1566…AP-1568): the
 * snapshot schedule above the snapshots (with the hint's way out, “Set a schedule”), its backups (Back up now, restore
 * as a new instance, delete; each expires as Incus was told) and its log (`lxc.log` or `qemu.log`, the last lines,
 * refreshed on demand).
 */
import {
  backupExpiresAt,
  DASH,
  expiryText,
  expiryWords,
  formatBytesBinary,
  formatRelativeDay,
  hasSnapshotSchedule,
  isSelfGuest,
  plural,
  scheduleWords,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import { HOST_LOG_LINES_DEFAULT, type HostBackupVolume, type HostGuestDetail } from '@whombat/core/domain';
import { CalendarClock, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { currentLocale } from '../../../i18n/provider';
import type { EditCtx } from '../guest/EditDialog';
import { Row } from '../guest/editParts';
import { Card, Empty, ErrorLine } from '../parts';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { ScheduleDialog } from './IncusConfigTab';
import {
  IncusBackupDialog,
  IncusDeleteBackupDialog,
  IncusRestoreDialog,
  type IncusStarted,
} from './IncusDialogs';

/* Snapshot schedule -------------------------------------------------------------------------------------- */

export function IncusScheduleCard({ ctx, guest }: { ctx: EditCtx | null; guest: HostGuestDetail }) {
  const [open, setOpen] = useState(false);
  if (!ctx) return null;
  const v = ctx.config.values;
  const self = isSelfGuest(guest);
  const on = hasSnapshotSchedule(v);
  return (
    <Card
      title="Schedule"
      meta={on ? 'Incus takes them on its own' : undefined}
      link={
        self ? undefined : (
          <Button
            size="sm"
            variant={on ? 'secondary' : 'primary'}
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={CalendarClock} size={14} />}
            onClick={() => setOpen(true)}
          >
            {on ? 'Change' : 'Set a schedule'}
          </Button>
        )
      }
    >
      {on ? (
        <div className={styles.rows}>
          <Row title="Takes one" value={scheduleWords(v['snapshots.schedule'])} />
          <Row
            title="Keeps each"
            value={v['snapshots.expiry'] ? expiryWords(v['snapshots.expiry']) : 'Until removed'}
            muted={!v['snapshots.expiry']}
          />
          <Row
            title="Names"
            value={v['snapshots.pattern'] || 'snap0, snap1, …'}
            mono={!!v['snapshots.pattern']}
            muted={!v['snapshots.pattern']}
          />
        </div>
      ) : (
        <p className={styles.cardNote} style={{ marginTop: 0 }}>
          No snapshots on a schedule: {guest.name} only has the ones someone takes.
          {v['snapshots.expiry'] ? ` Each is kept ${expiryWords(v['snapshots.expiry'])}.` : ''}
        </p>
      )}
      {open ? <ScheduleDialog ctx={ctx} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

/* Backups ---------------------------------------------------------------------------------------------- */

export function IncusGuestBackups({
  burrow,
  serverId,
  guest,
  timeZone,
  onStarted,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  timeZone?: string;
  onStarted?: IncusStarted;
}) {
  const list = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'backup.list', guestId: guest.id, platform: 'incus' },
  });
  const [backingUp, setBackingUp] = useState(false);
  const items =
    list.data?.op === 'backup.list'
      ? [...list.data.items].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      : [];
  const newest = items[0]?.created;
  return (
    <Card
      title="Backups"
      meta={
        newest
          ? `${plural(items.length, 'backup')}, newest ${formatRelativeDay(Date.parse(newest), Date.now(), timeZone, currentLocale())}`
          : undefined
      }
      link={
        <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setBackingUp(true)}>
          Back up now
        </Button>
      }
    >
      {list.error ? (
        <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length ? (
        <IncusBackupTable
          burrow={burrow}
          serverId={serverId}
          items={items}
          guestOf={() => guest}
          timeZone={timeZone}
          onStarted={onStarted}
        />
      ) : (
        <Empty>{list.isLoading ? 'Looking…' : `No backups of ${guest.name} yet.`}</Empty>
      )}
      {backingUp ? (
        <IncusBackupDialog
          burrow={burrow}
          serverId={serverId}
          guest={guest}
          onClose={() => setBackingUp(false)}
        />
      ) : null}
    </Card>
  );
}

/** Incus backups as a table (an instance's, or a server's with the instance first): Restore as new and Delete. */
export function IncusBackupTable({
  burrow,
  serverId,
  items,
  guestOf,
  showGuest,
  timeZone,
  onStarted,
}: {
  burrow: string;
  serverId: string;
  items: readonly HostBackupVolume[];
  guestOf: (
    b: HostBackupVolume,
  ) => HostGuestDetail | Pick<HostGuestDetail, 'id' | 'name' | 'kind' | 'state' | 'self'> | undefined;
  showGuest?: boolean;
  timeZone?: string;
  onStarted?: IncusStarted;
}) {
  const [open, setOpen] = useState<{ b: HostBackupVolume; action: 'restore' | 'delete' } | null>(null);
  const now = Date.now();
  const g = open ? guestOf(open.b) : undefined;
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            {showGuest ? (
              <th scope="col" className={styles.cellMain}>
                Instance
              </th>
            ) : null}
            <th scope="col" className={showGuest ? styles.dropS : styles.cellMain}>
              Backup
            </th>
            <th scope="col" className={styles.dropXs}>
              Made
            </th>
            <th scope="col" className={styles.dropL}>
              Kept
            </th>
            <th scope="col" className={styles.dropXl}>
              Size
            </th>
            <th scope="col">
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const who = guestOf(b);
            return (
              <tr key={`${b.guest}/${b.volume}`}>
                {showGuest ? (
                  <td className={styles.cellMain}>
                    <span className={styles.mono}>{who?.name ?? b.guest ?? DASH}</span>
                  </td>
                ) : null}
                <td className={showGuest ? styles.dropS : styles.cellMain}>
                  <span className={styles.mono}>{b.volume}</span>
                  {b.format ? (
                    <span className={wi.wiSub}>
                      {b.format === 'optimized' ? 'Optimized for its pool' : 'Portable'}
                    </span>
                  ) : null}
                </td>
                <td className={cx(styles.num, styles.dropXs)}>
                  {b.created
                    ? formatRelativeDay(Date.parse(b.created), now, timeZone, currentLocale())
                    : DASH}
                </td>
                <td className={cx(styles.muted, styles.dropL)}>{expiryText(backupExpiresAt(b), now)}</td>
                <td className={cx(styles.num, styles.dropXl)}>
                  {b.sizeBytes != null ? formatBytesBinary(b.sizeBytes) : DASH}
                </td>
                <td>
                  {who ? (
                    <span className={wi.wiActs}>
                      <button
                        type="button"
                        className={styles.cardLink}
                        style={{ marginLeft: 0 }}
                        onClick={() => setOpen({ b, action: 'restore' })}
                      >
                        Restore as new… <span className={styles.srOnly}>{b.volume}</span>
                      </button>
                      <button
                        type="button"
                        className={`${styles.cardLink} ${wi.wiSerious}`}
                        style={{ marginLeft: 0 }}
                        onClick={() => setOpen({ b, action: 'delete' })}
                      >
                        Delete… <span className={styles.srOnly}>{b.volume}</span>
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && g && open.action === 'restore' ? (
        <IncusRestoreDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          backup={open.b}
          timeZone={timeZone}
          onStarted={onStarted}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open && g && open.action === 'delete' ? (
        <IncusDeleteBackupDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          backup={open.b}
          timeZone={timeZone}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/* Log ---------------------------------------------------------------------------------------------------- */

const LINES = [
  { value: '100', label: '100 lines' },
  { value: String(HOST_LOG_LINES_DEFAULT), label: '500 lines' },
  { value: '2000', label: '2,000 lines' },
];

export function IncusLogTab({
  burrow,
  serverId,
  guest,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
}) {
  const [lines, setLines] = useState(String(HOST_LOG_LINES_DEFAULT));
  const q = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'log.get', guestId: guest.id, platform: 'incus', lines: Number(lines) },
  });
  const data = q.data?.op === 'log.get' ? q.data : null;
  const pre = useRef<HTMLPreElement>(null);
  // The newest lines are at the end: start there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new lines arrive
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [data]);
  return (
    <Card
      title="Log"
      meta={data ? `${data.file} · the last ${plural(data.lines.length, 'line')}` : undefined}
      link={
        <span className={wi.wiToolbar}>
          <SegmentedControl
            options={LINES}
            value={lines}
            onChange={setLines}
            label="How much"
            size="sm"
            variant="soft"
          />
          <Button
            size="sm"
            iconStart={<Icon icon={RefreshCw} size={14} />}
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
            aria-busy={q.isFetching || undefined}
          >
            Refresh
          </Button>
        </span>
      }
    >
      {q.error && !data ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : data ? (
        data.lines.length ? (
          <pre
            ref={pre}
            className={`${styles.code} ${wi.wiLog}`}
            role="log"
            aria-live="off"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls; keyboard users need to reach it
            tabIndex={0}
            aria-label={`${guest.name}’s log`}
          >
            {data.lines.join('\n')}
          </pre>
        ) : (
          <Empty>The log is empty: Incus starts a new one each time {guest.name} starts.</Empty>
        )
      ) : (
        <Empty>Reading the log…</Empty>
      )}
    </Card>
  );
}
