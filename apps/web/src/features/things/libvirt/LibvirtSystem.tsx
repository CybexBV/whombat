/**
 * QEMU/KVM on a server's System tab (Whombat incus-unraid.md IU-13; AP-1659): libvirt's and QEMU's versions, what new
 * VMs can have (UEFI, Secure Boot, a TPM), where VM backups go (and Unraid's VM folders), and libvirt's tasks — the
 * running ones with Stop and the last 48 hours, each opening its log (the task dialog, PX-05).
 */
import {
  formatAgoIso,
  libvirtTaskWord,
  plural,
  TASK_STATUS_WORDS,
  taskStatusTone,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostServerDetail, HostTask } from '@whombat/core/domain';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import { showTask } from '../tasks/taskTracker';
import { libvirtGuests } from './LibvirtBackups';

export function LibvirtActivity({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const lv = detail.libvirt;
  const serverId = detail.server.id;
  const manage = detail.server.remoteControl.manage === true;
  const q = useHostManageRead(
    manage ? { params: { burrow, serverId }, query: { op: 'task.list', platform: 'libvirt' } } : null,
    {
      refetchInterval: (query) =>
        query.state.data?.op === 'task.list' && query.state.data.items.some((t) => t.status === 'running')
          ? 5000
          : false,
    },
  );
  const now = Date.parse(detail.asOf);
  const items = q.data?.op === 'task.list' ? q.data.items : [];
  const guests = libvirtGuests(detail);
  const nameOf = (id: string | null | undefined) =>
    id ? (guests.find((g) => g.id === id)?.name ?? id.replace(/^libvirt:/, '')) : null;
  const open = (t: HostTask) =>
    showTask({
      burrow,
      serverId,
      taskId: t.id,
      platform: 'libvirt',
      op: '',
      what: `${libvirtTaskWord(t.type)}${nameOf(t.guestId) ? ` of ${nameOf(t.guestId)}` : ''}`,
      ...(t.guestId ? { guestId: t.guestId } : {}),
    });
  if (!lv) return null;
  const fw = lv.firmware;
  const can = [fw.uefi ? 'UEFI' : '', fw.secureBoot ? 'Secure Boot' : '', fw.tpm ? 'a TPM 2.0' : ''].filter(
    Boolean,
  );
  const failed = items.filter((t) => t.status === 'error').length;
  return (
    <>
      <Card title="QEMU/KVM">
        <div className={styles.rows}>
          <Fact title="libvirt" value={lv.version} />
          <Fact title="QEMU" value={lv.qemu ?? 'Not reported'} />
          <Fact
            title="New VMs can have"
            value={can.length ? can.join(', ') : 'BIOS only'}
            note={
              !fw.uefi
                ? 'Install ovmf for UEFI (Windows 11 needs it).'
                : !fw.tpm
                  ? 'Install swtpm for a TPM (Windows 11 needs it).'
                  : undefined
            }
          />
          {lv.folders ? (
            <Fact
              title="Unraid’s VM folders"
              value={[lv.folders.domains, lv.folders.isos].filter(Boolean).join(' · ')}
              mono
            />
          ) : null}
          <Fact title="Backups go to" value={lv.backupsDir ?? 'Not set'} mono={!!lv.backupsDir} />
        </div>
      </Card>
      {manage ? (
        <Card
          title="VM tasks"
          meta={failed ? `${plural(failed, 'failed task')} in 48 h` : 'Running ones and the last 48 h'}
        >
          {q.error ? (
            <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
          ) : items.length ? (
            <div className={styles.rows}>
              {items.map((t) => (
                <div key={t.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <b>
                      <button
                        type="button"
                        className={styles.name}
                        style={{ fontFamily: 'var(--font-sans)', fontWeight: 500 }}
                        onClick={() => open(t)}
                      >
                        {libvirtTaskWord(t.type)}
                        {nameOf(t.guestId) ? ` of ${nameOf(t.guestId)}` : ''}
                      </button>
                    </b>
                    <small>
                      <StateCell
                        tone={taskStatusTone(t.status)}
                        text={
                          t.status === 'running'
                            ? `Running since ${formatAgoIso(t.started, now)}`
                            : `${TASK_STATUS_WORDS[t.status]} ${t.ended ? formatAgoIso(t.ended, now) : ''}`.trim()
                        }
                      />
                    </small>
                    {t.message && t.message !== 'OK' ? <small title={t.message}>{t.message}</small> : null}
                  </div>
                  <span className={styles.rowEnd}>{t.user ?? ''}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{q.isLoading ? 'Looking…' : 'No VM tasks in the last 48 hours.'}</Empty>
          )}
        </Card>
      ) : null}
    </>
  );
}

function Fact({ title, value, note, mono }: { title: string; value: string; note?: string; mono?: boolean }) {
  return (
    <div className={styles.row} style={{ flexWrap: 'wrap', rowGap: 2 }}>
      <span className={styles.muted} style={{ flex: '0 1 170px' }}>
        {title}
      </span>
      <div className={styles.rowMain} style={{ minWidth: 160 }}>
        <b
          className={mono ? styles.mono : undefined}
          style={{ overflowWrap: 'anywhere', ...(mono ? { fontSize: 13.5, fontWeight: 400 } : {}) }}
        >
          {value}
        </b>
        {note ? <small>{note}</small> : null}
      </div>
    </div>
  );
}
