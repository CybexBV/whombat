/**
 * An Incus server's Backups (Whombat incus-unraid.md IU-04, IU-08; AP-1577): the instances that have no snapshots on a
 * schedule and no recent backup (the hub's `incus.no_snapshots`, each with Set a schedule and Back up now), every
 * instance with its newest backup and Back up now, then every backup on the server, newest first, each restorable as
 * a new instance and deletable. Incus keeps backups on the server until they expire (scheduled backups stay a snapshot
 * schedule, IU-10).
 */
import {
  DASH,
  formatRelativeDay,
  incusGuests,
  incusHintFixes,
  incusRef,
  plural,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupVolume, HostGuest, HostServerDetail } from '@whombat/core/domain';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { GuestName } from '../GuestName';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { IncusBackupDialog } from './IncusDialogs';
import { IncusBackupTable } from './IncusGuestTabs';
import { useIncusCanChange } from './IncusStorage';

/** Which guest a backup belongs to (`guest` is its id, or its name on an older hub). */
function ownerOf(b: HostBackupVolume, guests: readonly HostGuest[]): HostGuest | undefined {
  return guests.find((g) => b.guest === g.id || b.guest === g.name || b.guest === incusRef(g.id).name);
}

export function IncusBackupsTab({
  burrow,
  serverId,
  detail,
  timeZone,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone?: string;
}) {
  const [, set] = useThingSearch();
  const canChange = useIncusCanChange(burrow, detail);
  const [backup, setBackup] = useState<HostGuest | null>(null);
  const list = useHostManageRead(
    canChange || detail.server.remoteControl.manage
      ? { params: { burrow, serverId }, query: { op: 'backup.list', platform: 'incus' } }
      : null,
  );
  const guests = incusGuests(detail);
  const items =
    list.data?.op === 'backup.list'
      ? [...list.data.items].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      : [];
  const now = Date.parse(detail.asOf);
  const unsafe = detail.hints
    .filter((h) => h.kind === 'incus.no_snapshots')
    .flatMap((h) => incusHintFixes(h, guests) ?? [])
    .flatMap((f) => (f.kind === 'guest' ? guests.filter((g) => g.id === f.guestId) : []));
  if (!detail.server.remoteControl.manage)
    return (
      <Card title="Backups">
        <Empty>Changing guests is switched off for this server, so its backups aren’t listed.</Empty>
      </Card>
    );
  return (
    <>
      {unsafe.length ? (
        <Card
          title="Not covered"
          meta="No snapshot schedule and no backup in 30 days: a broken disk loses them"
        >
          {unsafe.map((g) => (
            <div key={g.id} className={wi.wiNoteRow}>
              <Icon icon={AlertTriangle} size={16} />
              <span>
                <b className={styles.mono} style={{ fontWeight: 500 }}>
                  {g.name}
                </b>
              </span>
              <Button size="sm" onClick={() => set({ guest: g.id, gtab: 'snapshots' })}>
                Set a schedule
              </Button>
              {canChange ? (
                <Button size="sm" onClick={() => setBackup(g)}>
                  Back up now
                </Button>
              ) : null}
            </div>
          ))}
        </Card>
      ) : null}
      <Card title="Instances" meta={`${guests.length} on this server`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Instance
              </th>
              <th scope="col" className={styles.dropXs}>
                Newest backup
              </th>
              <th scope="col" className={styles.dropM}>
                Backups
              </th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => {
              const mine = items.filter((b) => ownerOf(b, guests)?.id === g.id);
              const newest = mine[0]?.created;
              return (
                <tr key={g.id}>
                  <td className={styles.cellMain}>
                    <GuestName guest={g} onOpen={() => set({ guest: g.id, gtab: 'backups' })} />
                  </td>
                  <td className={cx(styles.num, styles.dropXs)}>
                    {newest ? (
                      formatRelativeDay(Date.parse(newest), now, timeZone)
                    ) : list.isLoading ? (
                      DASH
                    ) : (
                      <StateCell tone="mut" text="None yet" />
                    )}
                  </td>
                  <td className={cx(styles.num, styles.dropM)}>{mine.length || DASH}</td>
                  <td>
                    {canChange ? (
                      <button
                        type="button"
                        className={styles.cardLink}
                        style={{ marginLeft: 0 }}
                        onClick={() => setBackup(g)}
                      >
                        Back up now <span className={styles.srOnly}>{g.name}</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card title="Backups" meta={items.length ? plural(items.length, 'backup') : undefined}>
        {list.error ? (
          <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length ? (
          <IncusBackupTable
            burrow={burrow}
            serverId={serverId}
            items={items}
            guestOf={(b) => ownerOf(b, guests)}
            showGuest
            timeZone={timeZone}
          />
        ) : (
          <Empty>{list.isLoading ? 'Looking…' : 'No backups on this server yet.'}</Empty>
        )}
      </Card>
      {backup ? (
        <IncusBackupDialog
          burrow={burrow}
          serverId={serverId}
          guest={backup}
          onClose={() => setBackup(null)}
        />
      ) : null}
    </>
  );
}
