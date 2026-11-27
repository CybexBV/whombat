/**
 * Backups as a table (ported from Rackoon's guest `BackupsTab`; PX-01), for a guest's Backups tab and a server's: when
 * it was made, where it is (verified by a Proxmox Backup Server or not), its size and format (encrypted or not), its
 * notes, and Restore… with More: Protect or Unprotect, Edit notes…, Delete… (asked; a protected one is refused).
 */
import { DASH, formatBytesBinary, formatDayTime, guestKind } from '@whombat/client/hosts';
import type { HostBackupVolume } from '@whombat/core/domain';
import { Ellipsis, Lock, Shield } from 'lucide-react';
import { useState } from 'react';
import { useRowMenu } from '../../../app/shell/ContextMenu';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { currentLocale } from '../../../i18n/provider';
import { GuestKindIcon } from '../GuestName';
import { Badge, StateCell } from '../parts';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import {
  BackupNotesDialog,
  backupMade,
  backupWhen,
  DeleteBackupDialog,
  type GuestRef,
  RestoreDialog,
} from './GuestDialogs';
import { useManage } from './useManage';

type Dialog = { kind: 'restore' | 'notes' | 'delete'; backup: HostBackupVolume; guest?: GuestRef } | null;

export function BackupTable({
  burrow,
  serverId,
  items,
  guestOf,
  showGuest = false,
  timeZone,
}: {
  burrow: string;
  serverId: string;
  items: readonly HostBackupVolume[];
  /** The guest a backup belongs to (Restore needs it; a removed guest's backups restore as a new one). */
  guestOf: (b: HostBackupVolume) => GuestRef | undefined;
  showGuest?: boolean;
  timeZone?: string;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const menu = useRowMenu();
  const { send, busy } = useManage(burrow, serverId);
  const now = Date.now();
  const protect = (b: HostBackupVolume) =>
    void send(
      {
        op: 'backup.update',
        params: { platform: 'pve', volume: b.volume, protected: !b.protected },
        name: 'the backup',
        done: b.protected ? 'The backup isn’t protected any more.' : 'The backup is protected.',
      },
      { inline: false },
    );
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            {showGuest ? (
              <th scope="col" className={styles.cellMain}>
                Guest
              </th>
            ) : null}
            <th scope="col" className={showGuest ? styles.dropXs : styles.cellMain}>
              Made
            </th>
            <th scope="col" className={styles.dropM}>
              Storage
            </th>
            <th scope="col" className={styles.dropS}>
              Size
            </th>
            <th scope="col" className={styles.dropL}>
              Format
            </th>
            <th scope="col" className={styles.dropXl}>
              Notes
            </th>
            <th scope="col">
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const g = guestOf(b);
            const when = backupWhen(b, timeZone);
            // A removed guest's backup restores as a new guest.
            const target: GuestRef = g ?? {
              id: `pve:${b.guest ?? ''}`,
              name: `${b.kind === 'vm' ? 'VM' : 'CT'} ${b.guest ?? ''}`.trim(),
              kind: b.kind ?? 'vm',
              state: 'stopped',
              ...(b.guest ? { vmid: Number(b.guest) } : {}),
            };
            return (
              <tr key={b.volume}>
                {showGuest ? (
                  <td className={styles.cellMain}>
                    <span className={styles.cellLine}>
                      <GuestKindIcon
                        kind={guestKind({
                          platform: 'pve',
                          kind: b.kind ?? 'vm',
                          vmid: b.guest ? Number(b.guest) : undefined,
                        })}
                      />
                      <span className={cx(styles.mono, styles.ellipsis)}>{g?.name ?? b.guest ?? DASH}</span>
                      {b.guest ? <span className={styles.gId}>{b.guest}</span> : null}
                    </span>
                  </td>
                ) : null}
                <td className={cx(styles.num, showGuest ? styles.dropXs : styles.cellMain)}>
                  <span
                    className={wb.wbCell}
                    title={
                      b.created ? formatDayTime(Date.parse(b.created), timeZone, currentLocale()) : undefined
                    }
                  >
                    {backupMade(b, now, timeZone) || DASH}
                    {b.protected ? (
                      <span role="img" aria-label="Protected" title="Protected">
                        <Icon icon={Shield} size={13} />
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={styles.dropM}>
                  <span className={wb.wbCell}>
                    <span className={styles.mono}>{b.storage}</span>
                    {b.verified === 'ok' ? <StateCell tone="ok" text="verified" /> : null}
                    {b.verified === 'failed' ? <Badge tone="bad">check failed</Badge> : null}
                  </span>
                </td>
                <td className={cx(styles.num, styles.dropS)}>
                  {b.sizeBytes != null ? formatBytesBinary(b.sizeBytes) : DASH}
                </td>
                <td className={cx(styles.kind, styles.dropL)}>
                  <span className={wb.wbCell}>
                    {b.format ?? DASH}
                    {b.encrypted ? (
                      <span role="img" aria-label="Encrypted" title="Encrypted">
                        <Icon icon={Lock} size={12} />
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={cx(styles.muted, wb.wbTd, styles.dropXl)}>{b.notes || ''}</td>
                <td>
                  <span className={wb.wbTools}>
                    <button
                      type="button"
                      className={styles.cardLink}
                      onClick={() => setDialog({ kind: 'restore', backup: b, guest: target })}
                    >
                      Restore…<span className={styles.srOnly}> the backup of {when}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`More for the backup of ${when}`}
                      aria-haspopup="menu"
                      disabled={busy}
                      onClick={(e) =>
                        menu.openFrom(
                          e.currentTarget,
                          `backup:${b.volume}`,
                          `The backup of ${when}`,
                          [
                            { label: b.protected ? 'Unprotect' : 'Protect', onSelect: () => protect(b) },
                            { label: 'Edit notes…', onSelect: () => setDialog({ kind: 'notes', backup: b }) },
                            {
                              label: 'Delete…',
                              danger: true,
                              separated: true,
                              ...(b.protected ? { description: 'It’s protected' } : {}),
                              onSelect: () => setDialog({ kind: 'delete', backup: b }),
                            },
                          ],
                          'end',
                        )
                      }
                    >
                      <Icon icon={Ellipsis} size={15} />
                    </button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {menu.element}
      {dialog?.kind === 'restore' && dialog.guest ? (
        <RestoreDialog
          burrow={burrow}
          serverId={serverId}
          guest={dialog.guest}
          backup={dialog.backup}
          newOnly={!guestOf(dialog.backup)}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'notes' ? (
        <BackupNotesDialog
          burrow={burrow}
          serverId={serverId}
          backup={dialog.backup}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteBackupDialog
          burrow={burrow}
          serverId={serverId}
          backup={dialog.backup}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
